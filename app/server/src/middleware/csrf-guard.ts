/**
 * CSRF guard for cookie-authenticated, state-changing requests (obj 900838).
 *
 * ## Why this exists
 *
 * The browser session is the httpOnly `token` cookie (routes/auth.ts). It is
 * already `SameSite=Strict`, so a page on another SITE cannot make the browser
 * attach it, and request bodies are parsed as JSON (the only urlencoded parser
 * is the inbound-webhook route, which takes no cookie), so a plain cross-site
 * `<form>` cannot produce a body the API accepts. That is the primary defence and it stays.
 *
 * SameSite has one documented gap: "site" means registrable domain, so a
 * request from a SIBLING subdomain (another `*.example.com` app, or a stale
 * DNS record someone takes over) is same-site and DOES carry the cookie. CodeQL
 * (js/missing-token-validation) also flags `cookieParser()` serving
 * state-changing handlers with no CSRF check at all. This guard closes both:
 * a write that rides the session cookie must come from this app's own origin.
 *
 * ## The rule (OWASP "Fetch Metadata" + "Verifying Origin With Standard Headers")
 *
 *   - Safe methods (GET/HEAD/OPTIONS) are never checked — they must not mutate.
 *   - A request WITHOUT the session cookie is not cookie-authenticated
 *     (bearer JWT, `cc_live_` key, `X-CC-Session-Token`, webhooks, internal
 *     callers). Those credentials are attached explicitly by the caller, which a
 *     cross-site page cannot do, so they are out of scope.
 *   - `Sec-Fetch-Site: same-origin` (or `none`, a user-typed navigation) → allowed.
 *   - Otherwise an `Origin` header must be on the CORS allowlist, or name this
 *     very host (the reverse proxy keeps `Host`). `Origin: null` is refused.
 *   - A browser that says the request is `cross-site`/`same-site` but sends no
 *     Origin is refused. A request with NEITHER header is a non-browser client
 *     (curl with a cookie jar, a script) — no ambient credential to abuse — and
 *     is allowed, so operator tooling keeps working.
 *
 * Kill switch: `CC_CSRF_GUARD=off` (logged at boot by the caller). Refusals are
 * a 403 with `code: 'csrf_origin_mismatch'`.
 */
import type { NextFunction, Request, Response } from 'express'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The session cookie name set by routes/auth.ts. */
export const SESSION_COOKIE = 'token'

export type CsrfVerdict =
  | { ok: true; reason: 'safe_method' | 'no_session_cookie' | 'fetch_metadata_same_origin' | 'origin_allowed' | 'origin_same_host' | 'non_browser_client' }
  | { ok: false; reason: 'origin_null' | 'origin_not_allowed' | 'cross_site_without_origin' }

export interface CsrfRequestFacts {
  method: string
  hasSessionCookie: boolean
  secFetchSite?: string
  origin?: string
  host?: string
}

/** Normalise an origin (`scheme://host[:port]`, lowercase, no trailing slash). Null if unparsable. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.protocol}//${u.host}`.toLowerCase()
  } catch {
    return null
  }
}

/** Pure decision, so the rule is testable without a server. */
export function csrfVerdict(facts: CsrfRequestFacts, allowedOrigins: ReadonlySet<string>): CsrfVerdict {
  if (SAFE_METHODS.has(facts.method.toUpperCase())) return { ok: true, reason: 'safe_method' }
  if (!facts.hasSessionCookie) return { ok: true, reason: 'no_session_cookie' }

  const site = (facts.secFetchSite || '').trim().toLowerCase()
  if (site === 'same-origin' || site === 'none') return { ok: true, reason: 'fetch_metadata_same_origin' }

  const origin = (facts.origin || '').trim()
  if (origin) {
    if (origin.toLowerCase() === 'null') return { ok: false, reason: 'origin_null' }
    const norm = normalizeOrigin(origin)
    if (!norm) return { ok: false, reason: 'origin_not_allowed' }
    if (allowedOrigins.has(norm)) return { ok: true, reason: 'origin_allowed' }
    const host = (facts.host || '').trim().toLowerCase()
    if (host && new URL(norm).host === host) return { ok: true, reason: 'origin_same_host' }
    return { ok: false, reason: 'origin_not_allowed' }
  }

  if (site === 'cross-site' || site === 'same-site') return { ok: false, reason: 'cross_site_without_origin' }
  return { ok: true, reason: 'non_browser_client' }
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** The request carries the verdict so downstream code and tests can see why it passed. */
export interface CsrfCheckedRequest extends Request {
  csrfCheck?: CsrfVerdict
}

export function csrfGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['off', '0', 'false'].includes(String(env.CC_CSRF_GUARD ?? '').trim().toLowerCase())
}

/**
 * Express middleware. Mount AFTER `cookieParser()` (it reads `req.cookies`)
 * and before every router.
 */
export function createCsrfGuard(allowed: string[], env: NodeJS.ProcessEnv = process.env) {
  const allowedOrigins = new Set(allowed.map(normalizeOrigin).filter((o): o is string => !!o))
  const enabled = csrfGuardEnabled(env)
  return function csrfProtection(req: CsrfCheckedRequest, res: Response, next: NextFunction): void {
    if (!enabled) { next(); return }
    const verdict = csrfVerdict({
      method: req.method,
      hasSessionCookie: typeof req.cookies?.[SESSION_COOKIE] === 'string' && req.cookies[SESSION_COOKIE] !== '',
      secFetchSite: header(req, 'sec-fetch-site'),
      origin: header(req, 'origin'),
      host: header(req, 'host'),
    }, allowedOrigins)
    req.csrfCheck = verdict
    if (!verdict.ok) {
      res.status(403).json({ error: 'Cross-site request refused', code: 'csrf_origin_mismatch', reason: verdict.reason })
      return
    }
    next()
  }
}
