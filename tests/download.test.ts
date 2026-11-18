import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir as realTmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  home: '',
  forceUnsupported: false,
  fetchImpl: undefined as ((url: string) => Promise<Response>) | undefined,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => state.home }
})

vi.mock('../src/binary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/binary.js')>()
  return {
    ...actual,
    releaseAssetName: () => (state.forceUnsupported ? undefined : actual.releaseAssetName()),
  }
})

import { managedBinaryPath } from '../src/binary.js'
import { ensureMagpieBinary, parseChecksumFile, verifyChecksum } from '../src/download.js'

const RELEASE_API = 'https://api.github.com/repos/yetone/magpie-releases/releases/latest'
const logger = { debug: () => {}, warn: () => {} }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200 })
}

function bytesResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200 })
}

let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(realTmpdir(), 'magpie-dl-'))
  state.home = home
  state.forceUnsupported = false
  state.fetchImpl = undefined
  vi.unstubAllGlobals()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(home, { recursive: true, force: true })
})

describe('parseChecksumFile', () => {
  it('finds the target asset in a checksums.txt style file', () => {
    expect(parseChecksumFile('abc123  magpie-cli-darwin-arm64\n', 'magpie-cli-darwin-arm64')).toBe('abc123')
  })

  it('returns undefined when the asset is absent', () => {
    expect(parseChecksumFile('abc123  other-file\n', 'magpie-cli-darwin-arm64')).toBeUndefined()
  })

  it('accepts a single-value .sha256 file', () => {
    expect(parseChecksumFile('deadbeef\n', 'anything')).toBe('deadbeef')
  })
})

describe('verifyChecksum', () => {
  it('reports ok on match, missing without expectation, mismatch otherwise', async () => {
    const { createHash } = await import('node:crypto')
    const bytes = Buffer.from('hello')
    const hash = createHash('sha256').update(bytes).digest('hex')
    expect(verifyChecksum(bytes, hash)).toBe('ok')
    expect(verifyChecksum(bytes, undefined)).toBe('missing')
    expect(verifyChecksum(bytes, '0'.repeat(64))).toBe('mismatch')
  })
})

describe('ensureMagpieBinary', () => {
  it('rejects unsupported platforms', async () => {
    state.forceUnsupported = true
    await expect(ensureMagpieBinary({ logger })).rejects.toThrow(/不支持/)
  })

  it('returns the existing binary without downloading', async () => {
    const target = managedBinaryPath()
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, 'bin', { mode: 0o755 })
    await chmod(target, 0o755)
    await expect(ensureMagpieBinary({ logger })).resolves.toBe(target)
  })

  it('downloads, verifies and installs the asset', async () => {
    const actual = await vi.importActual<typeof import('../src/binary.js')>('../src/binary.js')
    const asset = actual.releaseAssetName()
    expect(asset).toBeDefined()
    const bytes = new TextEncoder().encode('fake magpie binary')
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const binUrl = `https://example.test/${asset}`
    const csUrl = 'https://example.test/checksums.txt'
    state.fetchImpl = async (url: string) => {
      if (url === RELEASE_API) {
        return jsonResponse({
          assets: [
            { name: asset, browser_download_url: binUrl },
            { name: 'checksums.txt', browser_download_url: csUrl },
          ],
        })
      }
      if (url === csUrl) return textResponse(`${hash}  ${asset}\n`)
      if (url === binUrl) return bytesResponse(bytes)
      return new Response('not found', { status: 404 })
    }
    vi.stubGlobal('fetch', state.fetchImpl)

    const target = await ensureMagpieBinary({ logger })
    expect(target).toBe(managedBinaryPath())
    expect(await readFile(target, 'utf8')).toBe('fake magpie binary')
    expect(existsSync(`${target}.part`)).toBe(false)
  })

  it('refuses to install on checksum mismatch', async () => {
    const actual = await vi.importActual<typeof import('../src/binary.js')>('../src/binary.js')
    const asset = actual.releaseAssetName()
    const bytes = new TextEncoder().encode('fake magpie binary')
    const binUrl = `https://example.test/${asset}`
    const csUrl = 'https://example.test/checksums.txt'
    state.fetchImpl = async (url: string) => {
      if (url === RELEASE_API) {
        return jsonResponse({
          assets: [
            { name: asset, browser_download_url: binUrl },
            { name: 'checksums.txt', browser_download_url: csUrl },
          ],
        })
      }
      if (url === csUrl) return textResponse(`${'0'.repeat(64)}  ${asset}\n`)
      if (url === binUrl) return bytesResponse(bytes)
      return new Response('not found', { status: 404 })
    }
    vi.stubGlobal('fetch', state.fetchImpl)

    await expect(ensureMagpieBinary({ logger })).rejects.toThrow(/校验/)
    expect(existsSync(managedBinaryPath())).toBe(false)
    expect(existsSync(`${managedBinaryPath()}.part`)).toBe(false)
  })
})
