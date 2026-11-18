/**
 * magpie 原版 Web UI 的进程桥 + 认证代理。
 *
 * ## 为什么需要代理
 *
 * `magpie web` 用 cookie 认证；而 DSH 自己的启动 cookie 会把 `127.0.0.1`
 * 的 cookie 配额（~16 KB）占满，浏览器随即驱逐 magpie 的 cookie，iframe 永远
 * 登录不上。所以本桥起一个**常驻**反向代理：由它在每个转发请求上注入
 * `Cookie`，并剥离上游 `Set-Cookie`——浏览器侧不保存任何 cookie。
 *
 * ## 生命周期
 *
 * `magpie serve --web=<host>:<port>` 一个进程同时提供网关与 Web UI。
 * 代理端口固定、整个桥生命周期只 `listen` 一次；magpie 重启（自我更新、崩溃）
 * 只切换上游，iframe 的 `src` 永不变，重启期间回 503 自恢复页。
 *
 * 设计蓝本：Betsy20/dsh-magpie（MIT，见 NOTICE）。
 * @module dsh-magpie-bridge/web-bridge
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

import { probeGateway } from './gateway.js'

/** stdout 里启动完成的标志行。 */
export const READY_PATTERN = /magpie web on (https?:\/\/\S+)/u

/** 启动超时（magpie 首次要加载插件，30s 是宽松上界）。 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

/** 端口探测的默认尝试次数。 */
const DEFAULT_PORT_ATTEMPTS = 24

/** 真正 listen 时撞上 EADDRINUSE 的最多重试次数（TOCTOU 窗口）。 */
const PORT_RETRY_ATTEMPTS = 5

/** 连续自动重启上限；超过后停止，把错误留在日志里。 */
export const MAX_AUTO_RESTARTS = 5

/** 子进程稳定运行多久才算「这次启动真的成功」（之后清零退避计数）。 */
export const STABLE_AFTER_MS = 60_000

/** Windows `taskkill` 兜底超时。 */
const TASKKILL_TIMEOUT_MS = 5_000

/** 代理默认端口（配置默认 3591；避开 magpie 自己扫描的 3480–3503）。 */
export const DEFAULT_PROXY_PORT = 3591

/** 代理转发时必须丢弃的请求头（hop-by-hop + 需要重算的）。 */
export const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
])

/**
 * 代理转发时必须丢弃的响应头。
 *
 * `set-cookie` 是核心：cookie 由代理在服务端注入，浏览器不该保存。
 * CSP / X-Frame-Options 必须剥掉，否则 `frame-ancestors 'self'` 会拒绝跨源 iframe。
 * **不能**丢 `content-encoding` / `content-length`（HTML 改写时单独处理）。
 */
export const DROPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'connection',
  'content-security-policy',
  'content-security-policy-report-only',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-frame-options',
])

/** 桥构造参数。 */
export interface MagpieWebBridgeOptions {
  /** 已解析的 magpie 可执行文件绝对路径；undefined 表示没找到。 */
  readonly binary: string | undefined
  /** 固定的 MAGPIE_WEB_KEY。 */
  readonly key: string
  /** 监听地址（配置值，可能为通配）。 */
  readonly host: string
  /** Web UI 首选端口；被占用时向后找。 */
  readonly preferredPort: number
  /** 代理端口（固定，iframe 直接加载）。 */
  readonly proxyPort?: number
  /** 启动超时（毫秒）。 */
  readonly startupTimeoutMs?: number
  /** 网关根地址，仅用于启动前的诊断日志。 */
  readonly gatewayURL?: string
  /** 日志。 */
  readonly logger: { debug(message: string): void; warn(message: string): void }
}

/** 已就绪的 Web 服务句柄。 */
export interface MagpieWebHandle {
  /** 代理完整 URL，可直接给 iframe 的 src（认证由代理注入，不含 ?k=）。 */
  readonly url: string
  /** 代理端口。 */
  readonly port: number
  /** magpie web 自己的端口（调试用）。 */
  readonly upstreamPort: number
  /** 子进程 PID。 */
  readonly pid: number | undefined
}

/** 代理背后的上游；undefined 表示 magpie 正在重启（此时回 503）。 */
interface ProxyUpstream {
  readonly host: string
  readonly port: number
  readonly cookie: string
}

/** 第 attempt 次自动重启前的等待毫秒：1s → 2s → 4s → 8s → 15s（封顶）。 */
export function restartDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** (Math.max(1, attempt) - 1), 15_000)
}

/** 把绑定地址转成可建连地址（通配 → 回环）。 */
function connectHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed === '' || trimmed === '0.0.0.0') return '127.0.0.1'
  if (trimmed === '::' || trimmed === '[::]' || trimmed === '[::1]') return '::1'
  return trimmed
}

/** 可建连地址 → 能放进 URL 的主机段（IPv6 加方括号）。 */
function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** 主窗口 URL（`/`，完整页面）。 */
export function mainWindowUrl(host: string, port: number): string {
  return `http://${urlHost(connectHost(host))}:${String(port)}/`
}

/** 小窗 URL（`/?mode=panel`，magpie 托盘同款的紧凑形态）。 */
export function dockWindowUrl(host: string, port: number): string {
  return `http://${urlHost(connectHost(host))}:${String(port)}/?mode=panel`
}

/** 探测空闲端口：bind 成功即关闭，从 preferred 起逐个试。 */
export async function findFreePort(host: string, preferred: number, attempts: number): Promise<number> {
  if (!Number.isInteger(preferred) || preferred < 1) {
    throw new Error(`无效的起始端口：${String(preferred)}（必须 ≥ 1）`)
  }
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset
    if (port > 65_535) break
    const free = await new Promise<boolean>((resolve) => {
      const server = createNetServer()
      const onError = (): void => {
        server.off('listening', onListening)
        resolve(false)
      }
      const onListening = (): void => {
        server.off('error', onError)
        server.close(() => resolve(true))
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
    if (free) return port
  }
  throw new Error(`端口 ${String(preferred)}–${String(preferred + attempts - 1)} 全部被占用`)
}

function toHeaderList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** 解码响应体（gzip/br/deflate）；未知编码抛错。 */
function decodeBody(raw: Buffer, encoding: string): Buffer {
  if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(raw)
  if (encoding === 'br') return brotliDecompressSync(raw)
  if (encoding === 'deflate') return inflateSync(raw)
  throw new Error(`不支持的 content-encoding: ${encoding}`)
}

/** 登录 magpie web：GET /?k=<key>（manual redirect），取 Set-Cookie 首段。 */
async function login(baseUrl: string, key: string, timeoutMs: number): Promise<string> {
  const response = await fetch(`${baseUrl}/?k=${encodeURIComponent(key)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const cookies = response.headers.getSetCookie?.() ?? []
  const raw = cookies.length > 0 ? cookies[0] : response.headers.get('set-cookie')
  if (raw === null || raw === undefined || raw.length === 0) {
    throw new Error(`magpie web 登录失败（HTTP ${String(response.status)}，没有 Set-Cookie）`)
  }
  const first = raw.split(';')[0]
  if (first === undefined || !first.includes('=')) {
    throw new Error(`magpie web 返回了无法解析的 Set-Cookie：${raw.slice(0, 120)}`)
  }
  return first.trim()
}

/** 停掉子进程（Windows 连进程树）。 */
function stopProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return

  const fallback = (): void => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出 */
    }
  }

  if (process.platform !== 'win32') {
    try {
      child.kill('SIGTERM')
    } catch {
      return
    }
    const timer = setTimeout(fallback, 2_000)
    timer.unref()
    child.once('exit', () => clearTimeout(timer))
    return
  }

  // Windows：magpie 可能派生孙进程，只 kill 直接子进程会留下占端口的孤儿。
  // 用绝对路径调 taskkill，避免 PATH 里的同名文件被优先执行（二进制种植面）。
  const systemRoot = process.env['SystemRoot']
  const taskkillPath =
    systemRoot !== undefined && systemRoot !== ''
      ? join(systemRoot, 'System32', 'taskkill.exe')
      : 'taskkill.exe'

  let settled = false
  const settle = (): void => {
    settled = true
    clearTimeout(timeout)
  }
  const timeout = setTimeout(() => {
    if (settled) return
    settle()
    fallback()
  }, TASKKILL_TIMEOUT_MS)
  timeout.unref?.()

  try {
    const killer = spawn(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.unref?.()
    killer.once('error', () => {
      if (settled) return
      settle()
      fallback()
    })
    killer.once('close', (code) => {
      if (settled) return
      settle()
      if (code !== 0) fallback()
    })
  } catch {
    settle()
    fallback()
  }
}

/** PID 是否还活着（EPERM 视为活着）。 */
function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * magpie 重启期间代理回给 iframe 的等待页：自动退避重载，起来后无感接上。
 * 计数存 sessionStorage（每次 reload 都会重执行脚本，内存计数会变成死循环）。
 */
const RESTARTING_PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>magpie 正在重启…</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 0.75rem;
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 2rem; text-align: center; }
  p { margin: 0; }
  #hint { opacity: 0.6; font-size: 12px; }
</style>
<p>magpie 正在重启，请稍候…</p>
<p id="hint"></p>
<script>
  (function () {
    var KEY = 'magpie.restart.attempts';
    var WINDOW_MS = 5 * 60 * 1000;
    var MAX_ATTEMPTS = 30;
    var hint = document.getElementById('hint');
    var now = Date.now();
    var count = 0;
    try {
      var saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (saved && typeof saved.count === 'number' && now - saved.at < WINDOW_MS) count = saved.count;
    } catch (e) {}
    count += 1;
    try { sessionStorage.setItem(KEY, JSON.stringify({ count: count, at: now })); } catch (e) {}
    if (count > MAX_ATTEMPTS) {
      hint.textContent = '自动重试已停止 —— 请手动刷新页面，或重开面板。';
      return;
    }
    var delay = Math.min(300 * Math.pow(2, count - 1), 5000);
    hint.textContent = '第 ' + count + ' 次重试（约 ' + Math.round(delay) + ' ms 后）…';
    setTimeout(function () { location.reload(); }, delay);
  })();
</script>
`

/**
 * 注入到 magpie 页面里的桥接脚本。
 *
 * - hook `window.fetch`：`/api/window/*` 是 Wails 桌面私有通道，浏览器里不存在，
 *   转成 postMessage 交给 DSH 宿主（打开主面板 / 设置 / 关小窗）。
 * - 非 panel 模式接收宿主的「切到某页」指令，点击对应的导航按钮。
 */
const INJECTED_HTML_SCRIPT = `<script>
(function () {
  if (window.__magpieDshBridge) return;
  window.__magpieDshBridge = true;
  var isPanel = new URLSearchParams(location.search).get("mode") === "panel";
  var parentOrigin = "*";
  try {
    if (document.referrer) parentOrigin = new URL(document.referrer).origin;
  } catch (e) {}

  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var prefix = "/api/window/";
    var at = url.indexOf(prefix);
    if (at < 0) return originalFetch.apply(window, arguments);
    var rest = url.slice(at + prefix.length);
    var q = rest.indexOf("?");
    var action = q >= 0 ? rest.slice(0, q) : rest;
    var params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : "");
    try {
      window.parent.postMessage({
        source: "dsh-magpie",
        kind: action,
        view: params.get("view") || "",
        tab: params.get("tab") || ""
      }, parentOrigin);
    } catch (e) {}
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  if (!isPanel) {
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || typeof data !== "object" || data.source !== "dsh-magpie-host") return;
      if (data.kind !== "show") return;
      var view = String(data.view || "");
      if (!/^[a-z0-9-]+$/.test(view)) return;
      if (view === "settings") {
        var prefs = document.querySelector("#prefs");
        if (prefs) prefs.click();
        return;
      }
      var escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(view) : view;
      var tab = document.querySelector('#nav button[data-view="' + escaped + '"]');
      if (tab) tab.click();
    });
  }
})();
</script>`

/** 让 server listen 一次并把成功/失败包装成 Promise（两个监听都摘掉）。 */
async function listenOnce(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.off('error', onStartupError)
      resolve()
    }
    const onStartupError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    server.once('error', onStartupError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/** 起常驻代理：请求注入 cookie 转发给上游；上游为空时回 503 自恢复页。 */
async function startProxy(
  getUpstream: () => ProxyUpstream | undefined,
  listenHost: string,
  logger: { debug(message: string): void; warn(message: string): void },
  preferredPort: number,
): Promise<{ server: Server; port: number }> {
  const server = createHttpServer((request, response) => {
    const target = getUpstream()
    if (target === undefined) {
      response.writeHead(503, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '1',
      })
      response.end(RESTARTING_PAGE)
      return
    }

    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue
      headers[name] = value
    }
    headers['host'] = `${target.host}:${String(target.port)}`
    headers['cookie'] = target.cookie

    const upstream = httpRequest(
      {
        host: target.host,
        port: target.port,
        path: request.url ?? '/',
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue
          responseHeaders[name] = value
        }

        const contentType = responseHeaders['content-type']
        const isHtml =
          typeof contentType === 'string' && contentType.toLowerCase().includes('text/html')

        if (isHtml) {
          const chunks: Buffer[] = []
          upstreamResponse.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })
          response.once('close', () => {
            if (!response.writableEnded) {
              upstreamResponse.destroy()
              upstream.destroy()
            }
          })
          upstreamResponse.once('error', () => {
            if (!response.destroyed) {
              response.writeHead(502)
              response.end('magpie web 上游错误')
            }
          })
          upstreamResponse.once('end', () => {
            if (response.destroyed) return
            let raw = Buffer.concat(chunks)
            const encoding = responseHeaders['content-encoding']
            const algorithm = typeof encoding === 'string' ? encoding.toLowerCase().trim() : ''
            let injectable = false
            if (algorithm === '') {
              injectable = true
            } else if (algorithm === 'gzip' || algorithm === 'x-gzip' || algorithm === 'br' || algorithm === 'deflate') {
              try {
                raw = decodeBody(raw, algorithm)
                delete responseHeaders['content-encoding']
                injectable = true
              } catch (error) {
                logger.warn(
                  `[magpie] 解压 HTML 失败（${algorithm}）：${error instanceof Error ? error.message : String(error)}`,
                )
              }
            }
            if (injectable) {
              const text = raw.toString('utf8')
              const index = text.toLowerCase().lastIndexOf('</body>')
              const next = index >= 0 ? `${text.slice(0, index)}${INJECTED_HTML_SCRIPT}${text.slice(index)}` : `${text}${INJECTED_HTML_SCRIPT}`
              raw = Buffer.from(next, 'utf8')
              responseHeaders['content-length'] = String(raw.length)
            }
            response.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders)
            response.end(raw)
          })
          return
        }

        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.pipe(response)
        upstreamResponse.once('error', () => response.destroy())
      },
    )

    upstream.once('error', () => {
      if (!response.destroyed) {
        response.writeHead(502)
        response.end('magpie web 无响应')
      }
    })
    upstream.end()
  })

  // WebSocket 升级：手工拼 101 响应行后双向 pipe（magpie 的实时通道）。
  server.on('upgrade', (request, socket, head) => {
    const target = getUpstream()
    if (target === undefined) {
      socket.destroy()
      return
    }
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue
      headers[name] = value
    }
    headers['host'] = `${target.host}:${String(target.port)}`
    headers['cookie'] = target.cookie

    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      path: request.url ?? '/',
      method: request.method ?? 'GET',
      headers,
    })
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = [
        `HTTP/1.1 ${String(upstreamResponse.statusCode ?? 101)} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`,
      ]
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue
        for (const item of toHeaderList(value)) lines.push(`${name}: ${item}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(Buffer.from(upstreamHead))
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      upstreamSocket.once('error', () => socket.destroy())
      socket.once('error', () => upstreamSocket.destroy())
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  // 固定端口（被占则递增）；不能用 listen(0)——iframe 的 src 不能变。
  const startPort = await findFreePort(listenHost, preferredPort, DEFAULT_PORT_ATTEMPTS)
  let port = startPort
  for (let attempt = 0; ; attempt += 1) {
    try {
      await listenOnce(server, port, listenHost)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= PORT_RETRY_ATTEMPTS || code !== 'EADDRINUSE') throw error
      port += 1
      logger.debug(`[magpie] 代理端口 ${String(port - 1)} 被抢走，改用 ${String(port)}`)
    }
  }

  server.on('error', (error: Error) => {
    logger.warn(`[magpie] 代理服务器错误：${error.message}`)
  })
  logger.debug(`[magpie] 代理监听 ${listenHost}:${String(port)}`)
  return { server, port }
}

/** `magpie serve --web` 子进程 + 常驻认证代理的管理器。 */
export class MagpieWebBridge {
  private handle: MagpieWebHandle | undefined
  private starting: Promise<MagpieWebHandle> | undefined
  private child: ChildProcess | undefined
  private proxy: Server | undefined
  private proxyPort: number | undefined
  private proxyStarting: Promise<{ server: Server; port: number }> | undefined
  private upstream: ProxyUpstream | undefined
  private disposed = false
  private generation = 0
  private restartAttempts = 0
  private restartTimer: NodeJS.Timeout | undefined
  private stableTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: MagpieWebBridgeOptions) {}

  /** 确保 magpie web 与代理在跑；幂等，并发共享同一启动 Promise。 */
  async ensure(): Promise<MagpieWebHandle> {
    if (this.disposed) throw new Error('Web 桥已卸载')
    if (this.starting !== undefined) return this.starting
    if (this.handle !== undefined && isProcessAlive(this.handle.pid)) return this.handle
    this.discardHandle()
    this.starting = this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /** 停掉子进程与代理（同步、不抛错）。 */
  dispose(): void {
    this.disposed = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.clearStableTimer()
    this.closeProxy()
    const child = this.child
    this.child = undefined
    this.handle = undefined
    this.upstream = undefined
    if (child !== undefined) stopProcessTree(child)
  }

  private discardHandle(): void {
    this.upstream = undefined
    this.child = undefined
    this.handle = undefined
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer)
      this.stableTimer = undefined
    }
  }

  private markStable(): void {
    this.clearStableTimer()
    const timer = setTimeout(() => {
      this.stableTimer = undefined
      this.restartAttempts = 0
    }, STABLE_AFTER_MS)
    timer.unref?.()
    this.stableTimer = timer
  }

  /** 安排一次自动重启（指数退避；启动即失败也走这里）。 */
  private scheduleRestart(reason: string): void {
    if (this.disposed) return
    this.restartAttempts += 1
    const attempt = this.restartAttempts
    if (attempt > MAX_AUTO_RESTARTS) {
      this.options.logger.warn(
        `[magpie] 连续重启 ${String(this.restartAttempts - 1)} 次仍失败，停止自动重启（手动打开面板或重启 DSH 后再试）`,
      )
      return
    }
    const delay = restartDelay(attempt)
    this.options.logger.warn(`[magpie] ${reason}，${String(delay)}ms 后第 ${String(attempt)} 次自动重启`)
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const timer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.disposed) return
      void this.ensure().catch((error: unknown) => {
        this.options.logger.warn(
          `[magpie] 自动重启失败：${error instanceof Error ? error.message : String(error)}`,
        )
        this.scheduleRestart('自动重启失败')
      })
    }, delay)
    timer.unref?.()
    this.restartTimer = timer
  }

  private closeProxy(): void {
    const proxy = this.proxy
    this.proxy = undefined
    this.proxyPort = undefined
    this.proxyStarting = undefined
    if (proxy === undefined) return
    try {
      proxy.closeAllConnections?.()
    } catch (error) {
      this.options.logger.warn(
        `[magpie] 断开代理连接失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    try {
      proxy.close()
    } catch (error) {
      this.options.logger.warn(
        `[magpie] 关闭代理失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 确保代理在跑（整个桥生命周期只 listen 一次）。 */
  private async ensureProxy(): Promise<{ server: Server; port: number }> {
    if (this.proxy !== undefined && this.proxyPort !== undefined) {
      return { server: this.proxy, port: this.proxyPort }
    }
    if (this.proxyStarting !== undefined) return this.proxyStarting

    const logger = this.options.logger
    this.proxyStarting = startProxy(
      () => this.upstream,
      '127.0.0.1',
      logger,
      this.options.proxyPort ?? DEFAULT_PROXY_PORT,
    )
      .then(({ server, port }) => {
        if (this.disposed) {
          try {
            server.closeAllConnections?.()
          } catch {
            /* 刚绑上，没有连接 */
          }
          try {
            server.close()
          } catch {
            /* 同上 */
          }
          throw new Error('Web 桥已卸载')
        }
        this.proxy = server
        this.proxyPort = port
        return { server, port }
      })
      .finally(() => {
        this.proxyStarting = undefined
      })
    return this.proxyStarting
  }

  /** 真正的启动流程：spawn → 等就绪 → 登录 → 接上代理。 */
  private async start(): Promise<MagpieWebHandle> {
    const { binary, host, key, logger } = this.options
    const timeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS

    if (binary === undefined) {
      throw new Error(
        '找不到 magpie 可执行文件。插件应该已经自动下载到 ~/.dsh/magpie/bin/ —— 如果下载失败，手动装一个 magpie（https://github.com/yetone/magpie/releases），或在设置里把 magpieBinary 指向它的绝对路径。',
      )
    }

    const guard = (): void => {
      if (this.disposed) throw new Error('Web 桥已卸载')
    }

    guard()
    const upstreamPort = await findFreePort(host, this.options.preferredPort, DEFAULT_PORT_ATTEMPTS)
    guard()

    if (!/^[A-Za-z0-9._~-]{16,}$/u.test(key)) {
      throw new Error('MAGPIE_WEB_KEY 不合法：需要 16 位以上，且只含字母、数字、- . _ ~')
    }

    const gatewayURL = this.options.gatewayURL
    if (gatewayURL !== undefined) {
      const probe = await probeGateway(gatewayURL)
      guard()
      logger.debug(
        probe.reachable
          ? `[magpie] 网关已在线（${probe.version ?? '版本未知'}）：${gatewayURL}`
          : `[magpie] 网关未运行，将由 magpie serve 一并启动：${gatewayURL}`,
      )
    }

    logger.debug(`[magpie] 启动 magpie serve --web（${host}:${String(upstreamPort)}）`)

    // serve --web= 是一个进程同时提供网关 + Web UI；网关已被别的实例占用时
    // 它只提供 Web UI（日志里那句 another magpie serves the gateway there）。
    const child = spawn(binary, ['serve', `--web=${host}:${String(upstreamPort)}`], {
      env: { ...process.env, MAGPIE_WEB_KEY: key },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    const generation = ++this.generation

    try {
      guard()

      await new Promise<void>((resolve, reject) => {
        let settled = false
        let buffered = ''

        const cleanup = (): void => {
          clearTimeout(timer)
          child.stdout?.off('data', onStdout)
          child.stderr?.off('data', onStderr)
          child.off('exit', onExit)
          child.off('error', onError)
        }
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        const fail = (message: string): void => {
          settle(() => {
            this.child = undefined
            stopProcessTree(child)
            reject(new Error(message))
          })
        }
        const onStdout = (chunk: Buffer): void => {
          buffered += chunk.toString('utf8')
          const match = READY_PATTERN.exec(buffered)
          if (match?.[1] === undefined) {
            if (buffered.length > 8_192) buffered = buffered.slice(-4_096)
            return
          }
          settle(() => {
            logger.debug(`[magpie] magpie web 就绪：${match[0]}`)
            resolve()
          })
        }
        const onStderr = (chunk: Buffer): void => {
          const text = chunk.toString('utf8').trim()
          if (text.length > 0) logger.debug(`[magpie] magpie web stderr: ${text.slice(0, 500)}`)
        }
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          fail(
            `magpie web 提前退出（code=${code === null ? 'null' : String(code)}, signal=${signal === null ? 'null' : signal}）` +
              (buffered.length > 0 ? `：${buffered.slice(-400)}` : ''),
          )
        }
        const onError = (error: Error): void => {
          fail(`无法启动 magpie web：${error.message}`)
        }
        const timer = setTimeout(() => {
          fail(`magpie web 在 ${String(timeoutMs)}ms 内没有就绪`)
        }, timeoutMs)
        timer.unref?.()

        child.stdout?.on('data', onStdout)
        child.stderr?.on('data', onStderr)
        child.once('exit', onExit)
        child.once('error', onError)
      })

      guard()

      const cookie = await login(
        `http://${urlHost(connectHost(host))}:${String(upstreamPort)}`,
        key,
        timeoutMs,
      )
      guard()
      logger.debug(`[magpie] 已取得登录 cookie（${cookie.split('=')[0] ?? '?'}）`)

      // 临时 exit 监听已在 settle 时移除；login 期间进程可能已退出。
      if (child.exitCode !== null || !isProcessAlive(child.pid)) {
        throw new Error('magpie web 在启动过程中退出')
      }

      const { port: proxyPort } = await this.ensureProxy()
      guard()

      this.upstream = { host: connectHost(host), port: upstreamPort, cookie }

      const handle: MagpieWebHandle = {
        url: mainWindowUrl(host, proxyPort),
        port: proxyPort,
        upstreamPort,
        pid: child.pid,
      }
      this.handle = handle
      this.markStable()
      logger.debug(`[magpie] 代理就绪：${handle.url} → ${host}:${String(upstreamPort)}`)

      // 常驻 exit 监听：magpie 之后任何时刻退出都要清句柄并自动拉起
      // （自我更新 = 新进程起来 → 老进程退出；代理常驻，只换上游）。
      child.once('exit', (code, signal) => {
        if (this.generation !== generation || this.child !== child) return
        if (this.disposed) return
        this.discardHandle()
        this.scheduleRestart(
          `web 进程已退出（code=${code === null ? 'null' : String(code)}, signal=${signal === null ? 'null' : signal}）`,
        )
      })

      return handle
    } catch (error) {
      stopProcessTree(child)
      if (this.child === child) {
        this.child = undefined
        this.upstream = undefined
      }
      this.handle = undefined
      throw error
    }
  }
}
