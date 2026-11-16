/**
 * POST /api/card-browser/session — a card's browser asks for a short-lived,
 * read-only sign-in to this install's own public site (obj 901106).
 *
 * Credential: the card's own `CC_SESSION_TOKEN` (X-CC-Session-Token). Nothing
 * else is accepted — not a cookie, not an API key — because the session is
 * minted FOR a card and bound to it. See lib/card-browser-session.ts for what
 * the session can and cannot do.
 *
 * The response carries Playwright cookie objects for the public host. The
 * generated launcher (`--sign-in`) adds them to its browser context and never
 * prints them.
 */
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db/index.js'
import { sessionTokenFromHeaders, verifySessionToken } from '../lib/session-trust.js'
import { resolvePublicBaseUrl } from '../lib/public-url.js'
import {
  buildCardBrowserCookies,
  cardBotSlug,
  cardBrowserSignInEnabled,
  cardBrowserUsername,
  checkCardForBrowserSession,
  clampCardBrowserTtl,
  exchangeCfAccessServiceToken,
  mintCardBrowserSession,
  type CfAccessExchange,
} from '../lib/card-browser-session.js'

export interface CardBrowserSessionDeps {
  exchange?: (publicUrl: string) => Promise<CfAccessExchange>
  publicUrl?: () => string
  now?: () => number
}

export function createCardBrowserSessionRouter(deps: CardBrowserSessionDeps = {}): Router {
  const router = Router()
  const exchange = deps.exchange ?? ((u: string) => exchangeCfAccessServiceToken(u))
  const publicUrl = deps.publicUrl ?? (() => resolvePublicBaseUrl())
  const now = deps.now ?? (() => Date.now())

  router.post('/session', async (req: Request, res: Response) => {
    const raw = sessionTokenFromHeaders(req.headers as Record<string, string | string[] | undefined>)
    if (!raw) {
      res.status(401).json({ error: 'A card session token (X-CC-Session-Token) is required', code: 'session_token_required' })
      return
    }
    const claims = verifySessionToken(raw)
    if (!claims) {
      res.status(401).json({ error: 'Invalid or expired session token', code: 'bad_session_token' })
      return
    }
    const db = getDb()
    if (!cardBrowserSignInEnabled(db)) {
      res.status(403).json({ error: 'Card browser sign-in is switched off on this install', code: 'card_browser_sign_in_disabled' })
      return
    }
    const card = checkCardForBrowserSession(db, claims.objectiveId, claims.actingUserId)
    if (!card.ok) {
      res.status(card.status).json({ error: card.error, code: card.code })
      return
    }

    let base: string
    try {
      base = publicUrl()
      const u = new URL(base)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)')
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') throw new Error('loopback')
    } catch {
      res.status(409).json({ error: 'This install has no public URL configured (CC_PUBLIC_URL / OK_DOMAIN)', code: 'no_public_url' })
      return
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { ttl_minutes?: unknown }
    const ttlMs = clampCardBrowserTtl(typeof body.ttl_minutes === 'number' ? body.ttl_minutes * 60_000 : undefined)
    const bot = cardBotSlug(card.objective)
    const app = mintCardBrowserSession(
      { objectiveId: claims.objectiveId, actingUserId: card.user?.id ?? null, bot },
      now(),
      ttlMs,
    )
    const cf = await exchange(base)
    const cookies = buildCardBrowserCookies(base, app, cf)

    console.log(
      `[card-browser] sign-in minted for card #${claims.objectiveId} ` +
      `(bot=${bot ?? '-'}, ws=${card.workspace}, ttl=${Math.round(ttlMs / 60000)}m, cf_access=${cf.status})`,
    )

    res.json({
      ok: true,
      public_url: base,
      expires_at: new Date(app.expiresAt).toISOString(),
      identity: {
        username: cardBrowserUsername(claims.objectiveId, bot),
        bot,
        role: 'member',
        workspace: card.workspace,
        read_only: true,
      },
      cf_access: cf.status === 'ok' ? { status: 'ok' } : { status: cf.status, reason: cf.reason },
      cookies,
    })
  })

  return router
}

export default createCardBrowserSessionRouter()
