import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { generateWebKey, isValidWebKey, persistedWebKey, resolveOptions } from '../src/config.js'

describe('resolveOptions', () => {
  it('returns all defaults when config is undefined', () => {
    const options = resolveOptions(undefined)
    expect(options.baseURL).toBe('http://127.0.0.1:3425')
    expect(options.webEnabled).toBe(true)
    expect(options.webHost).toBe('127.0.0.1')
    expect(options.webPort).toBe(3480)
    expect(options.proxyPort).toBe(3591)
    expect(options.autoStartGateway).toBe(true)
    expect(options.autoDownloadMagpie).toBe(true)
    expect(options.magpieBinary).toBe('magpie')
    expect(options.toolOutputLimit).toBe(20000)
    expect(options.toolTimeoutMs).toBe(120000)
  })

  it('overrides only the given fields', () => {
    const options = resolveOptions({ webPort: 4000 })
    expect(options.webPort).toBe(4000)
    expect(options.baseURL).toBe('http://127.0.0.1:3425')
    expect(options.proxyPort).toBe(3591)
  })

  it('generates a valid 24-char webKey when the configured one is empty', () => {
    const options = resolveOptions({ webKey: '' })
    expect(options.webKey).toHaveLength(24)
    expect(isValidWebKey(options.webKey)).toBe(true)
  })

  it('rejects a non-empty invalid webKey', () => {
    expect(() => resolveOptions({ webKey: 'too-short' })).toThrow(/WEB_KEY/i)
  })
})

describe('persistedWebKey', () => {
  it('reuses the key written on the first call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-key-'))
    const file = join(dir, 'web-key')
    try {
      const first = persistedWebKey('a'.repeat(24), file)
      expect(first).toBe('a'.repeat(24))
      expect((await readFile(file, 'utf8')).trim()).toBe(first)
      expect(persistedWebKey('b'.repeat(24), file)).toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('replaces a stored key that is no longer valid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-key-'))
    const file = join(dir, 'web-key')
    try {
      const { writeFile, mkdir } = await import('node:fs/promises')
      await mkdir(dir, { recursive: true })
      await writeFile(file, 'too-short\n')
      const fresh = 'c'.repeat(24)
      expect(persistedWebKey(fresh, file)).toBe(fresh)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('isValidWebKey', () => {
  it('accepts 16+ chars from the allowed alphabet', () => {
    expect(isValidWebKey('abcdEFGH1234._~-')).toBe(true)
    expect(isValidWebKey('a'.repeat(16))).toBe(true)
  })

  it('rejects too-short keys and disallowed characters', () => {
    expect(isValidWebKey('a'.repeat(15))).toBe(false)
    expect(isValidWebKey('abcdefghijklmnop!')).toBe(false)
  })
})

describe('generateWebKey', () => {
  it('produces distinct valid keys', () => {
    const first = generateWebKey()
    const second = generateWebKey()
    expect(first).not.toBe(second)
    expect(isValidWebKey(first)).toBe(true)
    expect(isValidWebKey(second)).toBe(true)
  })
})
