import { describe, expect, it } from 'vitest'

import * as entry from '../src/index.js'

describe('host entry', () => {
  it('exports the cordis entry surface and no default export', () => {
    const keys = Object.keys(entry)
    expect(keys).toEqual(expect.arrayContaining(['Config', 'apply', 'inject', 'name']))
    expect(keys).not.toContain('default')
  })

  it('carries the stable row id and an empty static inject list', () => {
    expect(entry.name).toBe('magpie-bridge')
    expect(entry.inject).toEqual([])
  })

  it('applies synchronously without connection or tools services', () => {
    const ctx = {
      effect: () => () => {},
      inject: () => {},
      logger: undefined,
    }
    expect(() => entry.apply(ctx, { autoStartGateway: false })).not.toThrow()
  })

  it('registers tools through the tools inject scope', () => {
    const registered: string[] = []
    const ctx = {
      effect: () => () => {},
      inject: (services: readonly string[], callback: (scoped: unknown) => void) => {
        if (services.includes('tools')) {
          callback({
            tools: {
              register: (definition: { name: string }) => {
                registered.push(definition.name)
                return () => {}
              },
            },
            on: () => () => {},
          })
        }
        return () => {}
      },
      logger: undefined,
    }
    entry.apply(ctx, { autoStartGateway: false })
    expect([...registered].sort()).toEqual(['magpie', 'magpie_quota'])
  })

  it('registers the panel channel through connection.rpc.handle', async () => {
    let registered: { channel: string; handler: (endpoint: string) => Promise<unknown> } | undefined
    const ctx = {
      effect: () => () => {},
      inject: (services: readonly string[], callback: (scoped: unknown) => void) => {
        if (services.includes('connection')) {
          callback({
            connection: {
              rpc: {
                handle: (channel: string, handler: (endpoint: string) => Promise<unknown>) => {
                  registered = { channel, handler }
                },
              },
            },
          })
        }
        return () => {}
      },
      logger: undefined,
    }
    entry.apply(ctx, { autoStartGateway: false, webEnabled: false })

    expect(registered?.channel).toBe('/api/magpie-bridge')
    const result = (await registered?.handler('web.url')) as {
      ok: boolean
      error?: { code: string; details: unknown }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('magpie/web-disabled')
    expect(result.error?.details).toEqual({})
  })
})
