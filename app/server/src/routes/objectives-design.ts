/**
 * Design-review frame — proxies a preview URL through Command Center so the
 * canvas iframe can host an injected click/text overlay (Claude Design-style).
 */
import type { Router } from 'express'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import type { Objective } from '@operationkit/shared'
import { canReadObjective } from './objectives-helpers.js'
import { DESIGN_FRAME_CSP } from '../middleware/security-headers.js'
import {
  parsePreviewUrl,
  rewriteDesignHtml,
  frameErrorPage,
} from '../lib/design-frame.js'
import { BlockedUrlError, createSafeFetch, type SafeFetch } from '../mcp-servers/safe-fetch.js'

const FETCH_MS = 12_000
const MAX_BYTES = 1_500_000

/**
 * The preview fetch goes through the SSRF-guarded fetch (obj 900838, CodeQL #74).
 * `parsePreviewUrl` only looks at the host NAME, so on its own it let through a
 * public name that resolves to a private address (`127.0.0.1.nip.io`), IPv6
 * forms it does not list, and — via `redirect: 'follow'` — any redirect to
 * 169.254.169.254 or loopback, whose body was then sent back to the caller.
 * `createSafeFetch` re-validates every redirect hop and checks the resolved
 * address at connect time. http is allowed (preview servers often are plain
 * http); private, link-local, metadata and loopback addresses are not.
 */
export function createDesignFramePreviewFetch(): SafeFetch {
  return createSafeFetch({
    allowHttp: true,
    timeoutMs: FETCH_MS,
    maxBodyBytes: MAX_BYTES,
    maxRedirects: 5,
    // Loopback is never a preview target here, not even in dev/test (the old
    // host check always refused localhost; the MCP guard would otherwise allow
    // it when NODE_ENV is development/test).
    env: { CC_MCP_ALLOW_LOCALHOST: '0' },
  })
}
const defaultPreviewFetch: SafeFetch = createDesignFramePreviewFetch()
let previewFetch: SafeFetch = defaultPreviewFetch

/** Tests only: swap the upstream fetch (null restores the guarded default). */
export function setDesignFramePreviewFetchForTests(fn: SafeFetch | null): void {
  previewFetch = fn ?? defaultPreviewFetch
}

function resolveParentOrigin(req: AuthRequest): string {
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim()
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim()
  const inferred = `${proto}://${host}`
  const raw = String(req.query.parent || '')
  try {
    const origin = new URL(raw).origin
    if (origin === inferred || origin === `https://${host}` || origin === `http://${host}`) return origin
  } catch { /* ignore */ }
  return inferred
}

export function registerObjectiveDesignRoutes(router: Router): void {
  router.get('/:id/design-frame', async (req: AuthRequest, res) => {
    const db = getDb()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
    if (!objective) {
      res.status(404).type('html').send(frameErrorPage('Objective not found'))
      return
    }
    if (!canReadObjective(req, objective)) {
      res.status(403).type('html').send(frameErrorPage('You do not have access to this objective'))
      return
    }

    const raw = String(req.query.url || '')
    const parsed = parsePreviewUrl(raw)
    if (!parsed) {
      res.status(400).type('html').send(frameErrorPage('Paste an http(s) preview URL. Private/local hosts are blocked.'))
      return
    }

    const parentOrigin = resolveParentOrigin(req)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS)
    try {
      const upstream = await previewFetch(parsed.href, {
        signal: ctrl.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'CommandCenter-DesignFrame/1',
        },
      })
      const buf = Buffer.from(await upstream.arrayBuffer())
      if (buf.length > MAX_BYTES) {
        res.status(413).type('html').send(frameErrorPage('Preview is larger than 1.5MB — open it in a new tab instead.'))
        return
      }
      const ctype = upstream.headers.get('content-type') || ''
      if (!upstream.ok) {
        res.status(502).type('html').send(frameErrorPage(`Preview returned ${upstream.status}`))
        return
      }
      if (ctype && !/html|xml|text\/plain/i.test(ctype)) {
        res.status(415).type('html').send(frameErrorPage(`Preview is ${ctype}, not HTML.`))
        return
      }
      const html = buf.toString('utf8')
      const rewritten = rewriteDesignHtml(html, { sourceUrl: parsed.href, parentOrigin })
      res.status(200)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.removeHeader('X-Frame-Options')
      res.setHeader('Content-Security-Policy', DESIGN_FRAME_CSP)
      res.send(rewritten)
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        res.status(400).type('html').send(frameErrorPage('That preview resolves to a private or local address. Private/local hosts are blocked.'))
        return
      }
      if (err instanceof Error && /^response larger than/.test(err.message)) {
        res.status(413).type('html').send(frameErrorPage('Preview is larger than 1.5MB — open it in a new tab instead.'))
        return
      }
      const aborted = err instanceof Error && (err.name === 'AbortError' || /aborted|timed out/.test(err.message))
      res.status(502).type('html').send(frameErrorPage(aborted ? 'Preview timed out.' : 'Could not fetch that preview.'))
    } finally {
      clearTimeout(timer)
    }
  })
}
