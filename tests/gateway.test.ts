import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'

import { probeGateway } from '../src/gateway.js'

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as AddressInfo).port
}

describe('probeGateway', () => {
  it('reports reachable with the version from /api/hello', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/api/hello') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ version: '1.2.3' }))
        return
      }
      response.writeHead(404)
      response.end()
    })
    const port = await listen(server)
    try {
      const result = await probeGateway(`http://127.0.0.1:${String(port)}`)
      expect(result.reachable).toBe(true)
      expect(result.version).toBe('1.2.3')
    } finally {
      server.close()
    }
  })

  it('falls back to /v1/models', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
    })
    const port = await listen(server)
    try {
      const result = await probeGateway(`http://127.0.0.1:${String(port)}`)
      expect(result.reachable).toBe(true)
    } finally {
      server.close()
    }
  })

  it('reports unreachable for a closed port', async () => {
    const server = createServer()
    const port = await listen(server)
    server.close()
    const result = await probeGateway(`http://127.0.0.1:${String(port)}`, 500)
    expect(result.reachable).toBe(false)
  })
})
