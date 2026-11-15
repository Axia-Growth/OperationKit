import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import { createCsrfGuard, csrfVerdict, normalizeOrigin } from './csrf-guard.js'

// obj 900838: a cookie-authenticated write must come from this app's own origin.

const ALLOWED = new Set(['https://cc.example.com', 'http://localhost:5173'])
const post = (over: Partial<Parameters<typeof csrfVerdict>[0]> = {}) =>
  csrfVerdict({ method: 'POST', hasSessionCookie: true, host: 'cc.example.com', ...over }, ALLOWED)

describe('csrfVerdict', () => {
  it('never checks safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(csrfVerdict({ method, hasSessionCookie: true, origin: 'https://evil.example' }, ALLOWED)).toEqual({ ok: true, reason: 'safe_method' })
    }
  })

  it('ignores requests that do not ride the session cookie (bearer / key / session token / webhooks)', () => {
    expect(post({ hasSessionCookie: false, origin: 'https://evil.example', secFetchSite: 'cross-site' }))
      .toEqual({ ok: true, reason: 'no_session_cookie' })
  })

  it('allows Fetch-Metadata same-origin and user navigation', () => {
    expect(post({ secFetchSite: 'same-origin' }).ok).toBe(true)
    expect(post({ secFetchSite: 'none' }).ok).toBe(true)
  })

  it('allows an allowlisted Origin and an Origin naming this very host', () => {
    expect(post({ secFetchSite: 'same-site', origin: 'http://localhost:5173' })).toEqual({ ok: true, reason: 'origin_allowed' })
    expect(post({ origin: 'https://CC.example.com/' })).toEqual({ ok: true, reason: 'origin_allowed' })
    expect(post({ origin: 'https://board.client.test', host: 'board.client.test' })).toEqual({ ok: true, reason: 'origin_same_host' })
  })

  it('refuses a cross-site or sibling-subdomain Origin, and Origin: null', () => {
    expect(post({ secFetchSite: 'cross-site', origin: 'https://evil.example' })).toEqual({ ok: false, reason: 'origin_not_allowed' })
    // SameSite=Strict lets a sibling subdomain through; this guard does not.
    expect(post({ secFetchSite: 'same-site', origin: 'https://other.example.com' })).toEqual({ ok: false, reason: 'origin_not_allowed' })
    expect(post({ origin: 'null' })).toEqual({ ok: false, reason: 'origin_null' })
    expect(post({ origin: 'javascript:alert(1)' })).toEqual({ ok: false, reason: 'origin_not_allowed' })
  })

  it('refuses a browser-flagged cross-site write with no Origin; allows a non-browser client with neither header', () => {
    expect(post({ secFetchSite: 'cross-site' })).toEqual({ ok: false, reason: 'cross_site_without_origin' })
    expect(post({ secFetchSite: 'same-site' })).toEqual({ ok: false, reason: 'cross_site_without_origin' })
    expect(post({})).toEqual({ ok: true, reason: 'non_browser_client' })
  })

  it('normalizeOrigin keeps scheme + host + port only', () => {
    expect(normalizeOrigin('https://CC.example.com:8443/path?q')).toBe('https://cc.example.com:8443')
    expect(normalizeOrigin('ftp://x')).toBeNull()
    expect(normalizeOrigin('not a url')).toBeNull()
  })
})

describe('createCsrfGuard (mounted)', () => {
  let server!: http.Server
  let port = 0

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use(createCsrfGuard(['https://cc.example.com'], {}))
    app.post('/api/thing', (_req, res) => { res.json({ ok: true }) })
    app.get('/api/thing', (_req, res) => { res.json({ ok: true }) })
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    port = addr.port
  })
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

  // http.request, not fetch: fetch may rewrite Origin / Sec-Fetch-* itself.
  const send = (method: string, headers: Record<string, string>) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/thing', method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || '{}') }))
    })
    req.on('error', reject)
    req.end(method === 'GET' ? undefined : '{}')
  })

  it('403s a cookie-authenticated cross-site POST', async () => {
    const r = await send('POST', { cookie: 'token=abc', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('csrf_origin_mismatch')
  })

  it('lets the same POST through from the app origin, without the cookie, or as a GET', async () => {
    expect((await send('POST', { cookie: 'token=abc', origin: 'https://cc.example.com', 'sec-fetch-site': 'same-site' })).status).toBe(200)
    expect((await send('POST', { cookie: 'token=abc', 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect((await send('POST', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', authorization: 'Bearer cc_live_x' })).status).toBe(200)
    expect((await send('GET', { cookie: 'token=abc', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(200)
  })

  it('is a no-op when switched off', async () => {
    const off = createCsrfGuard([], { CC_CSRF_GUARD: 'off' })
    let called = false
    off({ method: 'POST', cookies: { token: 'x' }, headers: { origin: 'https://evil.example' } } as never, {} as never, () => { called = true })
    expect(called).toBe(true)
  })
})
