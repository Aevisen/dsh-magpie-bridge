import { describe, expect, it } from 'vitest'

import { unwrapRpcResult } from '../plugin-src/client/rpc.js'

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
