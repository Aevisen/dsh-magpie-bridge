/**
 * 插件配置（schemastery schema）与解析后的运行时形状。
 * @module dsh-magpie-bridge/config
 */
import { randomBytes } from 'node:crypto'

import Schema from '@deepseek-ai/schemastery'

/** 解析后的运行时配置。所有字段都有默认值，来自 cordis.patch.yml 的 `config:` 块。 */
export interface MagpieOptions {
  /** 网关根地址（不带 /v1），仅用于日志诊断。 */
  baseURL: string
  /** 是否嵌入原版 Web UI。 */
  webEnabled: boolean
  /** Web UI 监听地址。 */
  webHost: string
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
  webPort: Schema.number().default(3480),
  proxyPort: Schema.number().default(3591),
  webKey: Schema.string().default(''),
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
  if (webKey === '') {
    parsed['webKey'] = generateWebKey()
  } else if (!isValidWebKey(webKey)) {
    throw new Error('MAGPIE_WEB_KEY 不合法：需要 16 位以上，且只含字母、数字、- . _ ~')
  }
  return parsed as unknown as MagpieOptions
}
