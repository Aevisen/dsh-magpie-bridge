/**
 * 代理行为测试：请求体转发、CSP 剥离、HTML 桥接脚本注入。
 */
import { createServer, get, request, type Server } from 'node:http'
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

  async function session(url: string): Promise<string> {
    const response = await fetch(url)
    const cookie = response.headers.getSetCookie()[0]
    await response.body?.cancel()
    expect(cookie).toContain('HttpOnly; Secure; SameSite=None; Partitioned')
    return cookie!.split(';')[0]!
  }

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

    const cookie = await session(proxy.url)
    const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie },
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

  it('forwards a partial upload before the browser ends the request', async () => {
    let onFirstChunk: () => void = () => {}
    const firstChunk = new Promise<void>((resolve) => { onFirstChunk = resolve })
    const upstream = createServer((req, res) => {
      if (req.method === 'GET') return res.end('ready')
      req.once('data', onFirstChunk)
      req.on('end', () => res.end('uploaded'))
    })
    servers.push(upstream)
    const port = await listen(upstream)
    const bridge = new MagpieWebBridge({ binary: undefined, key: 'a'.repeat(20), host: '127.0.0.1', preferredPort: 3480, proxyPort: 45997, logger })
    bridges.push(bridge)
    const proxy = await bridge.attachProxy({ host: '127.0.0.1', port, cookie: 'session=secret' })
    const cookie = await session(proxy.url)
    const upload = request(new URL('/upload', proxy.url), { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(2_000) })
    const result = new Promise<number | undefined>((resolve, reject) => {
      upload.once('error', reject)
      upload.once('response', (res) => { res.resume(); resolve(res.statusCode) })
    })
    upload.write('first')
    await Promise.race([firstChunk, result.then(() => { throw new Error('upload ended too soon') })])
    upload.end('second')
    expect(await result).toBe(200)
  })

  it('rejects oversized HTML before rewriting it', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('x'.repeat(4 * 1024 * 1024 + 1))
    })
    servers.push(upstream)
    const port = await listen(upstream)
    const bridge = new MagpieWebBridge({ binary: undefined, key: 'a'.repeat(20), host: '127.0.0.1', preferredPort: 3480, proxyPort: 45999, logger })
    bridges.push(bridge)
    const proxy = await bridge.attachProxy({ host: '127.0.0.1', port, cookie: 'session=secret' })
    const page = await fetch(proxy.url)
    expect(page.status).toBe(502)
    expect(await page.text()).toContain('超过代理大小限制')
  })

  it('preserves UTF-8 Chinese on a failed Magpie login and on upstream errors', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' }).end('magpie web 无响应')
    })
    servers.push(upstream)
    const port = await listen(upstream)
    const bridge = new MagpieWebBridge({ binary: undefined, key: 'a'.repeat(20), host: '127.0.0.1', preferredPort: 3480, proxyPort: 46001, logger })
    bridges.push(bridge)
    const proxy = await bridge.attachProxy({ host: '127.0.0.1', port, cookie: 'session=secret' })
    const response = await fetch(proxy.url)
    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('charset=utf-8')
    expect(await response.text()).toContain('magpie web 无响应')
  })

  it('requires the proxy session for a WebSocket upgrade', async () => {
    let upgradeCookie: string | undefined
    const upstream = createServer((_req, res) => res.end('ready'))
    upstream.on('upgrade', (req, socket) => {
      upgradeCookie = req.headers.cookie
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    })
    servers.push(upstream)
    const port = await listen(upstream)
    const bridge = new MagpieWebBridge({ binary: undefined, key: 'a'.repeat(20), host: '127.0.0.1', preferredPort: 3480, proxyPort: 45998, logger })
    bridges.push(bridge)
    const proxy = await bridge.attachProxy({ host: '127.0.0.1', port, cookie: 'session=secret' })
    const upgrade = (cookie?: string) => new Promise<number | undefined>((resolve, reject) => {
      const url = new URL('/socket', proxy.url)
      const req = request(url, {
        headers: { origin: url.origin, connection: 'Upgrade', upgrade: 'websocket', ...(cookie ? { cookie } : {}) },
        signal: AbortSignal.timeout(2_000),
      })
      req.once('error', reject)
      req.once('response', (res) => { res.resume(); resolve(res.statusCode) })
      req.once('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode) })
      req.end()
    })
    expect(await upgrade()).toBe(403)
    expect(upgradeCookie).toBeUndefined()
    expect(await upgrade(await session(proxy.url))).toBe(101)
    expect(upgradeCookie).toBe('session=secret')
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

    const response = await fetch(proxy.url, { headers: { accept: 'text/html' } })
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
    const response = await fetch(proxy.url, { headers: { accept: 'text/html' } })
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
    expect((await fetch(new URL('/', proxy.url))).status).toBe(403)
    expect((await fetch(new URL('/api/state', proxy.url), { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403)
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
    const cookie = await session(handle.url)
    const cleanApi = new URL('/api/state', handle.url)
    expect((await fetch(cleanApi, { headers: { cookie, 'sec-fetch-site': 'same-site' } })).status).toBe(403)
    expect(await (await fetch(cleanApi, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).text()).toBe('configured upstream')
  })

})
