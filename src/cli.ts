/**
 * magpie CLI 执行：`execFile` 直调，参数原样传递，不经 shell。
 * @module dsh-magpie-bridge/cli
 */
import { execFile } from 'node:child_process'

export interface CliResult {
  /** 退出码；被超时/信号终止或无法启动时为 null。 */
  code: number | null
  stdout: string
  stderr: string
  /** 输出是否被截断。 */
  truncated: boolean
}

export interface CliOptions {
  timeoutMs?: number
  outputLimit?: number
  signal?: AbortSignal
}

/** 默认输出上限（字符）。 */
export const DEFAULT_OUTPUT_LIMIT = 20_000

/**
 * 危险命令前缀（完整命令路径，按序匹配）。
 *
 * 命中后在 `tools/pre-execute` 走 DSH 审批；未命中直接执行——
 * 上游新增子命令不应因为插件没跟上而不可用。
 */
export const DANGEROUS_PREFIXES: readonly (readonly string[])[] = [
  ['uninstall'],
  ['restore'],
  ['rm'],
  ['provider', 'rm'],
  ['provider', 'key'],
  ['group', 'rm'],
  ['group', 'set'],
  ['accounts', 'export'],
  ['accounts', 'import'],
  ['accounts', 'switch'],
  ['accounts', 'access-only'],
  ['quota', 'reset'],
  ['data', 'move'],
  ['plugin', 'rm'],
  ['plugin', 'add'],
  ['github', 'on'],
  ['s3', 'on'],
  ['webdav', 'on'],
  ['backup'],
  ['use'],
  ['import'],
]

/** 去掉前导 flag 后的命令路径。 */
function commandPath(args: readonly string[]): readonly string[] {
  let index = 0
  while (index < args.length && args[index]!.startsWith('-')) index += 1
  return args.slice(index)
}

/** 是否命中危险命令前缀。 */
export function isDangerousCommand(args: readonly string[]): boolean {
  if (args.length === 0) return false
  const path = commandPath(args)
  if (path.length === 0) return false
  return DANGEROUS_PREFIXES.some(
    (prefix) =>
      path.length >= prefix.length && prefix.every((part, index) => path[index] === part),
  )
}

interface CliError {
  code?: unknown
  killed?: boolean
  signal?: string
  message: string
}

function cut(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false }
  return { text: `${text.slice(0, limit)}\n…[truncated]`, cut: true }
}

function withNote(text: string, note: string): string {
  return text.length === 0 ? note : `${text}\n${note}`
}

/**
 * 运行一次 magpie CLI。
 *
 * 非零退出码作为结果返回（不抛）；超时/取消/无法启动时 `code` 为 null 并
 * 在 stderr 注明原因。输出按 `outputLimit` 截断并标记。
 */
export async function runMagpie(
  binary: string,
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const limit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT
  const timeoutMs = options.timeoutMs

  return new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        signal: options.signal,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = cut(String(stdout ?? ''), limit)
        const err = cut(String(stderr ?? ''), limit)
        const truncated = out.cut || err.cut

        if (error === null) {
          resolve({ code: 0, stdout: out.text, stderr: err.text, truncated })
          return
        }

        const detail = error as CliError
        if (typeof detail.code === 'number') {
          resolve({ code: detail.code, stdout: out.text, stderr: err.text, truncated })
          return
        }

        const terminated = detail.killed === true || detail.signal !== undefined
        if (terminated) {
          const note =
            options.signal?.aborted === true
              ? '[magpie] 命令已取消'
              : `[magpie] 命令超时（${String(timeoutMs)}ms）已被终止`
          resolve({ code: null, stdout: out.text, stderr: withNote(err.text, note), truncated })
          return
        }

        resolve({
          code: null,
          stdout: out.text,
          stderr: withNote(err.text, `[magpie] 执行失败：${detail.message}`),
          truncated,
        })
      },
    )
  })
}
