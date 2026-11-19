/**
 * 代理行为测试：请求体转发、CSP 剥离、HTML 桥接脚本注入。
 */
import { createServer, get, type Server } from 'node:http'
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

    const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, { headers: { accept: 'text/html' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('ok')
    expect(seenCookie).toBe('magpie_web_x=fresh')
  })

  it('explains a rejected Web key in Chinese without relaying the upstream form', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'text/html' }).end('<form>Paste the key</form>')
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const bridge = new MagpieWebBridge({
      binary: undefined,
      existingWebURL: `http://127.0.0.1:${upstreamPort}`,
      key: 'w'.repeat(24),
      host: '127.0.0.1',
      preferredPort: 3480,
      proxyPort: 45994,
      logger,
    })
    bridges.push(bridge)
    await expect(bridge.ensure()).rejects.toThrow(/启动链接.*webKey/)
    const proxy = await bridge.attachProxy({ host: '127.0.0.1', port: upstreamPort, cookie: 'stale=1' })
    const response = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { accept: 'text/html' } })
    expect(response.status).toBe(401)
    const page = await response.text()
    expect(page).toContain('启动链接')
    expect(page).toContain('webKey')
    expect(page).not.toContain('<form>')
  })

  it('refuses a cross-site browser request before it reaches Magpie', async () => {
    let reached = false
    const upstream = createServer((_request, response) => {
      reached = true
      response.end('secret')
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const bridge = new MagpieWebBridge({
      binary: undefined,
      key: 'w'.repeat(24),
      host: '127.0.0.1',
      preferredPort: 3480,
      proxyPort: 45995,
      logger,
    })
    bridges.push(bridge)
    const proxy = await bridge.attachProxy({ host: '127.0.0.1', port: upstreamPort, cookie: 'session=secret' })
    const response = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      headers: { 'sec-fetch-site': 'cross-site', accept: 'text/html' },
    })
    expect(response.status).toBe(403)
    expect(reached).toBe(false)
  })

  it('logs in again after the configured upstream stops and returns', async () => {
    const key = 'w'.repeat(24)
    const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
      if (request.url === `/?k=${key}`) {
        response.writeHead(303, { 'set-cookie': 'magpie_web_test=connected; Path=/' }).end()
      } else if (request.headers.cookie === 'magpie_web_test=connected') {
        response.end('configured upstream')
      } else {
        response.writeHead(401).end()
      }
    }
    const upstream = createServer(handler)
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const bridge = new MagpieWebBridge({
      binary: undefined,
      existingWebURL: `http://127.0.0.1:${upstreamPort}`,
      key,
      host: '127.0.0.1',
      preferredPort: 3480,
      proxyPort: 45996,
      logger,
    })
    bridges.push(bridge)
    await bridge.ensure()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await expect(bridge.ensure()).rejects.toThrow()
    const restored = createServer(handler)
    servers.push(restored)
    await new Promise<void>((resolve) => restored.listen(upstreamPort, '127.0.0.1', () => resolve()))
    const handle = await bridge.ensure()
    expect(await (await fetch(handle.url, { headers: { accept: 'text/html' } })).text()).toBe('configured upstream')
  })

  it('connects to the configured local Web listener without a Magpie binary', async () => {
    const key = 'w'.repeat(24)
    const upstream = createServer((request, response) => {
      if (request.url === `/?k=${key}`) {
        response.writeHead(303, { 'set-cookie': 'magpie_web_test=connected; Path=/' }).end()
      } else if (request.headers.cookie === 'magpie_web_test=connected') {
        response.end('configured upstream')
      } else {
        response.writeHead(401).end()
      }
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const bridge = new MagpieWebBridge({
      binary: undefined,
      existingWebURL: `http://127.0.0.1:${upstreamPort}`,
      key,
      host: '127.0.0.1',
      preferredPort: 3480,
      proxyPort: 45993,
      logger,
    })
    bridges.push(bridge)
    const handle = await bridge.ensure()
    expect(handle.upstreamPort).toBe(upstreamPort)
    expect(handle.pid).toBeUndefined()
    const desktopHeaders = {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'iframe',
    }
    const navigate = (url: string | URL) => new Promise<{ status?: number; text: string }>((resolve, reject) => {
      get(url, { headers: desktopHeaders }, async (response) => {
        try {
          let text = ''
          for await (const chunk of response) text += chunk.toString()
          resolve({ status: response.statusCode, text })
        } catch (error) {
          reject(error)
        }
      }).on('error', reject)
    })
    expect(await navigate(handle.url)).toEqual({ status: 200, text: 'configured upstream' })
    expect((await navigate(new URL('/', handle.url))).status).toBe(403)
    const api = new URL(handle.url)
    api.pathname = '/api/state'
    expect((await navigate(api)).status).toBe(403)
  })

})
