import { createServer as createNetServer } from 'node:net'
import { describe, expect, it } from 'vitest'

import {
  DROPPED_REQUEST_HEADERS,
  DROPPED_RESPONSE_HEADERS,
  dockWindowUrl,
  findFreePort,
  mainWindowUrl,
  readyWebOrigin,
  restartDelay,
} from '../src/web-bridge.js'

describe('restartDelay', () => {
  it('backs off exponentially and caps at 15s', () => {
    expect(restartDelay(1)).toBe(1000)
    expect(restartDelay(2)).toBe(2000)
    expect(restartDelay(3)).toBe(4000)
    expect(restartDelay(4)).toBe(8000)
    expect(restartDelay(5)).toBe(15000)
    expect(restartDelay(99)).toBe(15000)
    expect(restartDelay(0)).toBe(1000)
  })
})

describe('window URLs', () => {
  it('maps wildcard binds to loopback', () => {
    expect(mainWindowUrl('0.0.0.0', 1)).toBe('http://127.0.0.1:1/')
    expect(mainWindowUrl('127.0.0.1', 2)).toBe('http://127.0.0.1:2/')
  })

  it('appends the panel mode for the dock window', () => {
    expect(dockWindowUrl('127.0.0.1', 5)).toBe('http://127.0.0.1:5/?mode=panel')
  })
})

describe('readyWebOrigin', () => {
  it('reads a ready line even when it has no trailing newline', () => {
    expect(readyWebOrigin('magpie web on http://127.0.0.1:3480')?.origin).toBe('http://127.0.0.1:3480')
  })

  it('ignores an unfinished URL after the last newline', () => {
    expect(readyWebOrigin('noise\nmagpie web on http://127.0.0.1:34')).toBeUndefined()
  })

  it('maps a wildcard bind address to loopback', () => {
    expect(readyWebOrigin('magpie web on http://0.0.0.0:3480\n')?.origin).toBe('http://127.0.0.1:3480')
    expect(readyWebOrigin('magpie web on http://[::]:3480\n')?.origin).toBe('http://[::1]:3480')
  })
})

describe('findFreePort', () => {
  it('rejects ports below 1', async () => {
    await expect(findFreePort('127.0.0.1', 0, 5)).rejects.toThrow()
  })

  it('skips occupied ports', async () => {
    const first = createNetServer()
    const second = createNetServer()
    await new Promise<void>((resolve) => first.listen(45820, '127.0.0.1', () => resolve()))
    await new Promise<void>((resolve) => second.listen(45821, '127.0.0.1', () => resolve()))
    try {
      expect(await findFreePort('127.0.0.1', 45820, 5)).toBe(45822)
    } finally {
      first.close()
      second.close()
    }
  })
})

describe('proxy header filtering', () => {
  it('drops hop-by-hop and framing headers but keeps content encoding', () => {
    expect(DROPPED_RESPONSE_HEADERS.has('set-cookie')).toBe(true)
    expect(DROPPED_RESPONSE_HEADERS.has('content-security-policy')).toBe(true)
    expect(DROPPED_RESPONSE_HEADERS.has('content-security-policy-report-only')).toBe(true)
    expect(DROPPED_RESPONSE_HEADERS.has('x-frame-options')).toBe(true)
    expect(DROPPED_RESPONSE_HEADERS.has('content-encoding')).toBe(false)
    expect(DROPPED_RESPONSE_HEADERS.has('content-length')).toBe(false)
  })

  it('replaces the inbound cookie header instead of forwarding it', () => {
    expect(DROPPED_REQUEST_HEADERS.has('cookie')).toBe(false)
    expect(DROPPED_REQUEST_HEADERS.has('host')).toBe(true)
    expect(DROPPED_REQUEST_HEADERS.has('content-length')).toBe(true)
  })
})
