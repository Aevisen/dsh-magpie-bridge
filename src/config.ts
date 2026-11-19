/**
 * 插件配置（schemastery schema）与解析后的运行时形状。
 * @module dsh-magpie-bridge/config
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

/** 解析后的运行时配置。所有字段都有默认值，来自 cordis.patch.yml 的 `config:` 块。 */
export interface MagpieOptions {
  /** 网关根地址（不带 /v1），仅用于日志诊断。 */
  baseURL: string
  /** 是否嵌入原版 Web UI。 */
  webEnabled: boolean
  /** Web UI 监听地址。 */
  webHost: string
  webURL: string
  /** Web UI 首选端口（被占用时向后找）。 */
  webPort: number
  /** 认证代理端口（固定，iframe 直接加载）。 */
  proxyPort: number
  /** MAGPIE_WEB_KEY：16+ 位 [A-Za-z0-9._~-]。 */
  webKey: string
  /** 插件加载时后台起 `magpie serve --web`。 */
  autoStartGateway: boolean
  /** 找不到二进制时自动下载。 */
  autoDownloadMagpie: boolean
  /** magpie 可执行文件路径（默认按四级回退解析）。 */
  magpieBinary: string
  /** CLI 工具输出上限（字符）。 */
  toolOutputLimit: number
  /** CLI 工具超时（毫秒）。 */
  toolTimeoutMs: number
}

/** 插件 Config schema。字段与默认值即 Global Constraints 的默认配置。 */
export const Config = Schema.object({
  baseURL: Schema.string().default('http://127.0.0.1:3425'),
  webEnabled: Schema.boolean().default(true),
  webHost: Schema.string().default('127.0.0.1'),
  webURL: Schema.string().default('').description('Existing local Magpie Web URL, for example http://127.0.0.1:3430. Requires webKey.'),
  webPort: Schema.number().default(3480),
  proxyPort: Schema.number().default(3591),
  webKey: Schema.string().default('').role('secret'),
  autoStartGateway: Schema.boolean().default(true),
  autoDownloadMagpie: Schema.boolean().default(true),
  magpieBinary: Schema.string().default('magpie'),
  toolOutputLimit: Schema.number().default(20000),
  toolTimeoutMs: Schema.number().default(120000),
})

const WEB_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,}$/u

/** MAGPIE_WEB_KEY 合法性：16 位以上且只含字母、数字、`- . _ ~`。 */
export function isValidWebKey(key: string): boolean {
  return typeof key === 'string' && WEB_KEY_PATTERN.test(key)
}

/** webKey 的持久化位置（跨启动稳定，避免 magpie web 的登录 cookie 每次失效）。 */
export function webKeyFile(): string {
  return join(homedir(), '.dsh', 'magpie', 'web-key')
}

/**
 * 没有显式配置 webKey 时，复用上次持久化的那个；没有就写入这次生成的。
 * 读写失败时退回 `generated`（功能不受影响，只是重启后 key 会变）。
 */
export function persistedWebKey(generated: string, file: string = webKeyFile()): string {
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (isValidWebKey(existing)) return existing
  } catch {
    /* 还没有这个文件 */
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${generated}\n`, { mode: 0o600 })
  } catch {
    /* 写不了就只用这次的 */
  }
  return generated
}

/** 生成 24 位随机 webKey（base64url，字符集天然落在合法集合内）。 */
export function generateWebKey(): string {
  return randomBytes(18).toString('base64url').replace(/=+$/u, '').slice(0, 24)
}

/**
 * 校验并补全配置。
 *
 * `webKey` 为空时生成（跨启动稳定由调用方持久化到本地文件负责）；
 * 非空但不合法时直接抛错——否则 magpie serve 会带着非法 key 启动，
 * 要等 30 秒超时才暴露。
 */
export function resolveOptions(config: unknown): MagpieOptions {
  const parsed = (config == null ? new Config() : Config(config)) as Record<string, unknown>
  const webKey = typeof parsed['webKey'] === 'string' ? parsed['webKey'] : ''
  if (typeof parsed.webURL === 'string' && parsed.webURL.trim()) {
    parsed.webURL = parseWebOrigin(parsed.webURL).origin
    if (!webKey) throw new Error('配置 webURL 时需要填写该 Magpie Web 服务的 webKey')
  }
  if (webKey === '') {
    parsed['webKey'] = generateWebKey()
  } else if (!isValidWebKey(webKey)) {
    throw new Error('MAGPIE_WEB_KEY 不合法：需要 16 位以上，且只含字母、数字、- . _ ~')
  }
  return parsed as unknown as MagpieOptions
}

/** Accept only a local HTTP Web listener, with credentials supplied separately. */
export function parseWebOrigin(input: string): URL {
  const url = URL.parse(input.trim())
  const host = url?.hostname
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  if (!url || url.protocol !== 'http:' || !local
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('webURL 必须是本机 Magpie Web 的 HTTP 根地址，密钥请单独填入 webKey')
  }
  return url
}
