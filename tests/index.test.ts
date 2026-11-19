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

  it('serves both panel RPC methods through exact authenticated carrier routes', async () => {
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    entry.apply({
      effect: () => () => {},
      inject(services: readonly string[], callback: (scoped: unknown) => void) {
        if (!services.includes('connection')) return
        callback({ connection: { fetch: { register(route: {
          path: string
          fetch(request: Request): Promise<Response>
        }) { routes.set(route.path, route.fetch) } } } })
      },
    }, { autoStartGateway: false, webEnabled: false })

    for (const method of ['web.url', 'web.dockUrl']) {
      const endpoint = `magpie-bridge/${method}`
      const path = `/api/${endpoint}`
      const fetchRoute = routes.get(path)
      expect(fetchRoute).toBeDefined()
      const response = await fetchRoute!(new Request(`http://localhost${path}`, {
        method: 'POST',
        body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: endpoint, payload: {} }),
      }))
      expect(await response.json()).toMatchObject({
        type: 'server-response', rpcId: 'test',
        result: { ok: false, error: { code: 'magpie/web-disabled', details: {} } },
      })
    }
  })
})
