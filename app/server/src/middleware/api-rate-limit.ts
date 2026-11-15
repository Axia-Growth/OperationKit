/**
 * Per-client request budget for `/api/*` (obj 900838).
 *
 * ## Why this exists
 *
 * Before this, the only limiter was the login brute-force guard
 * (middleware/login-rate-limit.ts). Every other route — file reads under
 * /api/docs, KB search, agent chat, the MCP endpoint — would serve an
 * authenticated client (or a leaked key) as fast as it could ask. CodeQL
 * (js/missing-rate-limiting) flagged ~45 such handlers. This is the floor: a
 * fixed-window budget per caller, generous enough that the board UI, a busy
 * agent key or an MCP client never meets it, small enough that one runaway
 * client cannot starve the box.
 *
 * ## The rule
 *
 *   - Key = the credential the request carries (session cookie, bearer token,
 *     `X-CC-Session-Token`), hashed — so several people behind one proxy or NAT
 *     do not share a budget — else the client IP (`req.ip`, which honours the
 *     `trust proxy` hop allowlist in index.ts).
 *   - On-box callers are exempt: the internal API, card sessions and the MCP
 *     server forwarding tool calls over loopback all come from a trusted peer
 *     (`isLocalhost`, the same non-spoofable socket check the internal gate uses).
 *   - Over budget → 429 with `Retry-After` (seconds) and `code: 'rate_limited'`.
 *
 * Config (env, read once at mount): `CC_API_RATE_LIMIT_PER_MIN` (default 1200
 * per key per minute; `0` switches the limiter off).
 */
import crypto from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { isLocalhost } from '../lib/is-localhost.js'

export const DEFAULT_API_RATE_LIMIT_PER_MIN = 1200
const WINDOW_MS = 60_000
/** Above this many tracked keys, expired windows are swept on the next request. */
const SWEEP_THRESHOLD = 10_000

export function apiRateLimitPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CC_API_RATE_LIMIT_PER_MIN
  if (raw === undefined || raw.trim() === '') return DEFAULT_API_RATE_LIMIT_PER_MIN
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_API_RATE_LIMIT_PER_MIN
}

function headerValue(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** Which budget a request draws from. The credential itself is never stored, only a hash. */
export function rateLimitKey(req: Request): string {
  const cred = (req.cookies?.token as string | undefined)
    || headerValue(req, 'authorization')
    || headerValue(req, 'x-cc-session-token')
  if (cred) return `c:${crypto.createHash('sha256').update(cred).digest('base64url').slice(0, 24)}`
  return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`
}

interface Bucket { windowStart: number; count: number }

export interface ApiRateLimiter {
  (req: Request, res: Response, next: NextFunction): void
  /** For tests: forget every bucket. */
  reset(): void
}

export function createApiRateLimiter(opts: {
  limitPerMinute?: number
  now?: () => number
  exempt?: (req: Request) => boolean
} = {}): ApiRateLimiter {
  const limit = opts.limitPerMinute ?? apiRateLimitPerMinute()
  const now = opts.now ?? Date.now
  const exempt = opts.exempt ?? isLocalhost
  const buckets = new Map<string, Bucket>()

  const apiRateLimit = function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (limit <= 0 || exempt(req)) { next(); return }
    const t = now()
    if (buckets.size > SWEEP_THRESHOLD) {
      for (const [k, b] of buckets) if (t - b.windowStart >= WINDOW_MS) buckets.delete(k)
    }
    const key = rateLimitKey(req)
    let b = buckets.get(key)
    if (!b || t - b.windowStart >= WINDOW_MS) {
      b = { windowStart: t, count: 0 }
      buckets.set(key, b)
    }
    b.count++
    res.setHeader('RateLimit-Limit', String(limit))
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - b.count)))
    if (b.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - t) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      res.status(429).json({ error: 'Too many requests — slow down and retry shortly.', code: 'rate_limited', retry_after_sec: retryAfter })
      return
    }
    next()
  } as ApiRateLimiter
  apiRateLimit.reset = () => buckets.clear()
  return apiRateLimit
}
