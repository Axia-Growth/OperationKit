import { describe, it, expect } from 'vitest'
import type { Request, Response } from 'express'
import { apiRateLimitPerMinute, createApiRateLimiter, DEFAULT_API_RATE_LIMIT_PER_MIN, rateLimitKey } from './api-rate-limit.js'

// obj 900838: every off-box caller gets a per-credential request budget.

function fakeReq(over: { cookie?: string; auth?: string; ip?: string } = {}): Request {
  return {
    cookies: over.cookie ? { token: over.cookie } : {},
    headers: over.auth ? { authorization: over.auth } : {},
    ip: over.ip ?? '203.0.113.7',
    socket: { remoteAddress: over.ip ?? '203.0.113.7' },
  } as unknown as Request
}

function fakeRes() {
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v },
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
  return { res: res as unknown as Response & typeof res, headers }
}

function hit(limiter: ReturnType<typeof createApiRateLimiter>, req: Request) {
  const { res, headers } = fakeRes()
  let passed = false
  limiter(req, res, () => { passed = true })
  return { passed, status: res.statusCode, headers, body: res.body as Record<string, unknown> | undefined }
}

describe('createApiRateLimiter', () => {
  it('allows up to the limit per window, then 429s with Retry-After, then resets', () => {
    let t = 1_000_000
    const lim = createApiRateLimiter({ limitPerMinute: 3, now: () => t, exempt: () => false })
    const req = fakeReq({ cookie: 'session-a' })
    expect([1, 2, 3].map(() => hit(lim, req).passed)).toEqual([true, true, true])
    const over = hit(lim, req)
    expect(over.passed).toBe(false)
    expect(over.status).toBe(429)
    expect(over.body?.code).toBe('rate_limited')
    expect(over.headers['retry-after']).toBe('60')
    t += 60_000
    expect(hit(lim, req).passed).toBe(true)
  })

  it('keys by credential, so two sessions behind one IP do not share a budget', () => {
    const lim = createApiRateLimiter({ limitPerMinute: 1, now: () => 5, exempt: () => false })
    expect(hit(lim, fakeReq({ cookie: 'a' })).passed).toBe(true)
    expect(hit(lim, fakeReq({ cookie: 'b' })).passed).toBe(true)
    expect(hit(lim, fakeReq({ cookie: 'a' })).passed).toBe(false)
    expect(hit(lim, fakeReq({ ip: '198.51.100.1' })).passed).toBe(true)
    expect(hit(lim, fakeReq({ ip: '198.51.100.1' })).passed).toBe(false)
  })

  it('never limits an exempt (on-box) caller, and limit 0 switches it off', () => {
    const exempt = createApiRateLimiter({ limitPerMinute: 1, exempt: () => true })
    for (let i = 0; i < 5; i++) expect(hit(exempt, fakeReq()).passed).toBe(true)
    const off = createApiRateLimiter({ limitPerMinute: 0, exempt: () => false })
    for (let i = 0; i < 5; i++) expect(hit(off, fakeReq()).passed).toBe(true)
  })

  it('never stores the raw credential in the key', () => {
    const key = rateLimitKey(fakeReq({ auth: 'Bearer cc_live_supersecret' }))
    expect(key.startsWith('c:')).toBe(true)
    expect(key).not.toContain('supersecret')
    expect(rateLimitKey(fakeReq({ ip: '192.0.2.9' }))).toBe('ip:192.0.2.9')
  })

  it('reads CC_API_RATE_LIMIT_PER_MIN', () => {
    expect(apiRateLimitPerMinute({})).toBe(DEFAULT_API_RATE_LIMIT_PER_MIN)
    expect(apiRateLimitPerMinute({ CC_API_RATE_LIMIT_PER_MIN: '0' })).toBe(0)
    expect(apiRateLimitPerMinute({ CC_API_RATE_LIMIT_PER_MIN: '300' })).toBe(300)
    expect(apiRateLimitPerMinute({ CC_API_RATE_LIMIT_PER_MIN: 'lots' })).toBe(DEFAULT_API_RATE_LIMIT_PER_MIN)
  })
})
