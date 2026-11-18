import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir as realTmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => state.home }
})

import {
  binaryFileName,
  managedBinaryPath,
  releaseAssetName,
  resolveMagpieBinary,
  systemBinaryCandidates,
} from '../src/binary.js'

const originalPath = process.env['PATH']

beforeEach(() => {
  state.home = ''
  process.env['PATH'] = ''
})

afterEach(async () => {
  process.env['PATH'] = originalPath
})

async function makeExecutable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await chmod(path, 0o755)
}

describe('releaseAssetName', () => {
  it('maps node platform/arch names to release asset names', () => {
    expect(releaseAssetName('win32', 'x64')).toBe('magpie-cli-windows-amd64.exe')
    expect(releaseAssetName('darwin', 'arm64')).toBe('magpie-cli-darwin-arm64')
    expect(releaseAssetName('linux', 'x64')).toBe('magpie-cli-linux-amd64')
  })

  it('returns undefined for unsupported platforms', () => {
    expect(releaseAssetName('freebsd', 'x64')).toBeUndefined()
    expect(releaseAssetName('darwin', 'ia32')).toBeUndefined()
  })
})

describe('binaryFileName', () => {
  it('appends .exe on windows only', () => {
    expect(binaryFileName('win32')).toBe('magpie.exe')
    expect(binaryFileName('linux')).toBe('magpie')
    expect(binaryFileName('darwin')).toBe('magpie')
  })
})

describe('systemBinaryCandidates', () => {
  it('lists the macOS app bundle first', () => {
    expect(systemBinaryCandidates('darwin')[0]).toMatch(/\/Applications\/magpie\.app\/Contents\/MacOS\/magpie$/)
  })
})

describe('resolveMagpieBinary', () => {
  it('prefers the configured path over everything else', async () => {
    const dir = await mkdtemp(join(realTmpdir(), 'magpie-bin-'))
    try {
      const explicit = join(dir, 'magpie')
      await makeExecutable(explicit)
      const pathDir = await mkdtemp(join(realTmpdir(), 'magpie-path-'))
      try {
        await makeExecutable(join(pathDir, 'magpie'))
        process.env['PATH'] = pathDir
        const resolved = await resolveMagpieBinary(explicit, 'linux')
        expect(resolved?.source).toBe('config')
        expect(resolved?.path).toBe(explicit)
      } finally {
        await rm(pathDir, { recursive: true, force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('finds the managed download under ~/.dsh/magpie/bin', async () => {
    const home = await mkdtemp(join(realTmpdir(), 'magpie-home-'))
    state.home = home
    try {
      const bin = join(home, '.dsh', 'magpie', 'bin')
      await mkdir(bin, { recursive: true })
      await makeExecutable(join(bin, 'magpie'))
      const resolved = await resolveMagpieBinary(undefined, 'linux')
      expect(resolved?.source).toBe('managed')
      expect(resolved?.path).toBe(managedBinaryPath('linux'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('finds magpie on PATH', async () => {
    const pathDir = await mkdtemp(join(realTmpdir(), 'magpie-path-'))
    try {
      await makeExecutable(join(pathDir, 'magpie'))
      process.env['PATH'] = pathDir
      const resolved = await resolveMagpieBinary(undefined, 'linux')
      expect(resolved?.source).toBe('path')
      expect(resolved?.path).toBe(join(pathDir, 'magpie'))
    } finally {
      await rm(pathDir, { recursive: true, force: true })
    }
  })

  it('returns undefined when nothing is installed', async () => {
    const home = await mkdtemp(join(realTmpdir(), 'magpie-home-'))
    state.home = home
    try {
      expect(await resolveMagpieBinary(undefined, 'linux')).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
