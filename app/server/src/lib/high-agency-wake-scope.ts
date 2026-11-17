/**
 * High Agency wake sessions may manage the cards their bot OWNS (obj 901280).
 *
 * ## Why this exists
 *
 * PR 847 (obj 901195, `lib/card-session-scope.ts`) lets a jailed card session
 * use a short list of `/api/internal` routes on its OWN card only. A High
 * Agency wake (a card filed by the managed routine `high-agency:<slug>`) is
 * told by its brief to orient on, start, close and steer the cards its bot
 * owns — every one of those calls is a different card id, so every wake hit
 * 403 right after orienting. Owner decision (Nov 17 2026, option A of #901278):
 * give a wake exactly its bot's cards, nothing more.
 *
 * ## Who is a wake
 *
 * The caller card (already resolved from a live session token by
 * `resolveCardSessionCaller`) is a High Agency wake for bot `<slug>` only when
 * ALL of these hold — each is server state, none comes from the request:
 *
 *   1. its `routine_id` points at a routine named `high-agency:<slug>`;
 *   2. an `agent_chat_high_agency` row exists for `<slug>`, its `routine_id`
 *      (when set) is that routine, and its wake workspace is the card's
 *      workspace;
 *   3. the card is worked by that bot (`agent_context` = `<slug>`);
 *   4. the bot may still use that workspace (`botMayUseWorkspace`, the same
 *      fire-time guard the routine scheduler applies).
 *
 * ## What a wake may do
 *
 * | route | rule |
 * |-------|------|
 * | GET `/objectives` | `owned_by_bot` = its own slug (required); `workspace`, if given, = its workspace |
 * | GET `/objectives/:id` | `:id` is a card its bot owns in its workspace |
 * | PATCH `/objectives/:id/status` | same, and `status` ∈ working / review / done / cancelled (start, hold, close) |
 * | POST `/objectives/:id/message` | same (steer) |
 * | GET `/supervisor/flags` | `bot` = its own slug (required); `workspace`, if given, = its workspace |
 *
 * "Its bot owns" is `cardOwnerBot` (services/bots/card-owner.ts), the ONE
 * ownership rule — owner_bot first, else agent_context. Another bot's card, an
 * unowned card, a deleted card and any other workspace stay 403. A normal
 * (non-wake) card session never reaches this table: the PR 847 allow-list is
 * evaluated first and is unchanged.
 */
import type Database from 'better-sqlite3'
import type { CardSessionCaller } from './card-session-scope.js'
import { cardOwnerBot, ownerHasSlug } from '../services/bots/card-owner.js'
import { botMayUseWorkspace, highAgencyRoutineSlug } from '../services/agent-chat/bot-workspaces.js'

export type WakeScope = 'wake_list' | 'wake_card' | 'wake_flags'

export interface HighAgencyWake {
  /** The wake card's id (the caller). */
  cardId: number
  /** The bot's chat slug, lower-case. */
  slug: string
  workspace: string
  routineId: number
}

/** Statuses a wake may move one of its bot's cards to: start, hold (park for a person), close. */
export const WAKE_CARD_STATUSES: readonly string[] = ['working', 'review', 'done', 'cancelled']

const ID = '(\\d{1,12})'

/** The wake-only allow-list. Consulted only after the PR 847 own-card list refused. */
export const HIGH_AGENCY_WAKE_ROUTES: ReadonlyArray<{ methods: readonly string[]; pattern: RegExp; scope: WakeScope }> = [
  { methods: ['GET'], pattern: /^\/objectives$/, scope: 'wake_list' },
  { methods: ['GET'], pattern: new RegExp(`^/objectives/${ID}$`), scope: 'wake_card' },
  { methods: ['PATCH'], pattern: new RegExp(`^/objectives/${ID}/status$`), scope: 'wake_card' },
  { methods: ['POST'], pattern: new RegExp(`^/objectives/${ID}/message$`), scope: 'wake_card' },
  { methods: ['GET'], pattern: /^\/supervisor\/flags$/, scope: 'wake_flags' },
]

export function matchWakeRoute(method: string, subPath: string | null): { scope: WakeScope; id: number | null } | null {
  if (!subPath) return null
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  for (const r of HIGH_AGENCY_WAKE_ROUTES) {
    if (!r.methods.includes(m)) continue
    const hit = r.pattern.exec(subPath)
    if (hit) return { scope: r.scope, id: hit[1] ? Number(hit[1]) : null }
  }
  return null
}

const lower = (v: unknown): string => String(v ?? '').trim().toLowerCase()

/** The High Agency wake behind this caller card, or null when it is not one. Fails closed. */
export function resolveHighAgencyWake(
  caller: Pick<CardSessionCaller, 'id' | 'workspace' | 'agent_context' | 'routine_id'>,
  db: Database.Database,
): HighAgencyWake | null {
  if (caller.routine_id == null) return null
  try {
    const routine = db.prepare('SELECT id, name FROM routines WHERE id = ?').get(caller.routine_id) as
      | { id: number; name: string }
      | undefined
    const rawSlug = highAgencyRoutineSlug(routine?.name)
    if (!routine || !rawSlug) return null
    const slug = lower(rawSlug)
    if (lower(caller.agent_context) !== slug) return null
    const ha = db
      .prepare('SELECT slug, workspace, routine_id FROM agent_chat_high_agency WHERE lower(slug) = ?')
      .get(slug) as { slug: string; workspace: string | null; routine_id: number | null } | undefined
    if (!ha) return null
    if (ha.routine_id != null && Number(ha.routine_id) !== Number(routine.id)) return null
    if (!ha.workspace || ha.workspace !== caller.workspace) return null
    if (!botMayUseWorkspace(ha.slug, caller.workspace)) return null
    return { cardId: caller.id, slug, workspace: caller.workspace, routineId: routine.id }
  } catch {
    return null
  }
}

/** The wake behind a card id (live or not is the caller's concern), or null. */
export function highAgencyWakeForCard(db: Database.Database, cardId: number): HighAgencyWake | null {
  try {
    const row = db
      .prepare('SELECT id, workspace, agent_context, routine_id, deleted_at FROM objectives WHERE id = ?')
      .get(cardId) as (Pick<CardSessionCaller, 'id' | 'workspace' | 'agent_context' | 'routine_id'> & { deleted_at: string | null }) | undefined
    if (!row || row.deleted_at) return null
    return resolveHighAgencyWake({ ...row, workspace: (row.workspace || '').trim() }, db)
  } catch {
    return null
  }
}

export type WakeCardRefusal = 'not_found' | 'other_workspace' | 'not_owned'

/** May this wake act on card `targetId`? Its bot must own it, in the wake's workspace. */
export function wakeMayActOnCard(wake: HighAgencyWake, targetId: number, db: Database.Database): { ok: true } | { ok: false; reason: WakeCardRefusal } {
  try {
    const row = db
      .prepare('SELECT id, workspace, owner_bot, agent_context, deleted_at FROM objectives WHERE id = ?')
      .get(targetId) as { id: number; workspace: string | null; owner_bot: string | null; agent_context: string | null; deleted_at: string | null } | undefined
    if (!row || row.deleted_at) return { ok: false, reason: 'not_found' }
    if ((row.workspace || '').trim() !== wake.workspace) return { ok: false, reason: 'other_workspace' }
    if (!ownerHasSlug(cardOwnerBot(row, db), wake.slug)) return { ok: false, reason: 'not_owned' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'not_found' }
  }
}

function single(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  return typeof v === 'string' ? v : null // an array / object is never a match
}

/** Query check for the two scoped reads: `key` must name the bot, `workspace` (if any) its workspace. */
function queryScopeOk(wake: HighAgencyWake, query: Record<string, unknown>, key: 'owned_by_bot' | 'bot'): boolean {
  const who = single(query[key])
  if (typeof who !== 'string' || lower(who) !== wake.slug) return false
  const ws = single(query.workspace)
  if (ws === null) return false
  if (typeof ws === 'string' && ws.trim() !== '' && ws.trim() !== wake.workspace) return false
  if (key === 'bot' && query.routed_to !== undefined) return false
  return true
}

export type WakeDecision =
  | { ok: true; wake: HighAgencyWake; scope: WakeScope; id: number | null }
  | { ok: false; reason: 'not_wake' | 'not_wake_route' | 'not_owned' | 'out_of_scope_query' | 'status_not_allowed' }

/**
 * The wake half of the jail decision. `subPath` is the path below
 * `/api/internal` (see `internalSubPath`). Call ONLY after the PR 847 own-card
 * allow-list refused the request.
 */
export function authorizeHighAgencyWakeRequest(
  caller: CardSessionCaller,
  req: { method: string; query?: unknown; body?: unknown },
  subPath: string | null,
  db: Database.Database,
): WakeDecision {
  const route = matchWakeRoute(req.method, subPath)
  if (!route) return { ok: false, reason: 'not_wake_route' }
  const wake = resolveHighAgencyWake(caller, db)
  if (!wake) return { ok: false, reason: 'not_wake' }
  const query = (req.query && typeof req.query === 'object' ? req.query : {}) as Record<string, unknown>
  switch (route.scope) {
    case 'wake_list':
      return queryScopeOk(wake, query, 'owned_by_bot') ? { ok: true, wake, ...route } : { ok: false, reason: 'out_of_scope_query' }
    case 'wake_flags':
      return queryScopeOk(wake, query, 'bot') ? { ok: true, wake, ...route } : { ok: false, reason: 'out_of_scope_query' }
    case 'wake_card': {
      if (route.id == null) return { ok: false, reason: 'not_owned' }
      if (req.method.toUpperCase() === 'PATCH') {
        const status = (req.body as { status?: unknown } | undefined)?.status
        if (typeof status !== 'string' || !WAKE_CARD_STATUSES.includes(status)) return { ok: false, reason: 'status_not_allowed' }
      }
      return wakeMayActOnCard(wake, route.id, db).ok ? { ok: true, wake, ...route } : { ok: false, reason: 'not_owned' }
    }
  }
}

/**
 * The wake acting on `targetId` in this request, or null. A jailed wake was
 * already admitted by the gate (`admitted`, from `sandboxWakeOf(res)`). A
 * non-jailed caller that presents a wake card's session token is resolved here,
 * so the close rules and the audit actor below apply to it too. Acting on the
 * wake's OWN card is not a cross-card action and returns null.
 */
export function wakeActingOnCard(
  admitted: HighAgencyWake | null,
  caller: Pick<CardSessionCaller, 'id' | 'workspace' | 'agent_context' | 'routine_id'> | null,
  targetId: number,
  db: Database.Database,
): HighAgencyWake | null {
  const wake = admitted ?? (caller ? resolveHighAgencyWake(caller, db) : null)
  if (!wake || wake.cardId === targetId) return null
  return wakeMayActOnCard(wake, targetId, db).ok ? wake : null
}
