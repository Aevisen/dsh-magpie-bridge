/**
 * 代理行为测试：请求体转发、CSP 剥离、HTML 桥接脚本注入。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { MagpieWebBridge } from '../src/web-bridge.js'

const logger = { debug: () => {}, warn: () => {} }

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as AddressInfo).port
}

describe('proxy behavior', () => {
  const servers: Server[] = []
  const bridges: MagpieWebBridge[] = []

  afterEach(() => {
    for (const bridge of bridges) bridge.dispose()
    bridges.length = 0
    for (const server of servers) server.close()
    servers.length = 0
  })

  it('forwards POST bodies and strips framing headers while injecting the bridge script', async () => {
    let seenBody = ''
    let seenCookie = ''
    const upstream = createServer((request, response) => {
      seenCookie = request.headers['cookie'] ?? ''
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        seenBody = Buffer.concat(chunks).toString('utf8')
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "frame-ancestors 'self'",
          'x-frame-options': 'SAMEORIGIN',
          'set-cookie': 'session=secret; Path=/',
        })
        response.end('<html><body><p>ok</p></body></html>')
      })
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)

    const bridge = new MagpieWebBridge({
      binary: undefined,
      key: 'a'.repeat(20),
      host: '127.0.0.1',
      preferredPort: 3480,
      proxyPort: 45991,
      logger,
    })
    bridges.push(bridge)
    const proxy = await bridge.attachProxy({ host: '127.0.0.1', port: upstreamPort, cookie: 'session=secret' })

    const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello-body',
    })
    const html = await response.text()

    expect(seenBody).toBe('hello-body')
    expect(seenCookie).toBe('session=secret')
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(response.headers.get('x-frame-options')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(html).toContain('dsh-magpie')
    expect(html).toContain('</body>')
  })

  it('re-logs-in and retries once when the upstream rejects the cookie', async () => {
    let seenCookie = ''
    let hits = 0
    const upstream = createServer((request, response) => {
      const url = request.url ?? '/'
      request.resume()
      if (url.startsWith('/?k=')) {
        response.writeHead(303, { 'set-cookie': 'magpie_web_x=fresh; Path=/' })
        response.end()
        return
      }
      hits += 1
      if (hits === 1) {
        response.writeHead(401, { 'content-type': 'text/plain' })
        response.end('key mismatch')
        return
      }
      seenCookie = request.headers['cookie'] ?? ''
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><body>ok</body></html>')
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)

    const bridge = new MagpieWebBridge({
      binary: undefined,
      key: 'k'.repeat(20),
      host: '127.0.0.1',
      preferredPort: 3480,
      proxyPort: 45992,
      logger,
    })
    bridges.push(bridge)
    const proxy = await bridge.attachProxy({
      host: '127.0.0.1',
      port: upstreamPort,
      cookie: 'magpie_web_x=stale',
    })

    const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('ok')
    expect(seenCookie).toBe('magpie_web_x=fresh')
  })
})
