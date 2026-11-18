import { describe, expect, it } from 'vitest'

import { runMagpie } from '../src/cli.js'

const NODE = process.execPath

describe('runMagpie', () => {
  it('passes arguments verbatim without shell interpretation', async () => {
    const args = ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', 'c"d', "e'f"]
    const result = await runMagpie(NODE, args)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['a b', 'c"d', "e'f"])
  })

  it('truncates oversized output and marks it', async () => {
    const result = await runMagpie(NODE, ['-e', 'process.stdout.write("x".repeat(50000))'], {
      outputLimit: 1000,
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout).toContain('truncated')
    expect(result.stdout.length).toBeLessThanOrEqual(1000 + 20)
  })

  it('reports non-zero exit codes without throwing', async () => {
    const result = await runMagpie(NODE, ['-e', 'process.exit(3)'])
    expect(result.code).toBe(3)
  })

  it('kills on timeout and notes it in stderr', async () => {
    const result = await runMagpie(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 })
    expect(result.code).toBeNull()
    expect(result.stderr).toContain('超时')
  })
})
