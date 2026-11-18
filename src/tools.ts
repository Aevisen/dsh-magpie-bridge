/**
 * Agent 工具层：`magpie`（CLI 直通）与 `magpie_quota`（配额摘要）。
 *
 * 破坏性命令（见 `DANGEROUS_PREFIXES`）经 `tools/pre-execute` 走 DSH 审批。
 * @module dsh-magpie-bridge/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { MagpieOptions } from './config.js'
import { isDangerousCommand, runMagpie } from './cli.js'

export interface RegisterToolsDeps {
  options: MagpieOptions
  resolveBinary(): Promise<string | undefined>
}

/** 把 CLI 结果渲染成模型可见文本。 */
function renderCli(command: string, value: { code: number | null; stdout: string; stderr: string }): string {
  const lines = [`$ magpie ${command}`.trim(), value.stdout]
  if (value.stderr.length > 0) lines.push(value.stderr)
  if (value.code === null) lines.push('[exit 未正常结束，见 stderr]')
  return lines.filter((line) => line.length > 0).join('\n')
}

/** 把 `quota --json` 压成每账户几行摘要；解析失败返回 undefined（调用方回退原文）。 */
export function summarizeQuota(stdout: string): string | undefined {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return undefined
  let entries: unknown
  try {
    entries = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!Array.isArray(entries)) return undefined

  const lines: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = String(record['name'] ?? record['provider'] ?? '?')
    const provider = String(record['provider'] ?? '?')
    const kind = typeof record['kind'] === 'string' ? `/${record['kind']}` : ''
    const balance = typeof record['balance'] === 'string' ? ` · balance ${record['balance']}` : ''
    lines.push(`${name} (${provider}${kind})${balance}`)
    const windows = Array.isArray(record['windows']) ? (record['windows'] as unknown[]) : []
    for (const item of windows) {
      if (typeof item !== 'object' || item === null) continue
      const window = item as Record<string, unknown>
      const windowName = String(window['name'] ?? '?')
      const used = String(window['used'] ?? '?')
      const remaining = String(window['remaining'] ?? window['display'] ?? '?')
      const resets = typeof window['resetsAt'] === 'string' ? ` · resets ${window['resetsAt']}` : ''
      lines.push(`  ${windowName}: used ${used}, left ${remaining}${resets}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** 注册工具并挂上危险命令审批。`ctx.tools` 缺失时静默跳过（如无头 profile）。 */
export function registerMagpieTools(ctx: unknown, deps: RegisterToolsDeps): void {
  const { options, resolveBinary } = deps
  const context = ctx as {
    tools?: { register(definition: unknown, options?: unknown): () => void }
    on?(event: string, listener: (...args: never[]) => unknown): () => void
  }
  if (context.tools?.register === undefined) return

  const resolve = async (): Promise<string> => {
    const binary = await resolveBinary()
    if (binary === undefined) {
      throw new Error('找不到 magpie 可执行文件：请安装 magpie，或让插件自动下载（autoDownloadMagpie）')
    }
    return binary
  }

  context.tools.register(
    defineTool({
      name: 'magpie',
      description:
        'Run a magpie CLI command. Args is the argument array (no shell). ' +
        'Examples: ["dsh","deepseek/deepseek-chat"], ["quota"], ["providers"], ["group","add","daily","models=a/b,c/d"]. ' +
        'Destructive or account-changing commands (uninstall, restore, rm, provider rm, accounts export, quota reset, data move, plugin add/rm, ...) ' +
        'ask the user for confirmation before running; anything else runs directly. ' +
        'Output is truncated at the configured limit.',
      parameters: {
        args: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'magpie CLI arguments, e.g. ["quota","--json"]. No shell interpretation.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Override the command timeout for this call (milliseconds).',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const record = value as { command: string; code: number | null; stdout: string; stderr: string }
          return [{ type: 'text', text: renderCli(record.command, record) }]
        },
      },
      timeoutMs: options.toolTimeoutMs + 5_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const binary = await resolve()
        const result = await runMagpie(binary, args.args, {
          timeoutMs: args.timeoutMs ?? options.toolTimeoutMs,
          outputLimit: options.toolOutputLimit,
        })
        return {
          command: args.args.join(' '),
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
        }
      },
    }),
  )

  context.tools.register(
    defineTool({
      name: 'magpie_quota',
      description:
        'Show remaining quota for every magpie subscription, plan and key: each window used/left and when it resets. ' +
        'Optionally pass provider names to filter.',
      parameters: {
        providers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only show these providers (e.g. ["codex","claude"]).',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const record = value as { text: string }
          return [{ type: 'text', text: record.text }]
        },
      },
      timeoutMs: options.toolTimeoutMs + 5_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const binary = await resolve()
        const result = await runMagpie(
          binary,
          ['quota', '--json', ...(args.providers ?? [])],
          { timeoutMs: options.toolTimeoutMs, outputLimit: options.toolOutputLimit },
        )
        const summary = summarizeQuota(result.stdout)
        return {
          code: result.code,
          text: summary ?? result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
        }
      },
    }),
  )

  context.on?.('tools/pre-execute', (exec: { name: string; args: { args: string[] } }, next: () => Promise<unknown>) => {
    if (exec.name !== 'magpie') return next()
    if (!isDangerousCommand(exec.args.args ?? [])) return next()
    const command = (exec.args.args ?? []).join(' ')
    return Promise.resolve({
      kind: 'ask',
      reason: `magpie 危险命令：magpie ${command}`,
      displayReason: {
        en: `Run destructive magpie command: magpie ${command}`,
        zh: `运行 magpie 破坏性命令：magpie ${command}`,
      },
    })
  })
}
