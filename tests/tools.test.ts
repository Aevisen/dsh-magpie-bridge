import { describe, expect, it } from 'vitest'

import { resolveOptions } from '../src/config.js'
import { isDangerousCommand } from '../src/cli.js'
import { registerMagpieTools } from '../src/tools.js'

describe('isDangerousCommand', () => {
  it('matches full command path prefixes', () => {
    expect(isDangerousCommand(['provider', 'rm', 'x'])).toBe(true)
    expect(isDangerousCommand(['quota', 'reset'])).toBe(true)
    expect(isDangerousCommand(['uninstall'])).toBe(true)
    expect(isDangerousCommand(['--json', 'group', 'rm', 'x'])).toBe(true)
  })

  it('does not match safe or unknown commands', () => {
    expect(isDangerousCommand(['providers'])).toBe(false)
    expect(isDangerousCommand(['quota'])).toBe(false)
    expect(isDangerousCommand(['--help'])).toBe(false)
    expect(isDangerousCommand([])).toBe(false)
  })
})

import { summarizeQuota } from '../src/tools.js'

describe('summarizeQuota', () => {
  it('compresses quota JSON into one line per window', () => {
    const summary = summarizeQuota(
      JSON.stringify([
        {
          provider: 'codex',
          name: 'Codex',
          kind: 'subscription',
          balance: '277.5 credits',
          windows: [
            { name: '5 hours', used: 7, remaining: 93, resetsAt: '2026-11-19T03:01:53+08:00' },
            { name: '7 days', used: 32, remaining: 68 },
          ],
        },
      ]),
    )
    expect(summary).toContain('Codex (codex/subscription) · balance 277.5 credits')
    expect(summary).toContain('5 hours: used 7, left 93 · resets 2026-11-19T03:01:53+08:00')
    expect(summary).toContain('7 days: used 32, left 68')
  })

  it('returns undefined for non-JSON output', () => {
    expect(summarizeQuota('not json')).toBeUndefined()
    expect(summarizeQuota('')).toBeUndefined()
  })
})

describe('registerMagpieTools', () => {
  it('registers magpie and magpie_quota, gating dangerous commands through pre-execute', async () => {
    const registered: string[] = []
    const listeners = new Map<string, (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
    const ctx = {
      tools: {
        register: (definition: { name: string }) => {
          registered.push(definition.name)
          return () => {}
        },
      },
      on: (event: string, listener: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
        listeners.set(event, listener)
        return () => {}
      },
    }

    registerMagpieTools(ctx as never, {
      options: resolveOptions({}),
      resolveBinary: async () => process.execPath,
    })

    expect([...registered].sort()).toEqual(['magpie', 'magpie_quota'])

    const preExecute = listeners.get('tools/pre-execute')
    expect(preExecute).toBeDefined()
    const next = async () => ({ kind: 'allow' })

    const dangerous = (await preExecute?.({ name: 'magpie', args: { args: ['provider', 'rm', 'x'] } }, next)) as {
      kind: string
    }
    expect(dangerous.kind).toBe('ask')

    const safe = (await preExecute?.({ name: 'magpie', args: { args: ['quota'] } }, next)) as { kind: string }
    expect(safe.kind).toBe('allow')
  })
})
