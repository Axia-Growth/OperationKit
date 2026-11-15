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
 *
 * ## Built on express-rate-limit (obj 900855)
 *
 * The middleware itself is `express-rate-limit`; the budget rule above lives in
 * `FixedWindowStore`, its pluggable store, so the window, the keying and the
 * sweep are what they were. Why the library and not the hand-rolled middleware
 * that shipped in obj 900838: CodeQL's `js/missing-rate-limiting` recognises
 * only the named limiter packages, so the in-house middleware left ~310 alerts
 * open on the public repo even though every `/api/*` route was already behind
 * it, and those alerts kept resurfacing as "new" on large sync PRs. On the
 * library, the existing control is one the scanner can see. No route changes
 * behaviour. Two small differences: a `RateLimit-Reset` header is now sent
 * with the other two, and an IPv6 caller with no credential is keyed by its
 * /56 (`ipKeyGenerator`), so it cannot mint a fresh budget per address.
 */
import crypto from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { ipKeyGenerator, rateLimit, type IncrementResponse, type Options, type Store } from 'express-rate-limit'
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
  // ipKeyGenerator leaves IPv4 as-is and groups IPv6 by /56.
  const addr = req.ip || req.socket?.remoteAddress
  return `ip:${addr ? ipKeyGenerator(addr) : 'unknown'}`
}

interface Bucket { windowStart: number; count: number }

/**
 * The budget rule as an express-rate-limit store: a fixed window per key that
 * starts at the key's first request, swept once the map grows large. The clock
 * is injectable so tests can step time without fake timers.
 */
export class FixedWindowStore implements Store {
  readonly localKeys = true
  private readonly buckets = new Map<string, Bucket>()
  private windowMs = WINDOW_MS
  private readonly now: () => number

  constructor(now: () => number = Date.now) { this.now = now }

  init(options: Options): void { this.windowMs = options.windowMs }

  private live(key: string, t: number): Bucket | undefined {
    const b = this.buckets.get(key)
    return b && t - b.windowStart < this.windowMs ? b : undefined
  }

  get(key: string): IncrementResponse | undefined {
    const b = this.live(key, this.now())
    return b ? { totalHits: b.count, resetTime: new Date(b.windowStart + this.windowMs) } : undefined
  }

  increment(key: string): IncrementResponse {
    const t = this.now()
    if (this.buckets.size > SWEEP_THRESHOLD) {
      for (const [k, b] of this.buckets) if (t - b.windowStart >= this.windowMs) this.buckets.delete(k)
    }
    let b = this.live(key, t)
    if (!b) {
      b = { windowStart: t, count: 0 }
      this.buckets.set(key, b)
    }
    b.count++
    return { totalHits: b.count, resetTime: new Date(b.windowStart + this.windowMs) }
  }

  decrement(key: string): void {
    const b = this.buckets.get(key)
    if (b && b.count > 0) b.count--
  }

  resetKey(key: string): void { this.buckets.delete(key) }

  resetAll(): void { this.buckets.clear() }

  /** For tests: how many keys are tracked. */
  get size(): number { return this.buckets.size }
}

export interface ApiRateLimiter {
  (req: Request, res: Response, next: NextFunction): Promise<void> | void
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
  const store = new FixedWindowStore(now)

  const apiRateLimit = rateLimit({
    windowMs: WINDOW_MS,
    // express-rate-limit treats 0 as "refuse everything"; ours means "off",
    // which `skip` handles, so the value passed here is never 0.
    limit: Math.max(1, limit),
    store,
    keyGenerator: (req: Request) => rateLimitKey(req),
    skip: (req: Request) => limit <= 0 || exempt(req),
    // RateLimit-Limit / -Remaining / -Reset on every response; no legacy X-RateLimit-*.
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      const resetAt = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime?.getTime() ?? now() + WINDOW_MS
      const retryAfter = Math.max(1, Math.ceil((resetAt - now()) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      res.status(429).json({ error: 'Too many requests — slow down and retry shortly.', code: 'rate_limited', retry_after_sec: retryAfter })
    },
  }) as unknown as ApiRateLimiter
  apiRateLimit.reset = () => store.resetAll()
  return apiRateLimit
}
