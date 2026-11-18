/**
 * DSH 插件入口：magpie 原版 Web UI 面板 + CLI 工具层。
 *
 * ## 这个插件不注册 provider
 *
 * DSH 接入 magpie 的模型已由 magpie 自己完成（`internal/agent/dsh.go`：
 * `magpie dsh <model>` 往 `~/.dsh/profiles/<name>/cordis.patch.yml` 写
 * `llm-pi-ai` 条目，带 `# magpie` 标记）。插件重复注册只会让模型选择器
 * 出现两份同样的模型。
 *
 * ## 形状
 *
 * cordis 插件是四个具名导出（`name` / `inject` / `Config` / `apply`），
 * **没有 default**——default 会让 Loader 拿不到本模块的具名导出而静默失效。
 *
 * @module dsh-magpie-bridge
 */
import { resolveOptions, Config, type MagpieOptions } from './config.js'
import { describeSource, resolveMagpieBinary } from './binary.js'
import { ensureMagpieBinary } from './download.js'
import { registerMagpieTools } from './tools.js'
import { dockWindowUrl, MagpieWebBridge } from './web-bridge.js'

export { Config }

/** cordis 条目 id。必须与 package.json 的 name 及 cordis.patch.yml 的 name 一致。 */
export const name = 'magpie-bridge'

/**
 * 静态依赖：空。
 *
 * 不列 `connection`（只由 Web bundle 提供，headless/CLI profile 里不存在，
 * 静态列会让插件永久 pending）；面板通道用 `ctx.inject([...])` 运行时取。
 */
export const inject: readonly string[] = []

/** 面板 RPC 通道（绝对路径；客户端 `connection.rpc.call` 会 POST `<channel>/<endpoint>`）。 */
export const PANEL_CHANNEL = '/api/magpie-bridge'

/** 面板方法结果信封（error.details 由连接层要求，宿主注册时补齐）。 */
export type PanelResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: object } }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 薄 logger：cordis 的 ctx.logger 是可选服务，缺方法就静默丢弃。 */
function makeLogger(ctx: unknown): { debug(message: string): void; warn(message: string): void } {
  const raw = (ctx as { logger?: { debug?: (m: string) => void; warn?: (m: string) => void } }).logger
  return {
    debug: (message) => raw?.debug?.(message),
    warn: (message) => raw?.warn?.(message),
  }
}

/**
 * 面板方法分发（供测试直接调用）。
 *
 * 每个分支都必须返回 `{ ok: true, value }` / `{ ok: false, error }` 信封——
 * 这是 `connection.rpc.call()` 的返回值契约，客户端只认这个形状。
 */
export function createPanelHandler(
  options: MagpieOptions,
  getBridge: () => Promise<MagpieWebBridge>,
): (method: string) => Promise<PanelResult> {
  return async (method: string): Promise<PanelResult> => {
    switch (method) {
      case 'web.url':
      case 'web.dockUrl': {
        if (!options.webEnabled) {
          return {
            ok: false,
            error: {
              code: 'magpie/web-disabled',
              message: '原版 Web UI 已在设置里关闭（webEnabled: false）。',
            },
          }
        }
        try {
          const handle = await (await getBridge()).ensure()
          if (method === 'web.url') {
            return { ok: true, value: { url: handle.url, port: handle.port } }
          }
          return { ok: true, value: { url: dockWindowUrl(options.webHost, handle.port) } }
        } catch (error) {
          return {
            ok: false,
            error: { code: 'magpie/web-unavailable', message: messageOf(error) },
          }
        }
      }
      default:
        return {
          ok: false,
          error: { code: 'magpie/unknown-method', message: `未知方法：${method}` },
        }
    }
  }
}

/** 失败结果补一个空 details（连接层要求 error.details 是对象）。 */
function withDetails(result: PanelResult): PanelResult {
  return result.ok === false ? { ...result, error: { ...result.error, details: {} } } : result
}

/**
 * 注册面板 RPC 通道（走 `connection.rpc.handle`）。
 *
 * 客户端调用 `connection.rpc.call('/api/magpie-bridge', 'web.url', payload)`，
 * 连接层负责鉴权、rpcId 与响应信封；宿主只收 `(endpoint, payload)` 并返回
 * `{ ok, value | error }`。
 */
function registerPanelRpc(
  ctx: unknown,
  options: MagpieOptions,
  logger: { debug(message: string): void; warn(message: string): void },
  getBridge: () => Promise<MagpieWebBridge>,
): void {
  const rpc = (
    ctx as {
      connection?: {
        rpc?: {
          handle?: (channel: string, handler: (endpoint: string, payload: unknown) => Promise<PanelResult>) => unknown
        }
      }
    }
  ).connection?.rpc
  if (typeof rpc?.handle !== 'function') {
    logger.debug('[magpie] connection.rpc 不可用，面板 RPC 未注册')
    return
  }

  const handler = createPanelHandler(options, getBridge)
  try {
    rpc.handle(PANEL_CHANNEL, async (endpoint: string) => withDetails(await handler(endpoint)))
  } catch (error) {
    logger.warn(`[magpie] 注册面板 RPC 失败：${messageOf(error)}`)
  }
}

/** 插件激活入口。同步返回；所有 I/O 后台化。 */
export function apply(ctx: unknown, config?: unknown): void {
  const options = resolveOptions(config)
  const logger = makeLogger(ctx)
  const context = ctx as {
    effect?: (disposer: () => void) => unknown
    inject?: (services: readonly string[], callback: (scoped: unknown) => void) => unknown
    tools?: { register: (...args: never[]) => unknown }
    logger?: unknown
  }

  const lifecycle = new AbortController()
  let bridgeInstance: MagpieWebBridge | undefined
  let bridgePromise: Promise<MagpieWebBridge> | undefined

  /** 每次 await 后确认插件还活着（卸载是同步的，可能发生在任意两次 await 之间）。 */
  const assertAlive = (): void => {
    if (lifecycle.signal.aborted) throw new Error('插件已卸载')
  }

  /** 解析二进制路径；缺失且允许时后台下载。 */
  const resolveBinaryPath = async (): Promise<string | undefined> => {
    assertAlive()
    let binary = await resolveMagpieBinary(options.magpieBinary)
    assertAlive()
    if (binary === undefined && options.autoDownloadMagpie) {
      logger.debug('[magpie] 未找到 magpie 二进制，自动下载中（首次约 69 MB）…')
      try {
        await ensureMagpieBinary({ logger, signal: lifecycle.signal })
        binary = await resolveMagpieBinary(options.magpieBinary)
        assertAlive()
      } catch (error) {
        if (lifecycle.signal.aborted) throw error
        logger.warn(`[magpie] 自动下载 magpie 失败：${messageOf(error)}`)
      }
    }
    if (binary !== undefined) {
      logger.debug(`[magpie] 使用 magpie 二进制：${binary.path}（${describeSource(binary.source)}）`)
    }
    return binary?.path
  }

  /** 取（并首次创建）Web 桥；缓存 Promise，失败清缓存以便重试。 */
  const getBridge = async (): Promise<MagpieWebBridge> => {
    if (bridgePromise !== undefined) return bridgePromise
    bridgePromise = (async () => {
      assertAlive()
      const binary = await resolveBinaryPath()
      assertAlive()
      const bridge = new MagpieWebBridge({
        binary,
        key: options.webKey,
        host: options.webHost,
        preferredPort: options.webPort,
        proxyPort: options.proxyPort,
        gatewayURL: options.baseURL,
        logger,
      })
      bridgeInstance = bridge
      if (lifecycle.signal.aborted) {
        bridge.dispose()
        throw new Error('插件已卸载')
      }
      return bridge
    })().catch((error: unknown) => {
      bridgePromise = undefined
      throw error
    })
    return bridgePromise
  }

  // 卸载：先中断下载，再关桥（杀子进程、关代理）。
  context.effect?.(() => () => {
    lifecycle.abort()
    bridgeInstance?.dispose()
  })

  // 自动拉起网关：插件提供的是模型，不只是面板——用户第一件事往往是发消息。
  // 后台跑，失败只 warn（网关跑在别处时不应让插件失效）。
  if (options.autoStartGateway) {
    void getBridge().then(
      (bridge) => {
        if (lifecycle.signal.aborted) return
        return bridge.ensure().then(
          (handle) => {
            logger.debug(`[magpie] 网关已就绪：${options.baseURL}（Web UI 代理 ${handle.url}）`)
          },
          (error: unknown) => {
            logger.warn(
              `[magpie] 自动启动网关失败：${messageOf(error)}；如果网关跑在别处，把 autoStartGateway 关掉即可`,
            )
          },
        )
      },
      (error: unknown) => {
        logger.warn(`[magpie] 准备 magpie 二进制失败：${messageOf(error)}`)
      },
    )
  }

  if (context.tools?.register !== undefined) {
    registerMagpieTools(context, { options, resolveBinary: resolveBinaryPath })
  }

  // 面板通道只在有 connection 的 profile 里注册（Web profile）。
  context.inject?.(['connection'], (connectionCtx: unknown) => {
    registerPanelRpc(connectionCtx, options, logger, getBridge)
  })
}
