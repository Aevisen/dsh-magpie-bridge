/**
 * magpie 二进制解析（四级回退，命中即停）。
 *
 * 1. 配置里的 `magpieBinary`（显式绝对/相对路径）
 * 2. `~/.dsh/magpie/bin/magpie[.exe]`（插件自己下载的，跨 profile 共享）
 * 3. 系统安装位置（macOS `.app` 包、Windows 安装目录、Linux 常见目录）
 * 4. `PATH`
 *
 * 只做查找，不下载；下载由 `src/download.ts` 负责。
 * @module dsh-magpie-bridge/binary
 */
import { access, constants, stat } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'

/** 解析结果来源。 */
export type BinarySource = 'config' | 'managed' | 'system' | 'path'

/** 解析结果。 */
export interface ResolvedBinary {
  /** 可执行文件绝对路径。 */
  readonly path: string
  /** 从哪一级找到的。 */
  readonly source: BinarySource
}

/** 本地二进制文件名（Windows 带 `.exe`）。 */
export function binaryFileName(platform: string = osPlatform()): string {
  return platform === 'win32' ? 'magpie.exe' : 'magpie'
}

/** 插件自己管理的二进制路径（每次调用重算 homedir，便于测试与多用户）。 */
export function managedBinaryPath(platform: string = osPlatform()): string {
  return join(homedir(), '.dsh', 'magpie', 'bin', binaryFileName(platform))
}

/**
 * release 资产名。
 *
 * magpie 用 Go 的 GOOS/GOARCH 命名，与 Node 的 process.platform/arch 有两处不同：
 * `win32 → windows`、`x64 → amd64`。
 *
 * @returns 资产名（如 `magpie-cli-windows-amd64.exe`）；不支持的平台返回 undefined。
 */
export function releaseAssetName(
  platform: string = osPlatform(),
  arch: string = process.arch,
): string | undefined {
  const os =
    platform === 'win32'
      ? 'windows'
      : platform === 'darwin'
        ? 'darwin'
        : platform === 'linux'
          ? 'linux'
          : undefined
  if (os === undefined) return undefined
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined
  if (cpu === undefined) return undefined
  return `magpie-cli-${os}-${cpu}${os === 'windows' ? '.exe' : ''}`
}

/** 文件是否可执行（存在 + 普通文件 + 非零大小；非 win32 再查执行位）。 */
export async function isExecutableFile(path: string, platform: string = osPlatform()): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) return false
    if (platform === 'win32') return true
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 系统里可能装了 magpie 的标准位置（不保证存在，由调用方判定）。 */
export function systemBinaryCandidates(platform: string = osPlatform()): readonly string[] {
  const name = binaryFileName(platform)
  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA']
    const programFiles = process.env['PROGRAMFILES']
    const programFilesX86 = process.env['PROGRAMFILES(X86)']
    return [
      ...(localAppData === undefined || localAppData === '' ? [] : [join(localAppData, 'Programs', 'magpie', name)]),
      ...(programFiles === undefined || programFiles === '' ? [] : [join(programFiles, 'magpie', name)]),
      ...(programFilesX86 === undefined || programFilesX86 === '' ? [] : [join(programFilesX86, 'magpie', name)]),
    ]
  }
  if (platform === 'darwin') {
    return [
      join('/Applications', 'magpie.app', 'Contents', 'MacOS', 'magpie'),
      join(homedir(), 'Applications', 'magpie.app', 'Contents', 'MacOS', 'magpie'),
      '/opt/homebrew/bin/magpie',
      '/usr/local/bin/magpie',
    ]
  }
  return [
    join(homedir(), '.local', 'bin', name),
    '/usr/local/bin/magpie',
    '/usr/bin/magpie',
    '/opt/magpie/magpie',
  ]
}

/** `PATH` 的目录列表（按平台分隔符切分，空条目剔除）。 */
function pathEntries(platform: string): readonly string[] {
  const raw = process.env['PATH'] ?? process.env['Path'] ?? ''
  return raw
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** 在 PATH 里找第一个可执行的 magpie。 */
async function findInPath(platform: string): Promise<string | undefined> {
  const name = binaryFileName(platform)
  for (const dir of pathEntries(platform)) {
    const candidate = join(dir, name)
    if (await isExecutableFile(candidate, platform)) return candidate
  }
  return undefined
}

/**
 * 按优先级解析 magpie 二进制。
 *
 * `configured` 为空串 / `'magpie'` 视为「未显式指定」，按 2→3→4 级找。
 */
export async function resolveMagpieBinary(
  configured: string | undefined,
  platform: string = osPlatform(),
): Promise<ResolvedBinary | undefined> {
  const explicit = configured?.trim()
  if (explicit !== undefined && explicit.length > 0 && explicit !== 'magpie') {
    if (await isExecutableFile(explicit, platform)) {
      return { path: explicit, source: 'config' }
    }
  }

  const managed = managedBinaryPath(platform)
  if (await isExecutableFile(managed, platform)) {
    return { path: managed, source: 'managed' }
  }

  for (const candidate of systemBinaryCandidates(platform)) {
    if (await isExecutableFile(candidate, platform)) {
      return { path: candidate, source: 'system' }
    }
  }

  const inPath = await findInPath(platform)
  if (inPath !== undefined) {
    return { path: inPath, source: 'path' }
  }

  return undefined
}

/** 来源的中文说明（日志/错误提示用）。 */
export function describeSource(source: BinarySource): string {
  switch (source) {
    case 'config':
      return '配置指定'
    case 'managed':
      return '插件自带'
    case 'system':
      return '系统安装'
    case 'path':
      return 'PATH'
    default:
      return String(source)
  }
}
