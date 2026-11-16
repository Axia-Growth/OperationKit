// ── Bot visibility: per-bot work view + High Agency activity (obj 900947) ──
//
// Read-only views over the board. Nothing here writes a card, a ceiling or an
// approval; the only writes in this feature are the "needs you" chat posts in
// bot-attention.ts.
//
// OWNERSHIP. A chat bot owns a card when
//   - agent_context = its slug (the High Agency rule; never the column default
//     'general', which every persona-less card carries), or
//   - owner_bot names it (its registry id, name or an alias — chat-filed cards
//     land with agent_context 'general', so owner_bot is the signal there), or
//   - the card is one of its own High Agency wakes (routine `high-agency:<slug>`).
//
// SCOPE. A view only ever covers workspaces that are BOTH the viewer's (an
// admin: every workspace) AND granted to the bot (bot-workspaces.ts). A card
// outside that intersection is never read into a view, a count or a summary.
//
// VISIBILITY. Inside those workspaces a member sees exactly the cards the
// board list shows them (lib/agent-control.ts visibilityClauseFor): every card
// where their membership is objective_visibility = 'all', else only cards they
// are assigned to, created, or are an assignee on. EVERY card query below
// carries that predicate (botViewScope), so a card the viewer cannot open on
// the board is never in a group, a count, a needs-you total, the daily
// summary, a wake entry or a wake's children. An admin sees every card.
//
// SPEND. Measured spend = settled sessions (session_intel) or the spend guard's
// last live measurement (objective_spend_guard.spent_usd, refreshed every
// minute for working cards), whichever is larger — so the list never re-parses
// transcripts. The ceiling is the card's effective one from PR 794
// (resolveEffectiveCostCeiling): explicit, else `spend_ceiling_default_usd:<tier>`.
import type { Database } from 'better-sqlite3'
import {
  botLiveLine,
  botLiveState,
  botOwnerToken,
  needsYouReasons,
  RECENTLY_DONE_DAYS,
  RECENTLY_DONE_LIMIT,
  workGroupOf,
  DEFAULT_AGENT_CONTEXT,
  type BotActivityCardRef,
  type BotActivityEntry,
  type BotActivityItem,
  type BotActivityItemKind,
  type BotActivityResponse,
  type BotActivityRun,
  type BotStatusEntry,
  type BotStatusResponse,
  type BotWorkCard,
  type BotWorkCounts,
  type BotWorkView,
  type NeedsYouReason,
  type WorkGroup,
} from '@operationkit/shared'
import { visibilityClauseFor, type ControlUser, type VisibilityMembership } from '../../lib/agent-control.js'
import { resolveBotOwner } from '../../routes/objectives-helpers.js'
import { botForAgentSlug, registryKey } from '../bots/bot-registry.js'
import { resolveEffectiveCostCeiling } from '../spend-guard.js'
import { listWorkspaces } from '../workspaces.js'
import { narrowToBot } from './bot-workspaces.js'
import { isAgentChatRunning } from './engine.js'
import { getHighAgency, highAgencyView, routineNameFor } from './high-agency.js'

/** The bot a view is for: its chat slug + display name. */
export interface BotRef {
  slug: string
  name: string
}

/** Every spelling a card's owner_bot may use for this bot. */
export interface BotIdentity {
  slug: string
  name: string
  keys: Set<string>
  /** True when agent_context = slug says nothing (the 'general' default). */
  slugIsDefault: boolean
  /** The id the board's owner filter uses for this bot (registry id, else the bot's name). */
  boardId: string
}

export function botIdentity(bot: BotRef, db?: Database): BotIdentity {
  const keys = new Set<string>()
  const add = (v: string | null | undefined) => {
    const k = v ? registryKey(v) : ''
    if (k) keys.add(k)
  }
  add(bot.slug)
  add(bot.name)
  let reg = null
  try { reg = botForAgentSlug(bot.slug, db) } catch { reg = null }
  if (reg) {
    add(reg.id)
    add(reg.name)
    for (const a of reg.aliases) add(a)
  }
  return { slug: bot.slug, name: bot.name, keys, boardId: reg?.id ?? bot.name, slugIsDefault: registryKey(bot.slug) === registryKey(DEFAULT_AGENT_CONTEXT) }
}

/** The routines that are this bot's High Agency wakes (the live row's + any by name). */
export function wakeRoutineIds(db: Database, slug: string): number[] {
  const ids = new Set<number>()
  try {
    for (const r of db.prepare('SELECT id FROM routines WHERE name = ?').all(routineNameFor(slug)) as { id: number }[]) ids.add(r.id)
  } catch { /* routines absent */ }
  try {
    const s = getHighAgency(slug)
    if (s.routine_id != null) ids.add(s.routine_id)
  } catch { /* high agency table absent */ }
  return [...ids]
}

/**
 * Workspaces a view covers: the viewer's (null = every workspace, i.e. an
 * admin) narrowed to the bot's grant.
 */
export function botViewWorkspaces(slug: string, viewer: string[] | null): string[] {
  const base = viewer ?? listWorkspaces({ includeArchived: true }).map(w => w.slug)
  return narrowToBot(slug, [...new Set(base)])
}

/** Who is looking at a view: the signed-in person (or the person a bot runs as). */
export type BotViewer = Pick<ControlUser, 'id' | 'role'>

/**
 * What one viewer may read of one bot: the workspaces the view covers, and the
 * SQL predicate (alias `o`) every card query must carry. `vis` is null when
 * the viewer can see nothing.
 */
export interface BotViewScope {
  workspaces: string[]
  vis: { sql: string; params: unknown[] } | null
}

/**
 * The viewer's board visibility ∩ the bot's workspace grant. The membership
 * rows are read WITH objective_visibility (middleware getUserWorkspaces drops
 * that column), so 'all' and 'own' memberships are told apart here.
 */
export function botViewScope(db: Database, slug: string, viewer: BotViewer): BotViewScope {
  const admin = viewer.role === 'admin'
  const memberships: VisibilityMembership[] = admin
    ? []
    : (db.prepare('SELECT workspace, objective_visibility FROM user_workspaces WHERE user_id = ? ORDER BY workspace').all(viewer.id) as VisibilityMembership[])
  const workspaces = botViewWorkspaces(slug, admin ? null : memberships.map(m => m.workspace))
  const vis = workspaces.length === 0
    ? null
    : visibilityClauseFor({ id: viewer.id, role: viewer.role, allowWorkspaces: workspaces }, memberships)
  return { workspaces, vis }
}

// ── card rows ───────────────────────────────────────────────────────────────

interface CardRow {
  id: number
  title: string
  status: string
  workspace: string
  pr_url: string | null
  session_id: string | null
  has_blockers: number | null
  needs_secret: string | null
  stalled_at: string | null
  job_disposition: string | null
  job_review_note: string | null
  last_session_summary: string | null
  owner_bot: string | null
  agent_context: string | null
  routine_id: number | null
  source_job_id: number | null
  parent_id: number | null
  effort: string | null
  created_at: string
  updated_at: string
}

const CARD_COLS = `id, title, status, workspace, pr_url, session_id, has_blockers, needs_secret, stalled_at,
  job_disposition, job_review_note, last_session_summary, owner_bot, agent_context, routine_id,
  source_job_id, parent_id, effort, created_at, updated_at`

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

/** Does this bot own the card? (See the header for the rule.) */
export function isOwnedBy(row: Pick<CardRow, 'agent_context' | 'owner_bot' | 'routine_id'>, ident: BotIdentity, wakeRoutines: number[]): boolean {
  if (row.routine_id != null && wakeRoutines.includes(row.routine_id)) return true
  if (!ident.slugIsDefault && row.agent_context && registryKey(row.agent_context) === registryKey(ident.slug)) return true
  const explicit = (row.owner_bot ?? '').trim()
  if (explicit) {
    if (ident.keys.has(registryKey(explicit))) return true
    try {
      const resolved = resolveBotOwner({ owner_bot: row.owner_bot, agent_context: row.agent_context } as never)
      if (resolved && (ident.keys.has(registryKey(resolved.id)) || ident.keys.has(registryKey(resolved.name)))) return true
    } catch { /* registry unreadable → explicit match only */ }
  }
  return false
}

/** Cards a bot owns that the viewer may see: open ones + done within RECENTLY_DONE_DAYS. */
function loadOwnedCards(db: Database, ident: BotIdentity, wakeRoutines: number[], scope: BotViewScope): CardRow[] {
  if (!scope.vis) return []
  const routineClause = wakeRoutines.length ? ` OR o.routine_id IN (${placeholders(wakeRoutines.length)})` : ''
  const rows = db
    .prepare(
      `SELECT ${CARD_COLS} FROM objectives o
        WHERE o.deleted_at IS NULL
          AND ${scope.vis.sql}
          AND (o.status NOT IN ('done', 'cancelled')
               OR (o.status = 'done' AND o.updated_at >= datetime('now', ?)))
          AND (lower(o.agent_context) = lower(?) OR (o.owner_bot IS NOT NULL AND o.owner_bot != '')${routineClause})
        ORDER BY o.updated_at DESC, o.id DESC`,
    )
    .all(...scope.vis.params, `-${RECENTLY_DONE_DAYS} days`, ident.slug, ...wakeRoutines) as CardRow[]
  return rows.filter(r => isOwnedBy(r, ident, wakeRoutines))
}

// ── spend + needs-you signals ──────────────────────────────────────────────

/** Settled spend per card (session_intel) and the spend guard's last live measurement. */
export function measuredSpend(db: Database, ids: number[]): Map<number, number> {
  const out = new Map<number, number>()
  if (ids.length === 0) return out
  const bump = (id: number, usd: number) => out.set(id, Math.max(out.get(id) ?? 0, Number(usd) || 0))
  try {
    for (const r of db
      .prepare(`SELECT objective_id AS id, SUM(total_cost_usd) AS usd FROM session_intel WHERE objective_id IN (${placeholders(ids.length)}) GROUP BY objective_id`)
      .all(...ids) as { id: number; usd: number }[]) bump(r.id, r.usd)
  } catch { /* intel absent */ }
  try {
    for (const r of db
      .prepare(`SELECT objective_id AS id, spent_usd AS usd FROM objective_spend_guard WHERE objective_id IN (${placeholders(ids.length)})`)
      .all(...ids) as { id: number; usd: number }[]) bump(r.id, r.usd)
  } catch { /* spend guard absent */ }
  return out
}

/**
 * Cards whose bot asked to approve something its grant does not cover
 * (delegation_audit `approval_denied`) with no approval used on the card since.
 */
export function deniedApprovals(db: Database, ids: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>()
  if (ids.length === 0) return out
  try {
    const rows = db
      .prepare(
        `SELECT objective_id AS id,
                MAX(CASE WHEN event = 'approval_denied' THEN id END) AS denied,
                MAX(CASE WHEN event = 'approval_used' THEN id END) AS used
           FROM delegation_audit
          WHERE objective_id IN (${placeholders(ids.length)})
          GROUP BY objective_id`,
      )
      .all(...ids) as { id: number; denied: number | null; used: number | null }[]
    for (const r of rows) {
      if (r.denied == null || (r.used != null && r.used > r.denied)) continue
      const a = db.prepare('SELECT action FROM delegation_audit WHERE id = ?').get(r.denied) as { action: string | null } | undefined
      out.set(r.id, a?.action ?? null)
    }
  } catch { /* delegation tables absent */ }
  return out
}

function secretCount(raw: string | null): number {
  if (!raw) return 0
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.length : 0
  } catch {
    return 0
  }
}

export interface CardSignals {
  spent_usd: number
  ceiling_usd: number | null
  ceiling_source: string | null
  ceiling_is_default: boolean
  needs_you: NeedsYouReason[]
  denied_action: string | null
}

/** Spend vs ceiling and the needs-you reasons for a set of cards, batched. */
export function cardSignals(db: Database, rows: CardRow[]): Map<number, CardSignals> {
  const ids = rows.map(r => r.id)
  const spend = measuredSpend(db, ids)
  const denied = deniedApprovals(db, ids)
  const out = new Map<number, CardSignals>()
  for (const r of rows) {
    let ceiling: { costUsd: number; source: string; isDefault: boolean } | null = null
    try {
      ceiling = resolveEffectiveCostCeiling(db, { id: r.id, workspace: r.workspace, effort: r.effort })
    } catch { ceiling = null }
    const spent = spend.get(r.id) ?? 0
    out.set(r.id, {
      spent_usd: round(spent),
      ceiling_usd: ceiling ? ceiling.costUsd : null,
      ceiling_source: ceiling?.source ?? null,
      ceiling_is_default: ceiling?.isDefault ?? false,
      denied_action: denied.get(r.id) ?? null,
      needs_you: needsYouReasons({
        status: r.status,
        session_id: r.session_id,
        has_blockers: r.has_blockers,
        needs_secret_count: secretCount(r.needs_secret),
        stalled: !!r.stalled_at && r.status === 'working',
        job_disposition: r.job_disposition,
        spent_usd: spent,
        ceiling_usd: ceiling ? ceiling.costUsd : null,
        approval_denied: denied.has(r.id),
      }),
    })
  }
  return out
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000
}

// ── the Work tab ────────────────────────────────────────────────────────────

const emptyGroups = (): Record<WorkGroup, BotWorkCard[]> => ({ running: [], review: [], queued: [], done: [] })

export interface BotWorkOptions {
  /** The person looking. Their board visibility bounds every card in the view. */
  viewer: BotViewer
}

/** Internal: owned cards + their signals, shared by the Work tab, status and attention. */
export function ownedCardsWithSignals(db: Database, bot: BotRef, viewer: BotViewer) {
  const ident = botIdentity(bot, db)
  const wakes = wakeRoutineIds(db, bot.slug)
  const scope = botViewScope(db, bot.slug, viewer)
  const rows = loadOwnedCards(db, ident, wakes, scope)
  const signals = cardSignals(db, rows)
  return { ident, wakes, scope, workspaces: scope.workspaces, rows, signals }
}

export function buildBotWork(db: Database, bot: BotRef, opts: BotWorkOptions): BotWorkView {
  const { ident, wakes, workspaces, rows, signals } = ownedCardsWithSignals(db, bot, opts.viewer)
  const groups = emptyGroups()
  for (const r of rows) {
    const group = workGroupOf(r.status)
    if (!group) continue
    const isWake = r.routine_id != null && wakes.includes(r.routine_id)
    // A finished wake is a feed entry, not work: hourly wakes would bury "Recently done".
    if (isWake && group === 'done') continue
    const s = signals.get(r.id)!
    groups[group].push({
      id: r.id,
      title: r.title,
      status: r.status,
      workspace: r.workspace,
      group,
      pr_url: r.pr_url || null,
      spent_usd: s.spent_usd,
      ceiling_usd: s.ceiling_usd,
      ceiling_source: s.ceiling_source,
      ceiling_is_default: s.ceiling_is_default,
      needs_you: s.needs_you,
      is_wake: isWake,
      updated_at: r.updated_at,
    })
  }
  groups.done = groups.done.slice(0, RECENTLY_DONE_LIMIT)
  const counts = countsOf(groups)
  const focus = focusCard(groups)
  // obj 901025: a chat turn streaming or running tools for this viewer counts as
  // "running" too, even with zero cards — the sidebar/header must not read Idle
  // mid-reply just because no card session is open.
  const chatActive = isAgentChatRunning(opts.viewer.id, bot.slug)
  return {
    slug: bot.slug,
    owner_token: botOwnerToken(ident.boardId),
    workspaces,
    groups,
    counts,
    state: botLiveState(counts, chatActive),
    line: botLiveLine(counts, focus, chatActive),
  }
}

function countsOf(groups: Record<WorkGroup, BotWorkCard[]>): BotWorkCounts {
  const all = [...groups.running, ...groups.review, ...groups.queued]
  return {
    running: groups.running.length,
    review: groups.review.length,
    queued: groups.queued.length,
    done: groups.done.length,
    needs_you: all.filter(c => c.needs_you.length > 0).length,
  }
}

/** The card the sidebar line names: the first one waiting on you, else the newest running one. */
function focusCard(groups: Record<WorkGroup, BotWorkCard[]>): BotWorkCard | null {
  const open = [...groups.running, ...groups.review, ...groups.queued]
  const waiting = open.find(c => c.needs_you.length > 0)
  if (waiting) return waiting
  return groups.running.find(c => !c.is_wake) ?? groups.running[0] ?? null
}

/** Every bot's sidebar entry, plus "Needs you" across all of them (each card once). */
export function buildBotStatus(db: Database, bots: BotRef[], opts: BotWorkOptions): BotStatusResponse {
  const out: Record<string, BotStatusEntry> = {}
  const needing = new Set<number>()
  for (const bot of bots) {
    const view = buildBotWork(db, bot, opts)
    const focus = focusCard(view.groups)
    for (const g of ['running', 'review', 'queued'] as const) {
      for (const c of view.groups[g]) if (c.needs_you.length > 0) needing.add(c.id)
    }
    out[bot.slug] = { slug: bot.slug, state: view.state, line: view.line, focus_id: focus?.id ?? null, counts: view.counts }
  }
  return { bots: out, needs_you_total: needing.size }
}

// ── the Activity feed ──────────────────────────────────────────────────────

/** Wake cards this bot fired that the viewer may see, newest first. */
function loadWakes(db: Database, wakes: number[], scope: BotViewScope, limit: number, wakeId?: number): CardRow[] {
  if (wakes.length === 0 || !scope.vis) return []
  const idClause = wakeId != null ? ' AND o.id = ?' : ''
  return db
    .prepare(
      `SELECT ${CARD_COLS} FROM objectives o
        WHERE o.deleted_at IS NULL AND o.routine_id IN (${placeholders(wakes.length)})
          AND ${scope.vis.sql}${idClause}
        ORDER BY o.id DESC LIMIT ?`,
    )
    .all(...wakes, ...scope.vis.params, ...(wakeId != null ? [wakeId] : []), limit) as CardRow[]
}

/** Cards each wake filed or linked (source_job_id / parent_id) that the viewer may see. */
function loadWakeChildren(db: Database, wakeIds: number[], scope: BotViewScope): Map<number, CardRow[]> {
  const out = new Map<number, CardRow[]>()
  if (wakeIds.length === 0 || !scope.vis) return out
  const rows = db
    .prepare(
      `SELECT ${CARD_COLS} FROM objectives o
        WHERE o.deleted_at IS NULL
          AND (o.source_job_id IN (${placeholders(wakeIds.length)}) OR o.parent_id IN (${placeholders(wakeIds.length)}))
          AND ${scope.vis.sql}
        ORDER BY o.id ASC`,
    )
    .all(...wakeIds, ...wakeIds, ...scope.vis.params) as CardRow[]
  const wakeSet = new Set(wakeIds)
  for (const r of rows) {
    const home = r.source_job_id != null && wakeSet.has(r.source_job_id) ? r.source_job_id : r.parent_id
    if (home == null) continue
    const list = out.get(home) ?? []
    if (!list.some(x => x.id === r.id)) list.push(r)
    out.set(home, list)
  }
  return out
}

function firstLine(text: string | null | undefined, max = 240): string {
  const line = (text ?? '').split('\n').map(s => s.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function didLine(w: CardRow): string {
  const note = firstLine(w.job_review_note)
  if (note) return note
  const summary = firstLine(w.last_session_summary)
  if (summary) return summary
  if (w.status === 'working' || w.status === 'planning') return 'Running now.'
  if (w.status === 'queue') return 'Waiting to start.'
  if (w.status === 'cancelled') return 'Cancelled before it reported.'
  return 'No report yet.'
}

function ref(r: CardRow, spend: Map<number, number>): BotActivityCardRef {
  return { id: r.id, title: r.title, status: r.status, pr_url: r.pr_url || null, spent_usd: round(spend.get(r.id) ?? 0) }
}

interface StatusEvent {
  objective_id: number
  to_value: string
  created_at: string
}

/**
 * Status transitions ('working' / 'done' / 'cancelled') for the given cards,
 * oldest first — the time-window fallback for "which card did this wake start
 * or close" (below). Independent of source_job_id / parent_id, so it finds the
 * card even when a wake started an EXISTING queued card (nothing to link —
 * obj 901030, e.g. a wake files three cards under a standing project, then a
 * later wake's close-out pass starts one of them).
 */
function loadStatusEvents(db: Database, ids: number[]): StatusEvent[] {
  if (ids.length === 0) return []
  try {
    return db
      .prepare(
        `SELECT objective_id, to_value, created_at FROM objective_events
          WHERE kind = 'status' AND to_value IN ('working', 'done', 'cancelled')
            AND objective_id IN (${placeholders(ids.length)})
          ORDER BY created_at ASC`,
      )
      .all(...ids) as StatusEvent[]
  } catch {
    return []
  }
}

/** Status events ('review'/'ai_review'/'done'/'cancelled') for the wakes themselves — when a wake's OWN run ended. */
function loadWakeEndEvents(db: Database, wakeIds: number[]): StatusEvent[] {
  if (wakeIds.length === 0) return []
  try {
    return db
      .prepare(
        `SELECT objective_id, to_value, created_at FROM objective_events
          WHERE kind = 'status' AND to_value IN ('review', 'ai_review', 'done', 'cancelled')
            AND objective_id IN (${placeholders(wakeIds.length)})
          ORDER BY created_at ASC`,
      )
      .all(...wakeIds) as StatusEvent[]
  } catch {
    return []
  }
}

interface AgentStart {
  objective_id: number
  created_at: string
}

/**
 * Real-provenance signal (obj 901030, operator review of PR #812): a NEW
 * session spawned on another owned card with `session_starts.reason = 'agent'`
 * — an API-key/bot-triggered start, as opposed to `board` (a person clicked
 * Start) or `follow_up` (a chat message, human or bot, started it). Preferred
 * over the time-window status-event fallback below because it is attributable
 * to "something automated started this", not merely "this changed status while
 * the wake happened to be running".
 */
function loadAgentSessionStarts(db: Database, ids: number[]): AgentStart[] {
  if (ids.length === 0) return []
  try {
    return db
      .prepare(
        // session_starts.created_at defaults to an ISO 'T'-separated timestamp
        // while objectives/objective_events use `datetime('now')`'s
        // space-separated form — normalize here so string comparison against
        // those (in pickForWake) is apples to apples, not a format mismatch
        // that would silently push every agent start "after" its real time.
        `SELECT objective_id, strftime('%Y-%m-%d %H:%M:%S', created_at) AS created_at FROM session_starts
          WHERE kind = 'spawn' AND reason = 'agent' AND objective_id IN (${placeholders(ids.length)})
          ORDER BY created_at ASC`,
      )
      .all(...ids) as AgentStart[]
  } catch {
    return []
  }
}

/**
 * This wake's own run: it ends when the wake reached review/done/cancelled,
 * else falls back to its `updated_at` — NEVER the next wake's `created_at`
 * (obj 901030, operator review of PR #812). The old next-wake boundary let a
 * card started from chat, or by a person, in the GAP after this wake finished
 * but before the next one fired get wrongly credited to this wake.
 */
const TERMINAL_WAKE_STATUSES = new Set(['review', 'ai_review', 'done', 'cancelled'])

/**
 * Null means the wake is STILL running — no upper bound yet, so a later
 * status change on an owned card can still be attributed to it. Once the
 * wake has a recorded end (an own status event, or — for rows written before
 * that event existed — its terminal `status`/`updated_at`), everything after
 * that belongs to whatever comes next: a later wake, a chat message, or a
 * person — never this wake.
 */
function wakeRunEnd(wake: CardRow, wakeEndEvents: StatusEvent[]): string | null {
  const own = wakeEndEvents.find(e => e.objective_id === wake.id)
  if (own) return own.created_at
  if (TERMINAL_WAKE_STATUSES.has(wake.status)) return wake.updated_at
  return null
}

/**
 * The card this one wake's run actually started or closed: prefer a real
 * `agent`-reason session spawn inside the run's window, else the first
 * 'working' transition (else 'done'/'cancelled') in that same window —
 * excluding the wakes themselves either way.
 */
function pickForWake(
  wake: CardRow,
  end: string | null,
  events: StatusEvent[],
  agentStarts: AgentStart[],
  wakeIds: Set<number>,
): StatusEvent | null {
  const inWindow = (at: string) => at >= wake.created_at && (end == null || at <= end)
  const spawn = agentStarts.find(a => !wakeIds.has(a.objective_id) && inWindow(a.created_at))
  if (spawn) return { objective_id: spawn.objective_id, to_value: 'working', created_at: spawn.created_at }
  let started: StatusEvent | null = null
  let closed: StatusEvent | null = null
  for (const ev of events) {
    if (wakeIds.has(ev.objective_id)) continue
    if (!inWindow(ev.created_at)) continue
    if (ev.to_value === 'working') started ??= ev
    else closed ??= ev
  }
  return started ?? closed
}

/** Every wake's picked card, by its own run's window (see `pickForWake`). */
function pickedByWindow(
  wakeRows: CardRow[],
  events: StatusEvent[],
  wakeEndEvents: StatusEvent[],
  agentStarts: AgentStart[],
  wakeIds: Set<number>,
): Map<number, StatusEvent> {
  const out = new Map<number, StatusEvent>()
  for (const w of wakeRows) {
    const pick = pickForWake(w, wakeRunEnd(w, wakeEndEvents), events, agentStarts, wakeIds)
    if (pick) out.set(w.id, pick)
  }
  return out
}

function entryFor(
  w: CardRow,
  kids: CardRow[],
  spend: Map<number, number>,
  signals: Map<number, CardSignals>,
  windowPick?: CardRow,
): BotActivityEntry {
  const pickedRow = kids[0] ?? windowPick ?? null
  const picked = pickedRow ? ref(pickedRow, spend) : null
  return {
    wake_id: w.id,
    at: w.created_at,
    status: w.status,
    picked,
    did: didLine(w),
    pr_url: w.pr_url || picked?.pr_url || null,
    cost_usd: round((spend.get(w.id) ?? 0) + (picked?.spent_usd ?? 0)),
    disposition: w.job_disposition,
    needs_you: signals.get(w.id)?.needs_you ?? [],
  }
}

const EVENT_ITEM_KIND: Record<string, BotActivityItemKind | undefined> = {
  working: 'started',
  review: 'review',
  ai_review: 'review',
  done: 'done',
  cancelled: 'cancelled',
}

const EVENT_ITEM_LABEL: Record<BotActivityItemKind, string> = {
  wake: 'Wake',
  filed: 'Filed',
  started: 'Started',
  review: 'Entered review',
  done: 'Finished',
  cancelled: 'Cancelled',
  pr: 'PR',
}

interface ActivityEventRow {
  objective_id: number
  kind: string
  to_value: string | null
  detail: string | null
  created_at: string
}

/** Everything the board already logs for these cards: filed, status moves, PRs. */
function loadActivityEvents(db: Database, ids: number[], limit: number): ActivityEventRow[] {
  if (ids.length === 0) return []
  try {
    return db
      .prepare(
        `SELECT objective_id, kind, to_value, detail, created_at FROM objective_events
          WHERE objective_id IN (${placeholders(ids.length)})
            AND (kind = 'created' OR kind = 'pr'
                 OR (kind = 'status' AND to_value IN ('working', 'review', 'ai_review', 'done', 'cancelled')))
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...ids, limit) as ActivityEventRow[]
  } catch {
    return []
  }
}

/**
 * The unified Activity feed (obj 901030): every action on a card this bot owns
 * — filed, started, entered review, finished, cancelled, a PR opened/merged/
 * closed — not only its High Agency wakes. A wake fire is folded in as its own
 * `kind: 'wake'` item so the two streams read as one timeline, newest first.
 */
function buildActivityItems(
  cardById: Map<number, CardRow>,
  events: ActivityEventRow[],
  wakeIds: Set<number>,
  spend: Map<number, number>,
  wakeEntries: BotActivityEntry[],
  limit: number,
): BotActivityItem[] {
  const items: BotActivityItem[] = []
  for (const ev of events) {
    if (wakeIds.has(ev.objective_id)) continue // the wake's own lifecycle is its 'wake' item below
    const card = cardById.get(ev.objective_id)
    if (!card) continue
    let kind: BotActivityItemKind | undefined
    let prUrl: string | null = null
    if (ev.kind === 'created') kind = 'filed'
    else if (ev.kind === 'status') kind = EVENT_ITEM_KIND[ev.to_value ?? '']
    else if (ev.kind === 'pr') {
      kind = 'pr'
      prUrl = ev.detail || card.pr_url || null
    }
    if (!kind) continue
    const label = ev.kind === 'pr' ? `PR ${ev.to_value ?? 'opened'}` : EVENT_ITEM_LABEL[kind]
    items.push({
      key: `${kind}:${ev.objective_id}:${ev.created_at}`,
      kind,
      at: ev.created_at,
      card: ref(card, spend),
      wake_id: null,
      detail: label,
      pr_url: prUrl,
    })
  }
  for (const e of wakeEntries) {
    items.push({
      key: `wake:${e.wake_id}:${e.at}`,
      kind: 'wake',
      at: e.at,
      card: e.picked ?? { id: e.wake_id, title: 'High Agency wake', status: e.status, pr_url: e.pr_url, spent_usd: e.cost_usd },
      wake_id: e.wake_id,
      detail: e.did,
      pr_url: e.pr_url,
    })
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return items.slice(0, limit)
}

export interface BotActivityOptions extends BotWorkOptions {
  limit?: number
  now?: Date
}

/** SQLite datetime text for `ms`. */
function sqlTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

export function buildBotActivity(db: Database, bot: BotRef, opts: BotActivityOptions): BotActivityResponse {
  const now = opts.now ?? new Date()
  const since = sqlTime(now.getTime() - 24 * 3600_000)
  const { wakes, scope, workspaces, rows: owned, signals: ownedSignals } = ownedCardsWithSignals(db, bot, opts.viewer)
  const wakeRows = loadWakes(db, wakes, scope, Math.min(200, Math.max(1, opts.limit ?? 30)))
  const wakeIdSet = new Set(wakeRows.map(w => w.id))
  const kids = loadWakeChildren(db, wakeRows.map(w => w.id), scope)
  // obj 901030: when a wake started or closed an EXISTING card instead of
  // filing a new (linked) one, source_job_id/parent_id has nothing to find —
  // fall back to the card's own status-change timestamp landing inside this
  // wake's window.
  const cardById = new Map(owned.map(r => [r.id, r]))
  const ownedIdsForEvents = owned.map(r => r.id)
  const statusEvents = loadStatusEvents(db, ownedIdsForEvents)
  const wakeEndEvents = loadWakeEndEvents(db, wakeRows.map(w => w.id))
  const agentStarts = loadAgentSessionStarts(db, ownedIdsForEvents)
  const windowPicks = pickedByWindow(wakeRows, statusEvents, wakeEndEvents, agentStarts, wakeIdSet)
  const allIds = [
    ...wakeRows.map(w => w.id),
    ...[...kids.values()].flat().map(k => k.id),
    ...[...windowPicks.values()].map(p => p.objective_id),
  ]
  const spend = measuredSpend(db, allIds)
  const wakeSignals = cardSignals(db, wakeRows)
  const entries = wakeRows.map(w => {
    const windowPick = kids.get(w.id)?.length ? undefined : cardById.get(windowPicks.get(w.id)?.objective_id ?? -1)
    return entryFor(w, kids.get(w.id) ?? [], spend, wakeSignals, windowPick)
  })

  // The unified feed (obj 901030): every action on a bot-owned card, wake rows
  // folded in alongside it.
  const activityEvents = loadActivityEvents(db, ownedIdsForEvents, Math.min(500, Math.max(1, opts.limit ?? 30) * 5))
  const items = buildActivityItems(cardById, activityEvents, wakeIdSet, spend, entries, Math.max(1, opts.limit ?? 30))

  // Daily summary — what shipped, spend, what's next.
  const ownedIds = owned.map(r => r.id)
  const wakeIdsAll = new Set(owned.filter(r => r.routine_id != null && wakes.includes(r.routine_id)).map(r => r.id))
  let doneIds = new Set<number>()
  if (ownedIds.length) {
    try {
      doneIds = new Set(
        (db
          .prepare(
            `SELECT DISTINCT objective_id AS id FROM objective_events
              WHERE kind = 'status' AND to_value = 'done' AND created_at >= ?
                AND objective_id IN (${placeholders(ownedIds.length)})`,
          )
          .all(since, ...ownedIds) as { id: number }[]).map(r => r.id),
      )
    } catch { /* events absent */ }
  }
  const shippedRows = owned.filter(
    r => r.status === 'done' && !wakeIdsAll.has(r.id) && (doneIds.has(r.id) || r.updated_at >= since),
  )
  const ownedSpend = measuredSpend(db, shippedRows.map(r => r.id))
  let spent = 0
  const spendIds = [...new Set([...ownedIds, ...allIds])]
  if (spendIds.length) {
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(total_cost_usd), 0) AS usd FROM session_intel
            WHERE ended_at >= ? AND objective_id IN (${placeholders(spendIds.length)})`,
        )
        .get(since, ...spendIds) as { usd: number }
      spent = row.usd
    } catch { /* intel absent */ }
  }
  const queued = owned
    .filter(r => r.status === 'queue' && !wakeIdsAll.has(r.id))
    .slice(0, 3)
    .map(r => ({ id: r.id, title: r.title }))
  const needsYou = owned.filter(r => (ownedSignals.get(r.id)?.needs_you.length ?? 0) > 0).length
  let nextWake: string | null = null
  let highAgencyOn = false
  try {
    const v = highAgencyView(bot.slug, now)
    nextWake = v.next_wake_at
    highAgencyOn = v.enabled
  } catch { /* table absent */ }

  return {
    slug: bot.slug,
    high_agency: highAgencyOn,
    workspaces,
    summary: {
      since,
      wakes: wakeRows.filter(w => w.created_at >= since).length,
      shipped: shippedRows.map(r => ref(r, ownedSpend)),
      spent_usd: round(spent),
      next: { next_wake_at: nextWake, queued, needs_you: needsYou },
    },
    entries,
    items,
  }
}

/** One wake, expanded. Null when it is not this bot's wake or the viewer may not see it. */
export function buildBotActivityRun(db: Database, bot: BotRef, wakeId: number, opts: BotWorkOptions): BotActivityRun | null {
  const wakes = wakeRoutineIds(db, bot.slug)
  const scope = botViewScope(db, bot.slug, opts.viewer)
  const [w] = loadWakes(db, wakes, scope, 1, wakeId)
  if (!w) return null
  const kids = loadWakeChildren(db, [w.id], scope).get(w.id) ?? []
  // obj 901030: same provenance-first, own-run-bounded pick as buildBotActivity
  // — this wake's window runs from its own created_at to when IT reached
  // review/done (never the next wake's start — see pickForWake/wakeRunEnd).
  let windowPick: CardRow | undefined
  if (kids.length === 0) {
    const owned = ownedCardsWithSignals(db, bot, opts.viewer).rows
    const ownedIds = owned.map(r => r.id)
    const cardById = new Map(owned.map(r => [r.id, r]))
    const end = wakeRunEnd(w, loadWakeEndEvents(db, [w.id]))
    const events = loadStatusEvents(db, ownedIds)
    const agentStarts = loadAgentSessionStarts(db, ownedIds)
    const pick = pickForWake(w, end, events, agentStarts, new Set([w.id]))
    windowPick = pick ? cardById.get(pick.objective_id) : undefined
  }
  const spend = measuredSpend(db, [w.id, ...kids.map(k => k.id), ...(windowPick ? [windowPick.id] : [])])
  const signals = cardSignals(db, [w])
  const base = entryFor(w, kids, spend, signals, windowPick)
  return {
    ...base,
    title: w.title,
    workspace: w.workspace,
    summary: w.last_session_summary,
    review_note: w.job_review_note,
    wake_spent_usd: round(spend.get(w.id) ?? 0),
    ceiling_usd: signals.get(w.id)?.ceiling_usd ?? null,
    children: (kids.length ? kids : windowPick ? [windowPick] : []).map(k => ref(k, spend)),
    updated_at: w.updated_at,
  }
}

export { isHighAgencyActivityCard } from './high-agency-cards.js'
