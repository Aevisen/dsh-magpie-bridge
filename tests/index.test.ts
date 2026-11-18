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
    let disposed = false
    const ctx = {
      effect: (disposer: () => void) => {
        void disposer
        return () => {}
      },
      inject: () => {},
      logger: undefined,
    }
    expect(() => entry.apply(ctx, { autoStartGateway: false })).not.toThrow()
    expect(disposed).toBe(false)
  })
})
