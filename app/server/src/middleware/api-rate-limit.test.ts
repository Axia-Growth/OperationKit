import { describe, it, expect, afterEach } from 'vitest'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { apiRateLimitPerMinute, createApiRateLimiter, DEFAULT_API_RATE_LIMIT_PER_MIN, FixedWindowStore, rateLimitKey } from './api-rate-limit.js'

// obj 900838: every off-box caller gets a per-credential request budget.
// obj 900855: the middleware is now express-rate-limit (so CodeQL can see it);
// these tests pin that the budget rule did not change.

function fakeReq(over: { cookie?: string; auth?: string; ip?: string } = {}): Request {
  return {
    method: 'GET',
    cookies: over.cookie ? { token: over.cookie } : {},
    headers: over.auth ? { authorization: over.auth } : {},
    ip: over.ip ?? '203.0.113.7',
    socket: { remoteAddress: over.ip ?? '203.0.113.7' },
    app: { get: () => false },
  } as unknown as Request
}

function fakeRes() {
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v) },
    getHeader(k: string) { return headers[k.toLowerCase()] },
    append(k: string, v: string) { headers[k.toLowerCase()] = String(v) },
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
    send(b: unknown) { this.body = b; return this },
    on() { return this },
  }
  return { res: res as unknown as Response & typeof res, headers }
}

async function hit(limiter: ReturnType<typeof createApiRateLimiter>, req: Request) {
  const { res, headers } = fakeRes()
  let passed = false
  await limiter(req, res, () => { passed = true })
  return { passed, status: res.statusCode, headers, body: res.body as Record<string, unknown> | undefined }
}

describe('createApiRateLimiter', () => {
  it('allows up to the limit per window, then 429s with Retry-After, then resets', async () => {
    let t = 1_000_000
    const lim = createApiRateLimiter({ limitPerMinute: 3, now: () => t, exempt: () => false })
    const req = fakeReq({ cookie: 'session-a' })
    const first3 = []
    for (let i = 0; i < 3; i++) first3.push((await hit(lim, req)).passed)
    expect(first3).toEqual([true, true, true])
    const over = await hit(lim, req)
    expect(over.passed).toBe(false)
    expect(over.status).toBe(429)
    expect(over.body?.code).toBe('rate_limited')
    expect(over.body?.retry_after_sec).toBe(60)
    expect(over.headers['retry-after']).toBe('60')
    t += 30_000
    const later = await hit(lim, req)
    expect(later.passed).toBe(false)
    expect(later.headers['retry-after']).toBe('30')
    t += 30_000
    expect((await hit(lim, req)).passed).toBe(true)
  })

  it('sends the standard RateLimit headers on an allowed request', async () => {
    const lim = createApiRateLimiter({ limitPerMinute: 5, exempt: () => false })
    const r = await hit(lim, fakeReq({ cookie: 'hdr' }))
    expect(r.passed).toBe(true)
    expect(r.headers['ratelimit-limit']).toBe('5')
    expect(r.headers['ratelimit-remaining']).toBe('4')
    expect(r.headers['x-ratelimit-limit']).toBeUndefined()
  })

  it('keys by credential, so two sessions behind one IP do not share a budget', async () => {
    const lim = createApiRateLimiter({ limitPerMinute: 1, now: () => 5, exempt: () => false })
    expect((await hit(lim, fakeReq({ cookie: 'a' }))).passed).toBe(true)
    expect((await hit(lim, fakeReq({ cookie: 'b' }))).passed).toBe(true)
    expect((await hit(lim, fakeReq({ cookie: 'a' }))).passed).toBe(false)
    expect((await hit(lim, fakeReq({ ip: '198.51.100.1' }))).passed).toBe(true)
    expect((await hit(lim, fakeReq({ ip: '198.51.100.1' }))).passed).toBe(false)
  })

  it('never limits an exempt (on-box) caller, and limit 0 switches it off', async () => {
    const exempt = createApiRateLimiter({ limitPerMinute: 1, exempt: () => true })
    for (let i = 0; i < 5; i++) expect((await hit(exempt, fakeReq())).passed).toBe(true)
    const off = createApiRateLimiter({ limitPerMinute: 0, exempt: () => false })
    for (let i = 0; i < 5; i++) expect((await hit(off, fakeReq())).passed).toBe(true)
  })

  it('reset() forgets every bucket', async () => {
    const lim = createApiRateLimiter({ limitPerMinute: 1, now: () => 5, exempt: () => false })
    expect((await hit(lim, fakeReq({ cookie: 'r' }))).passed).toBe(true)
    expect((await hit(lim, fakeReq({ cookie: 'r' }))).passed).toBe(false)
    lim.reset()
    expect((await hit(lim, fakeReq({ cookie: 'r' }))).passed).toBe(true)
  })

  it('never stores the raw credential in the key', () => {
    const key = rateLimitKey(fakeReq({ auth: 'Bearer cc_live_supersecret' }))
    expect(key.startsWith('c:')).toBe(true)
    expect(key).not.toContain('supersecret')
    expect(rateLimitKey(fakeReq({ ip: '192.0.2.9' }))).toBe('ip:192.0.2.9')
  })

  it('groups IPv6 callers with no credential by /56', () => {
    const a = rateLimitKey(fakeReq({ ip: '2001:db8:abcd:1200::1' }))
    const b = rateLimitKey(fakeReq({ ip: '2001:db8:abcd:12ff:ffff::2' }))
    const c = rateLimitKey(fakeReq({ ip: '2001:db8:abcd:1300::1' }))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(rateLimitKey(fakeReq({ ip: '::ffff:192.0.2.9' }))).toBe('ip:192.0.2.9')
  })

  it('reads CC_API_RATE_LIMIT_PER_MIN', () => {
    expect(apiRateLimitPerMinute({})).toBe(DEFAULT_API_RATE_LIMIT_PER_MIN)
    expect(apiRateLimitPerMinute({ CC_API_RATE_LIMIT_PER_MIN: '0' })).toBe(0)
    expect(apiRateLimitPerMinute({ CC_API_RATE_LIMIT_PER_MIN: '300' })).toBe(300)
    expect(apiRateLimitPerMinute({ CC_API_RATE_LIMIT_PER_MIN: 'lots' })).toBe(DEFAULT_API_RATE_LIMIT_PER_MIN)
  })
})

describe('FixedWindowStore', () => {
  it('sweeps expired windows once it tracks more than 10k keys', () => {
    let t = 0
    const store = new FixedWindowStore(() => t)
    for (let i = 0; i <= 10_000; i++) store.increment(`k${i}`)
    expect(store.size).toBe(10_001)
    t = 60_000
    store.increment('fresh')
    expect(store.size).toBe(1)
  })

  it('decrement never goes below zero and get() reports the live window only', () => {
    let t = 0
    const store = new FixedWindowStore(() => t)
    store.increment('k')
    store.decrement('k')
    store.decrement('k')
    expect(store.get('k')?.totalHits).toBe(0)
    t = 60_000
    expect(store.get('k')).toBeUndefined()
  })
})

describe('createApiRateLimiter on a real Express app', () => {
  let server: Server | undefined
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())))

  it('429s the request past the budget with the JSON body and Retry-After', async () => {
    const app = express()
    app.use(createApiRateLimiter({ limitPerMinute: 2, exempt: () => false }))
    app.get('/api/ping', (_req, res) => { res.json({ ok: true }) })
    server = app.listen(0)
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/api/ping`
    const h = { authorization: 'Bearer test-key' }
    expect((await fetch(url, { headers: h })).status).toBe(200)
    expect((await fetch(url, { headers: h })).status).toBe(200)
    const over = await fetch(url, { headers: h })
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await over.json()).toMatchObject({ code: 'rate_limited' })
    // A different credential has its own budget.
    expect((await fetch(url, { headers: { authorization: 'Bearer other' } })).status).toBe(200)
  })
})
