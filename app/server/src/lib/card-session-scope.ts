/**
 * Card-session scope on `/api/internal/*` for SANDBOXED callers (obj 901195).
 *
 * ## Why this exists
 *
 * obj 901027 (PR #807) made `internalApiGate` refuse every sandbox-CIDR peer that
 * carries no `X-Internal-Secret` / objectives token: reachability on the jail
 * network is not authority. Correct — but the session prompt still tells every
 * card to call a handful of internal routes on its OWN card with its own
 * `CC_SESSION_TOKEN` (memory files, progress, job-disposition, child cards…), so
 * jailed cards silently lost NOTES/ARTIFACT, progress and child cards.
 *
 * The fix is NOT to hand sandboxes the server-wide secret, and NOT to relax
 * `isSandboxPeer`. A sandbox peer gets through only when BOTH hold:
 *
 *   1. it presents a valid card session token whose card is still live
 *      (exists, not deleted, not done/cancelled) — `resolveCardSessionCaller`;
 *   2. the route is on the explicit allow-list below, AND the route's target is
 *      that card — `authorizeCardSessionRequest`. There is NO cross-card rule:
 *      a jailed session never reads, changes or steers another card here.
 *
 * Every allow-listed handler re-checks the same binding itself (defense in
 * depth) through `sandboxCardGuard` / the create and pr-created helpers, so a
 * mis-mount or a future refactor of the gate cannot widen the scope.
 *
 * ## The allow-list (keep in sync with the PR / prompt-builder text)
 *
 * | scope    | routes | rule |
 * |----------|--------|------|
 * | own      | GET `/objectives/:id` (its own row), GET/PUT `/objectives/:id/memory/file`, GET/POST `/objectives/:id/progress`, GET `/objectives/:id/artifacts[/file]`, POST `/objectives/:id/job-disposition`, POST `/objectives/:id/fanout`, GET/POST `/reviews/:id/criteria` (the AI reviewer's rubric lock) | `:id` = the token's card |
 * | create   | POST `/objectives` | every item's `parent_id` / `source_job_id` (when given) = the token's card, `workspace` (when given) = its workspace; the handler fills both in |
 * | pr       | POST `/pr-created` | body `objective_id` = the token's card |
 *
 * Anything else stays 403 for a sandbox peer: deploy, restart, secrets, pr-health,
 * routines, strategies, `/briefing`, board-wide reads (`GET /objectives`,
 * `/siblings`, `/supervisor/flags`), Full access (`/full-access*`), ANOTHER
 * card's row or review criteria, and every cross-card write or read
 * (`PATCH /objectives/:id/status`, `POST /objectives/:id/message`,
 * `GET /objectives/:id/output`) — on its own card id as well as any other.
 * Cross-card actions a High Agency wake may need from a jail are a follow-up
 * that needs the owner's approval, not a rule to add here.
 */
import type { Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { isSandboxPeer } from './is-localhost.js'
import { sessionTokenFromHeaders, verifySessionToken } from './session-trust.js'
import { hasValidInternalSecret } from '../middleware/internal-secret.js'
import { hasValidObjectivesToken } from '../middleware/objectives-token.js'

export type CardSessionScope = 'own' | 'create' | 'pr'

interface RouteRule {
  methods: readonly string[]
  /** Anchored, lower-case, against the path below `/api/internal`. Group 1 = `:id` when present. */
  pattern: RegExp
  scope: CardSessionScope
}

const ID = '(\\d{1,12})'

/** THE allow-list. A route not here is refused to a sandbox peer, token or not. */
export const CARD_SESSION_ROUTES: readonly RouteRule[] = [
  { methods: ['GET', 'PUT'], pattern: new RegExp(`^/objectives/${ID}/memory/file$`), scope: 'own' },
  { methods: ['GET', 'POST'], pattern: new RegExp(`^/objectives/${ID}/progress$`), scope: 'own' },
  { methods: ['GET'], pattern: new RegExp(`^/objectives/${ID}/artifacts$`), scope: 'own' },
  { methods: ['GET'], pattern: new RegExp(`^/objectives/${ID}/artifacts/file$`), scope: 'own' },
  { methods: ['POST'], pattern: new RegExp(`^/objectives/${ID}/job-disposition$`), scope: 'own' },
  { methods: ['POST'], pattern: new RegExp(`^/objectives/${ID}/fanout$`), scope: 'own' },
  // The AI reviewer's rubric lock (session-reviewer-prompt.ts Step 0). A reviewer's
  // token is minted for the card it reviews, so `:id` = the token's card here too.
  { methods: ['GET', 'POST'], pattern: new RegExp(`^/reviews/${ID}/criteria$`), scope: 'own' },
  { methods: ['POST'], pattern: /^\/objectives$/, scope: 'create' },
  { methods: ['POST'], pattern: /^\/pr-created$/, scope: 'pr' },
  // Its OWN card row only (a worker re-reading its brief). Board-wide reads,
  // siblings, supervisor flags, Full access and every cross-card write
  // (status / message / output) are deliberately NOT here: a jailed session
  // never reads or steers another card through /api/internal.
  { methods: ['GET'], pattern: new RegExp(`^/objectives/${ID}$`), scope: 'own' },
]

const INTERNAL_PREFIX = '/api/internal'

/**
 * The request path below `/api/internal`, normalised the way Express routes it
 * (case-insensitive, one optional trailing slash, percent-decoded segments).
 * null when it cannot be decoded or a segment decodes to a slash — such a path
 * is never on the allow-list.
 */
export function internalSubPath(req: Pick<Request, 'baseUrl' | 'path'>): string | null {
  const full = `${req.baseUrl ?? ''}${req.path ?? ''}`
  if (full.slice(0, INTERNAL_PREFIX.length).toLowerCase() !== INTERNAL_PREFIX) return null
  let rest = full.slice(INTERNAL_PREFIX.length)
  if (rest.length > 1 && rest.endsWith('/')) rest = rest.slice(0, -1)
  if (!rest.startsWith('/')) return null
  const segs = rest.split('/')
  const out: string[] = []
  for (const s of segs) {
    let d: string
    try { d = decodeURIComponent(s) } catch { return null }
    if (d.includes('/') || d.includes('\\')) return null
    out.push(d)
  }
  return out.join('/').toLowerCase()
}

export interface MatchedRoute { scope: CardSessionScope; id: number | null }

export function matchCardSessionRoute(method: string, subPath: string | null): MatchedRoute | null {
  if (!subPath) return null
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  for (const r of CARD_SESSION_ROUTES) {
    if (!r.methods.includes(m)) continue
    const hit = r.pattern.exec(subPath)
    if (hit) return { scope: r.scope, id: hit[1] ? Number(hit[1]) : null }
  }
  return null
}

export interface CardSessionCaller {
  id: number
  workspace: string
  agent_context: string | null
  owner_bot: string | null
  routine_id: number | null
}

/**
 * The card behind a session token, when the token verifies AND the card is
 * still live. An ended card (done / cancelled / deleted / gone) is a revoked
 * principal: its token was minted for a session that no longer runs.
 */
export function resolveCardSessionCaller(
  headers: Record<string, string | string[] | undefined>,
  db?: Database.Database,
): CardSessionCaller | null {
  let claims = null
  try { claims = verifySessionToken(sessionTokenFromHeaders(headers)) } catch { claims = null }
  if (!claims) return null
  try {
    const row = (db ?? getDb())
      .prepare(
        `SELECT id, workspace, agent_context, owner_bot, routine_id, status, deleted_at
           FROM objectives WHERE id = ?`,
      )
      .get(claims.objectiveId) as
      | (CardSessionCaller & { status: string; deleted_at: string | null })
      | undefined
    if (!row || row.deleted_at) return null
    if (row.status === 'done' || row.status === 'cancelled') return null
    const ws = (row.workspace || '').trim()
    // The token's workspace claim must still be the card's workspace.
    if (!ws || ws !== claims.workspace) return null
    return { id: row.id, workspace: ws, agent_context: row.agent_context, owner_bot: row.owner_bot, routine_id: row.routine_id }
  } catch {
    return null
  }
}

/** Body checks for `POST /objectives` from a sandboxed card: null = fine, else the reason. */
export function createBodyScopeError(caller: CardSessionCaller, body: unknown): string | null {
  if (!Array.isArray(body) || body.length === 0) return null // the handler answers the shape 400
  for (let i = 0; i < body.length; i++) {
    const item = body[i] as Record<string, unknown> | null
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null // shape 400 again
    if (item.workspace !== undefined && item.workspace !== null && String(item.workspace).trim() !== caller.workspace) {
      return `Item ${i}: a sandboxed card may only file cards in its own workspace '${caller.workspace}'`
    }
    if (item.parent_id !== undefined && item.parent_id !== null && Number(item.parent_id) !== caller.id) {
      return `Item ${i}: parent_id must be this card (#${caller.id})`
    }
    if (item.source_job_id !== undefined && item.source_job_id !== null && Number(item.source_job_id) !== caller.id) {
      return `Item ${i}: source_job_id must be this card (#${caller.id})`
    }
  }
  return null
}

/**
 * Pin a sandboxed card's new cards to it: its workspace, and a parent link
 * (`parent_id`) unless the item already links back by `source_job_id`. Call
 * only after `createBodyScopeError` returned null.
 */
export function pinCreateItemsToCaller(caller: CardSessionCaller, items: Array<Record<string, unknown>>): void {
  for (const item of items) {
    if (item.workspace === undefined || item.workspace === null) item.workspace = caller.workspace
    const hasParent = item.parent_id !== undefined && item.parent_id !== null
    const hasSource = item.source_job_id !== undefined && item.source_job_id !== null
    if (!hasParent && !hasSource) item.parent_id = caller.id
  }
}

export type CardSessionDecision =
  | { ok: true; caller: CardSessionCaller; route: MatchedRoute }
  | { ok: false; reason: 'no_token' | 'bad_token' | 'not_allow_listed' | 'not_own_card' | 'out_of_scope_body' }

/** The one decision the gate (and the handlers) make for a sandbox peer. */
export async function authorizeCardSessionRequest(req: Request, db?: Database.Database): Promise<CardSessionDecision> {
  const headers = req.headers as Record<string, string | string[] | undefined>
  if (!sessionTokenFromHeaders(headers)) return { ok: false, reason: 'no_token' }
  const d = db ?? getDb()
  const caller = resolveCardSessionCaller(headers, d)
  if (!caller) return { ok: false, reason: 'bad_token' }
  const route = matchCardSessionRoute(req.method, internalSubPath(req))
  if (!route) return { ok: false, reason: 'not_allow_listed' }
  switch (route.scope) {
    case 'own':
      return route.id === caller.id ? { ok: true, caller, route } : { ok: false, reason: 'not_own_card' }
    case 'pr': {
      const id = Number((req.body as { objective_id?: unknown } | undefined)?.objective_id)
      return id === caller.id ? { ok: true, caller, route } : { ok: false, reason: 'not_own_card' }
    }
    case 'create':
      return createBodyScopeError(caller, req.body) ? { ok: false, reason: 'out_of_scope_body' } : { ok: true, caller, route }
  }
}

/**
 * Handler-level re-check (defense in depth). A non-sandbox caller passes
 * untouched (loopback and credentialled callers behave exactly as before). A
 * sandbox peer must hold a live session token whose card this route may touch.
 * Returns the caller card (or null for non-sandbox callers) and `false` when a
 * 403 has been sent.
 */
export async function sandboxCardGuard(
  req: Request,
  res: Response,
): Promise<{ sandboxed: false } | { sandboxed: true; caller: CardSessionCaller } | false> {
  if (!isSandboxPeer(req)) return { sandboxed: false }
  // A credentialled caller (X-Internal-Secret / objectives token) passed the gate
  // on that credential, exactly as before obj 901195.
  if (hasValidInternalSecret(req) || hasValidObjectivesToken(req)) return { sandboxed: false }
  const decision = await authorizeCardSessionRequest(req)
  if (!decision.ok) {
    res.status(403).json({
      error: "A sandboxed session may only use its own card's internal routes, with its own X-CC-Session-Token",
      code: decision.reason,
    })
    return false
  }
  return { sandboxed: true, caller: decision.caller }
}

/**
 * Wrap an allow-listed internal handler with `sandboxCardGuard`. For a sandbox
 * peer the caller card is put on `res.locals.cardSessionCaller` (the create
 * route pins new cards to it). Non-sandbox callers run the handler unchanged.
 */
export function withSandboxCardGuard<H extends (req: Request, res: Response, next: (err?: unknown) => void) => unknown>(handler: H) {
  return (req: Request, res: Response, next: (err?: unknown) => void): void => {
    sandboxCardGuard(req, res)
      .catch(() => {
        if (!res.headersSent) res.status(403).json({ error: 'Card session scope could not be checked', code: 'scope_check_failed' })
        return false as const
      })
      .then((g) => {
        if (!g) return
        if (g.sandboxed) res.locals.cardSessionCaller = g.caller
        return Promise.resolve(handler(req, res, next))
      })
      .catch(next)
  }
}

/** The sandboxed caller card set by `withSandboxCardGuard`, or null. */
export function sandboxCallerOf(res: Response): CardSessionCaller | null {
  return (res.locals?.cardSessionCaller as CardSessionCaller | undefined) ?? null
}
