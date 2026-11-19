import { describe, expect, it } from 'vitest'

import { callMagpieRpc, unwrapRpcResult } from '../plugin-src/client/rpc.js'
import { PANEL_CHANNEL } from '../src/index.js'

it.each(['web.url', 'web.dockUrl'])('uses a valid shared client and host channel for %s', async (method) => {
  const value = { url: 'http://127.0.0.1:3591/' }
  const connection = { rpc: { async call(channel: string, endpoint: string) {
    expect(channel).toMatch(/^\/[A-Za-z0-9._~-]+$/u)
    expect(channel).toBe(PANEL_CHANNEL)
    expect(endpoint).toBe(`magpie-bridge/${method}`)
    return { ok: true, value }
  } } }
  await expect(callMagpieRpc(connection, method)).resolves.toEqual(value)
})

describe('unwrapRpcResult', () => {
  it('returns the value on success', () => {
    expect(unwrapRpcResult({ ok: true, value: { url: 'http://127.0.0.1:3591/' } })).toEqual({
      url: 'http://127.0.0.1:3591/',
    })
  })

  it('throws the server message on failure', () => {
    expect(() =>
      unwrapRpcResult({
        ok: false,
        error: { code: 'magpie/web-unavailable', message: 'boom', details: {} },
      }),
    ).toThrow(/boom/)
  })

  it('throws on malformed envelopes', () => {
    expect(() => unwrapRpcResult({})).toThrow(/invalid server-response result/)
    expect(() => unwrapRpcResult(null)).toThrow(/invalid server-response result/)
    expect(() => unwrapRpcResult({ ok: 'yes' })).toThrow(/invalid server-response result/)
  })
})
