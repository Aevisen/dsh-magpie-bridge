import { describe, expect, it, vi } from 'vitest'

import { resolveOptions } from '../src/config.js'
import { createPanelHandler } from '../src/index.js'

function handle(overrides: Partial<Awaited<ReturnType<typeof fakeBridge>>> = {}) {
  return { url: 'http://127.0.0.1:3591/', port: 3591, upstreamPort: 3480, pid: 42, ...overrides }
}

async function fakeBridge(h?: ReturnType<typeof handle>) {
  return { ensure: async () => (h === undefined ? handle() : h) }
}

describe('createPanelHandler', () => {
  it('returns the proxy url and port for web.url', async () => {
    const getBridge = vi.fn(async () => fakeBridge())
    const handler = createPanelHandler(resolveOptions({}), getBridge)
    const result = await handler('web.url')
    expect(result).toEqual({ ok: true, value: { url: 'http://127.0.0.1:3591/', port: 3591 } })
  })

  it('returns the dock url for web.dockUrl', async () => {
    const handler = createPanelHandler(resolveOptions({}), async () => fakeBridge())
    const result = await handler('web.dockUrl')
    expect(result).toEqual({ ok: true, value: { url: 'http://127.0.0.1:3591/?mode=panel' } })
  })

  it('rejects unknown methods', async () => {
    const handler = createPanelHandler(resolveOptions({}), async () => fakeBridge())
    const result = await handler('nope')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('magpie/unknown-method')
  })

  it('reports web-disabled when the UI is switched off', async () => {
    const handler = createPanelHandler(resolveOptions({ webEnabled: false }), async () => fakeBridge())
    const result = await handler('web.url')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('magpie/web-disabled')
  })

  it('wraps bridge failures as web-unavailable', async () => {
    const getBridge = vi.fn(async () => ({
      ensure: async () => {
        throw new Error('boom')
      },
    }))
    const handler = createPanelHandler(resolveOptions({}), getBridge)
    const result = await handler('web.url')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('magpie/web-unavailable')
      expect(result.error.message).toContain('boom')
    }
  })
})
