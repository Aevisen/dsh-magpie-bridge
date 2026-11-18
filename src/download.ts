/**
 * magpie 自动下载：GitHub Releases → `.part` → sha256 校验 → rename 落位。
 *
 * 校验值来源：release 资产里的 `checksums.txt`，其次 `<asset>.sha256`；
 * 两者都没有时降级为「仅防损坏」并 warn（不阻断安装）。
 * @module dsh-magpie-bridge/download
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isExecutableFile, managedBinaryPath, releaseAssetName } from './binary.js'

export interface EnsureOptions {
  /** 日志出口。 */
  logger: { debug(msg: string): void; warn(msg: string): void }
  /** 卸载/取消时中断下载。 */
  signal?: AbortSignal
  /** 已存在也强制重下。 */
  force?: boolean
}

const RELEASE_API = 'https://api.github.com/repos/yetone/magpie-releases/releases/latest'

/** 解析 checksums 文本：`<sha256>  <file>` 行，或单值 `<asset>.sha256`。 */
export function parseChecksumFile(text: string, assetName: string): string | undefined {
  const trimmed = text.trim()
  if (/^[0-9a-fA-F]+$/u.test(trimmed)) return trimmed.toLowerCase()
  for (const line of text.split(/\r?\n/u)) {
    const match = line.trim().match(/^([0-9a-fA-F]+)\s+\*?(.+?)\s*$/u)
    if (match?.[2] === assetName) return match[1].toLowerCase()
  }
  return undefined
}

/** 校验字节流。expected 为 undefined 时返回 'missing'（只防损坏，不防替换）。 */
export function verifyChecksum(bytes: Buffer, expected: string | undefined): 'ok' | 'missing' | 'mismatch' {
  if (expected === undefined) return 'missing'
  const actual = createHash('sha256').update(bytes).digest('hex')
  return actual === expected.toLowerCase() ? 'ok' : 'mismatch'
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

async function fetchReleaseAssets(signal: AbortSignal | undefined): Promise<ReleaseAsset[]> {
  const response = await fetch(RELEASE_API, { signal })
  if (!response.ok) {
    throw new Error(`读取 magpie release 失败（HTTP ${String(response.status)}）`)
  }
  const release = (await response.json()) as { assets?: ReleaseAsset[] }
  return release.assets ?? []
}

async function fetchBytes(url: string, signal: AbortSignal | undefined): Promise<Buffer> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`下载 ${url} 失败（HTTP ${String(response.status)}）`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function fetchChecksum(asset: string, assets: ReleaseAsset[], signal: AbortSignal | undefined): Promise<string | undefined> {
  const find = (name: string): ReleaseAsset | undefined => assets.find((item) => item.name === name)
  const checksums = find('checksums.txt')
  if (checksums !== undefined) {
    const text = (await fetchBytes(checksums.browser_download_url, signal)).toString('utf8')
    const parsed = parseChecksumFile(text, asset)
    if (parsed !== undefined) return parsed
  }
  const sidecar = find(`${asset}.sha256`)
  if (sidecar !== undefined) {
    const text = (await fetchBytes(sidecar.browser_download_url, signal)).toString('utf8')
    const parsed = parseChecksumFile(text, asset)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/**
 * 确保 managed 二进制存在，返回其绝对路径。
 *
 * 已存在且非 `force` 时直接返回；否则下载、校验、原子 rename。
 * 中断（`signal`）或校验失败都会清掉 `.part`，不残留半成品。
 */
export async function ensureMagpieBinary(options: EnsureOptions): Promise<string> {
  const target = managedBinaryPath()
  if (!options.force && (await isExecutableFile(target))) {
    return target
  }

  const asset = releaseAssetName()
  if (asset === undefined) {
    throw new Error(
      `当前平台（${process.platform}/${process.arch}）不支持自动下载，请手动安装 magpie 并在配置里指定 magpieBinary`,
    )
  }

  const { logger, signal } = options
  const throwIfAborted = (): void => {
    if (signal?.aborted === true) throw new Error('magpie 下载已取消')
  }

  throwIfAborted()
  const assets = await fetchReleaseAssets(signal)
  throwIfAborted()
  const entry = assets.find((item) => item.name === asset)
  if (entry === undefined) {
    throw new Error(`magpie release 中找不到资产 ${asset}`)
  }

  const expected = await fetchChecksum(asset, assets, signal)
  throwIfAborted()

  const bytes = await fetchBytes(entry.browser_download_url, signal)
  throwIfAborted()

  const part = `${target}.part`
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(part, bytes)
    const verdict = verifyChecksum(bytes, expected)
    if (verdict === 'mismatch') {
      throw new Error(`magpie 二进制校验失败（sha256 不匹配）：${asset}`)
    }
    if (verdict === 'missing') {
      logger.warn(`[magpie] release 没有提供 ${asset} 的校验值，已跳过完整性校验（仅防损坏）`)
    }
    await rename(part, target)
  } catch (error) {
    await rm(part, { force: true }).catch(() => {})
    throw error
  }

  // 二进制需要执行位（Windows 由扩展名决定，无所谓）。
  await chmod(target, 0o755).catch(() => {})

  logger.debug(`[magpie] 下载完成：${target}（${String(bytes.length)} 字节）`)
  return target
}
