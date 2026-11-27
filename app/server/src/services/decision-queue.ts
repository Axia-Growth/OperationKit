/**
 * The "Needs you" decision stack + stale asks that clear themselves (obj 901084).
 *
 * WHY. Operator's bot chat showed "NEEDS YOU · NEEDS A DECISION" for card #901076
 * with no decision under it, and Approve answered "This card is done. Reopen it
 * before sending a message." The ask had outlived the card: it finished, and the
 * notice stayed behind as a dead button. Decisions were also scattered — one per
 * card, one per bot chat — with no single place to work through them.
 *
 * This module is the rule for both:
 *
 *   relevance  `staleReasonFor` decides whether an open decision still needs the
 *              person. A card that is cancelled, deleted, closed by a person, or
 *              finished WITHOUT asking (a done card whose job did not end with
 *              `needs_review`) makes its ask stale. The one case a finished card
 *              keeps its decision is a job that ended BY asking (done +
 *              job_disposition = needs_review, not closed by a person, and no newer
 *              run of the same job since) — that is the "Reopen and apply" case
 *              from PR 815, and it stays.
 *   sweep      `sweepStaleDecisions` withdraws every stale open decision with the
 *              plain reason the person sees ("no longer needed (card finished)"),
 *              writes that line into its thread, and adopts recent legacy asks
 *              (a job `needs_review` with no decision row) as flagged decisions so
 *              they get a briefing written for them (decision-autobrief.ts, obj
 *              901151) before they reach the queue. The poller runs it
 *              every 15 s, the status route runs it for one card the moment the
 *              card ends, and every queue read runs it first, so the queue never
 *              shows a stale ask.
 *   queue      `listDecisionQueue` / `decisionQueueCount`: every open decision the
 *              viewer may answer (admin: all; member: cards they own — the same
 *              rule the decide route enforces), ordered by urgency, then age.
 *   chat       `resolveNeedsYouMessages` re-reads each bot "needs you" post at read
 *              time: a post whose card ended or whose decision was cleared is marked
 *              `resolved` (the UI collapses it to one line with no buttons); a
 *              decision post with no decision id is linked to the card's open one.
 *              Stored chat rows are never rewritten.
 *
 * Nothing here decides, sends, reopens or approves anything. Withdrawing a stale
 * ask only removes a question nobody needs to answer.
 */
import type Database from 'better-sqlite3'
import {
  BOT_NEEDS_YOU_KIND,
  STALE_REASONS,
  compareQueueItems,
  urgencyForCard,
  type DecidedHistoryItem,
  type DecisionQueueItem,
  type StaleReason,
} from '@operationkit/shared'
import { getDecision, openDecisionForCard, raiseDecision } from './decisions.js'

/** The card columns relevance and the queue need. */
export interface DecisionCardRow {
  id: number
  title: string
  status: string
  workspace: string | null
  project: string | null
  terminal_by_human: number | null
  job_disposition: string | null
  job_review_note?: string | null
  routine_id: number | null
  owner_bot: string | null
  agent_context: string | null
  created_by?: number | null
  assigned_user_id?: number | null
}

const CARD_COLS = 'id, title, status, workspace, project, terminal_by_human, job_disposition, job_review_note, routine_id, owner_bot, agent_context, created_by, assigned_user_id'

function loadCard(db: Database.Database, id: number): DecisionCardRow | undefined {
  return db.prepare(`SELECT ${CARD_COLS} FROM objectives WHERE id = ?`).get(id) as DecisionCardRow | undefined
}

/**
 * A newer run of the same job that itself finished BY ASKING — done,
 * job_disposition = needs_review, not closed by a person, and it raised its
 * own decision row — if any. A later run that is still working, or that
 * finished `complete`, did not replace the ask: it must not retire it (obj
 * 901675 — hourly High Agency wakes lost two asks this way on 2026-11-20).
 */
function newerRunOf(db: Database.Database, card: DecisionCardRow): number | null {
  if (card.routine_id == null) return null
  const r = db
    .prepare(
      `SELECT o.id FROM objectives o
        WHERE o.routine_id = ? AND o.id > ?
          AND o.status = 'done' AND NOT COALESCE(o.terminal_by_human, 0)
          AND o.job_disposition = 'needs_review'
          AND EXISTS (SELECT 1 FROM decisions d WHERE d.objective_id = o.id)
        ORDER BY o.id LIMIT 1`,
    )
    .get(card.routine_id, card.id) as { id: number } | undefined
  return r?.id ?? null
}

/** A job that finished BY asking: the one finished card whose decision stays live. */
export function endedByAsking(card: Pick<DecisionCardRow, 'status' | 'terminal_by_human' | 'job_disposition'>): boolean {
  return card.status === 'done' && !Number(card.terminal_by_human) && card.job_disposition === 'needs_review'
}

/**
 * Why an open decision on this card no longer needs the person, or null when it
 * still does. `newerRun` = a later run of the same job (see `newerRunOf`).
 */
export function staleReasonFor(card: DecisionCardRow | undefined | null, newerRun: number | null = null): StaleReason | null {
  if (!card) return STALE_REASONS.missing
  if (card.status === 'cancelled') return STALE_REASONS.cancelled
  if (card.status !== 'done') return null
  if (Number(card.terminal_by_human)) return STALE_REASONS.closedByPerson
  if (card.job_disposition !== 'needs_review') return STALE_REASONS.finished
  if (newerRun != null) return STALE_REASONS.newerRun
  return null
}

/** Stale reason for a card read from the DB (includes the newer-run check). */
export function staleReasonForCard(db: Database.Database, objectiveId: number): StaleReason | null {
  const card = loadCard(db, objectiveId)
  return staleReasonFor(card, card && endedByAsking(card) ? newerRunOf(db, card) : null)
}

function withdrawStale(db: Database.Database, decisionId: number, objectiveId: number, reason: StaleReason): boolean {
  const res = db
    .prepare("UPDATE decisions SET state = 'withdrawn', withdrawn_reason = ?, updated_at = datetime('now') WHERE id = ? AND state = 'open'")
    .run(reason, decisionId)
  if (!res.changes) return false
  db.prepare("INSERT INTO decision_messages (decision_id, role, author, body, status) VALUES (?, 'system', NULL, ?, NULL)")
    .run(decisionId, `Cleared automatically: ${reason}. Card #${objectiveId} does not need an answer any more, so nothing was sent.`)
  return true
}

export interface SweepResult {
  /** Stale open decisions withdrawn. */
  cleared: number
  /** Legacy needs_review asks adopted as flagged decisions. */
  adopted: number
  clearedIds: number[]
}

/** How far back a legacy needs_review ask (no decision row) is adopted into the queue. */
export const LEGACY_ADOPT_DAYS = 7

/**
 * Withdraw every stale open decision (optionally for one card) and adopt recent
 * legacy asks. Idempotent: a second run finds nothing to do.
 */
export function sweepStaleDecisions(db: Database.Database, opts: { objectiveId?: number; adopt?: boolean } = {}): SweepResult {
  // getDecision() creates the tables on first use.
  getDecision(db, -1)
  const one = opts.objectiveId != null
  const rows = db
    .prepare(
      `SELECT d.id, d.objective_id FROM decisions d LEFT JOIN objectives o ON o.id = d.objective_id
        WHERE d.state = 'open' AND (o.id IS NULL OR o.status IN ('done', 'cancelled'))${one ? ' AND d.objective_id = ?' : ''}`,
    )
    .all(...(one ? [opts.objectiveId] : [])) as { id: number; objective_id: number }[]
  const clearedIds: number[] = []
  const memo = new Map<number, StaleReason | null>()
  for (const r of rows) {
    if (!memo.has(r.objective_id)) memo.set(r.objective_id, staleReasonForCard(db, r.objective_id))
    const reason = memo.get(r.objective_id)
    if (reason && withdrawStale(db, r.id, r.objective_id, reason)) clearedIds.push(r.id)
  }

  let adopted = 0
  if (opts.adopt !== false) {
    // Legacy asks: a job that parked on needs_review before decision briefings
    // existed has no decision row, so it never reached a queue and its chat post
    // had nothing to show. Adopt recent ones as flagged decisions ("no briefing
    // given"). NOT EXISTS keeps it once per card; a card with ANY decision row
    // (answered or cleared) is never re-adopted.
    const legacy = db
      .prepare(
        `SELECT ${CARD_COLS} FROM objectives o
          WHERE o.job_disposition = 'needs_review'
            AND o.status != 'cancelled'
            AND o.updated_at >= datetime('now', ?)
            ${one ? 'AND o.id = ?' : ''}
            AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.objective_id = o.id)
          ORDER BY o.id LIMIT 200`,
      )
      .all(`-${LEGACY_ADOPT_DAYS} days`, ...(one ? [opts.objectiveId] : [])) as DecisionCardRow[]
    for (const c of legacy) {
      if (staleReasonFor(c, endedByAsking(c) ? newerRunOf(db, c) : null)) continue
      const out = raiseDecision(db, {
        objective_id: c.id,
        workspace: c.workspace ?? '',
        source: 'job_disposition',
        agent_slug: c.owner_bot ?? (c.agent_context && c.agent_context !== 'general' ? c.agent_context : null),
        briefing: null,
        raw_note: c.job_review_note ?? null,
        allowIncomplete: true,
      })
      if (out.ok) adopted++
    }
  }
  return { cleared: clearedIds.length, adopted, clearedIds }
}

/** The status route calls this the moment a card ends. Never throws. */
export function clearStaleDecisionsForCard(db: Database.Database, objectiveId: number): SweepResult {
  try {
    return sweepStaleDecisions(db, { objectiveId, adopt: false })
  } catch (err) {
    console.warn(`[decision-queue] could not clear decisions for card ${objectiveId}:`, err instanceof Error ? err.message : String(err))
    return { cleared: 0, adopted: 0, clearedIds: [] }
  }
}

/**
 * obj 901151 — the moment a card reaches done/cancelled (ANY path: the status
 * route, the poller's session-end routing, hygiene, the Agent API; all of them
 * broadcast `objective_updated`, which is where this is hooked, see
 * services/decision-card-end.ts): withdraw its stale asks at once instead of
 * on the next sweep, so the stack never shows a finished card's ask.
 */
export function onCardEnded(db: Database.Database, objectiveId: number): SweepResult {
  return clearStaleDecisionsForCard(db, objectiveId)
}

export const SWEEP_INTERVAL_MS = 15_000
let lastSweep = 0
/** Throttled entry point for the poller. */
export function maybeSweepStaleDecisions(db: Database.Database, nowMs = Date.now()): SweepResult | null {
  if (nowMs - lastSweep < SWEEP_INTERVAL_MS) return null
  lastSweep = nowMs
  return sweepStaleDecisions(db)
}

/**
 * Decorate a decision for display: an answered `card_done` decision offers
 * "Reopen and apply" only while the ask is still relevant.
 */
export function withReopenFlag<T extends { state: string; outcome: string | null; objective_id: number; can_reopen?: boolean }>(db: Database.Database, d: T): T {
  if (d.state !== 'decided' || (d.outcome !== 'card_done' && d.outcome !== 'delivered')) return d
  let stale: StaleReason | null = null
  try { stale = staleReasonForCard(db, d.objective_id) } catch { /* keep offering */ }
  // obj 901151: an answer the bot already picked up in a later session is applied; no second copy.
  if (!stale && d.outcome === 'delivered' && deliveryConsumed(db, (d as { id?: number }).id)) return { ...d, can_reopen: false }
  return { ...d, can_reopen: !stale }
}

/** True once a delivered answer was picked up by a bot session (or a reopen). */
export function deliveryConsumed(db: Database.Database, decisionId: number | undefined): boolean {
  if (decisionId == null) return false
  try {
    const r = db.prepare('SELECT delivered_consumed_at FROM decisions WHERE id = ?').get(decisionId) as { delivered_consumed_at: string | null } | undefined
    return !!r?.delivered_consumed_at
  } catch {
    return false
  }
}

/** A bot's own still-open decisions (so a High Agency wake does not ask the same thing twice). */
export interface PendingWakeDecision {
  id: number
  objective_id: number
  title: string
  question: string
}

/**
 * The still-pending decisions this bot itself raised in this workspace (obj
 * 901675): with hourly wakes, an unanswered ask from an earlier wake otherwise
 * looks invisible to the next one, which then raises the same question again.
 * Only decisions the sweep would keep (see `staleReasonFor`) are listed — a
 * genuinely stale one is withdrawn before it ever reaches here.
 */
export function pendingWakeDecisions(db: Database.Database, agentSlug: string, workspace: string): PendingWakeDecision[] {
  if (!agentSlug || !workspace) return []
  const rows = db
    .prepare(
      `SELECT d.id, d.objective_id, d.question, o.title FROM decisions d
         JOIN objectives o ON o.id = d.objective_id
        WHERE d.state = 'open' AND d.incomplete = 0 AND d.agent_slug = ? AND d.workspace = ?
        ORDER BY d.created_at ASC`,
    )
    .all(agentSlug, workspace) as { id: number; objective_id: number; question: string; title: string }[]
  return rows
    .filter(r => !staleReasonForCard(db, r.objective_id))
    .map(r => ({ id: r.id, objective_id: r.objective_id, title: r.title, question: r.question }))
}

// ── the queue ──────────────────────────────────────────────────────────────

export interface QueueViewer {
  id: number
  role: string
}

/** SQL filter: the cards this viewer may answer a decision on (decide route's rule). */
function visibility(viewer: QueueViewer): { sql: string; args: unknown[] } {
  if (viewer.role === 'admin') return { sql: '', args: [] }
  return {
    sql: ' AND (o.created_by = ? OR o.assigned_user_id = ? OR EXISTS (SELECT 1 FROM objective_assignees a WHERE a.objective_id = o.id AND a.user_id = ?))',
    args: [viewer.id, viewer.id, viewer.id],
  }
}

/**
 * obj 901151 — what may stand in the stack at all, in SQL:
 *   - never a decision with no briefing (`incomplete`): it is either briefed by
 *     services/decision-autobrief.ts within seconds of its card stopping, or
 *     withdrawn there as an FYI. "No briefing given" never reaches a person.
 *   - never a decision on a cancelled card, or on a done card, with ONE
 *     exception: a job that ended BY asking (done + job_disposition =
 *     needs_review, not closed by a person). That is how every routine and High
 *     Agency wake asks (the poller must auto-close a job card so the routine's
 *     max_queue_depth slot frees), so it is the bot's live ask, and Approve on it
 *     is delivered to the bot (decision-apply.ts `delivered`), never a dead end.
 *     A newer run of the same job retires it (checked in JS, `newerRunOf`).
 */
export const STACK_SQL = ` AND d.incomplete = 0 AND (o.status NOT IN ('done', 'cancelled') OR (o.status = 'done' AND o.job_disposition = 'needs_review' AND COALESCE(o.terminal_by_human, 0) = 0))`

function botFor(card: DecisionCardRow, agentSlug: string | null): string | null {
  return card.owner_bot || (card.agent_context && card.agent_context !== 'general' ? card.agent_context : null) || agentSlug || null
}

export interface QueueQuery {
  workspace?: string | null
  limit?: number
}

/**
 * Every open, still-relevant decision this viewer may answer, ordered by
 * urgency (work stopped first), then age (oldest first).
 */
export function listDecisionQueue(db: Database.Database, viewer: QueueViewer, q: QueueQuery = {}): DecisionQueueItem[] {
  getDecision(db, -1)
  const vis = visibility(viewer)
  const ws = q.workspace ? ' AND o.workspace = ?' : ''
  const rows = db
    .prepare(
      `SELECT d.id AS decision_id, ${CARD_COLS.split(', ').map(c => `o.${c}`).join(', ')}
         FROM decisions d JOIN objectives o ON o.id = d.objective_id
        WHERE d.state = 'open'${STACK_SQL}${vis.sql}${ws}
        ORDER BY d.id`,
    )
    .all(...vis.args, ...(q.workspace ? [q.workspace] : [])) as (DecisionCardRow & { decision_id: number })[]
  const items: DecisionQueueItem[] = []
  for (const r of rows) {
    // Belt and braces: the sweep ran first, but never show a stale ask.
    if (r.status === 'done' || r.status === 'cancelled') {
      if (staleReasonFor(r, endedByAsking(r) ? newerRunOf(db, r) : null)) continue
    }
    const decision = getDecision(db, r.decision_id)
    if (!decision) continue
    items.push({
      decision,
      card: { id: r.id, title: r.title, status: r.status, workspace: r.workspace, project: r.project, bot: botFor(r, decision.agent_slug) },
      urgency: urgencyForCard(r.status),
    })
  }
  items.sort(compareQueueItems)
  return items.slice(0, Math.max(1, Math.min(500, q.limit ?? 200)))
}

/**
 * The viewer's decided items, most recently decided first (obj 901139): the
 * "Your recent decisions" list under the stack. Same visibility rule as the
 * queue. Each item carries its card so it links back to the card thread, and
 * the full decision (briefing, choice, own answer, outcome, thread).
 */
export function listDecidedHistory(db: Database.Database, viewer: QueueViewer, q: QueueQuery = {}): DecidedHistoryItem[] {
  getDecision(db, -1)
  const vis = visibility(viewer)
  const ws = q.workspace ? ' AND o.workspace = ?' : ''
  const limit = Math.max(1, Math.min(100, Math.floor(q.limit ?? 30)))
  const rows = db
    .prepare(
      `SELECT d.id AS decision_id, ${CARD_COLS.split(', ').map(c => `o.${c}`).join(', ')}
         FROM decisions d JOIN objectives o ON o.id = d.objective_id
        WHERE d.state = 'decided'${vis.sql}${ws}
        ORDER BY COALESCE(d.decided_at, d.updated_at) DESC, d.id DESC
        LIMIT ?`,
    )
    .all(...vis.args, ...(q.workspace ? [q.workspace] : []), limit) as (DecisionCardRow & { decision_id: number })[]
  const items: DecidedHistoryItem[] = []
  for (const r of rows) {
    const decision = getDecision(db, r.decision_id)
    if (!decision) continue
    items.push({
      decision: withReopenFlag(db, decision),
      card: { id: r.id, title: r.title, status: r.status, workspace: r.workspace, project: r.project, bot: botFor(r, decision.agent_slug) },
    })
  }
  return items
}

/** The badge number: open, still-relevant decisions this viewer may answer. */
export function decisionQueueCount(db: Database.Database, viewer: QueueViewer, q: Pick<QueueQuery, 'workspace'> = {}): number {
  getDecision(db, -1)
  const vis = visibility(viewer)
  const ws = q.workspace ? ' AND o.workspace = ?' : ''
  const rows = db
    .prepare(
      `SELECT o.id, o.status, o.terminal_by_human, o.job_disposition, o.routine_id
         FROM decisions d JOIN objectives o ON o.id = d.objective_id
        WHERE d.state = 'open'${STACK_SQL}${vis.sql}${ws}`,
    )
    .all(...vis.args, ...(q.workspace ? [q.workspace] : [])) as DecisionCardRow[]
  let n = 0
  for (const r of rows) {
    if ((r.status === 'done' || r.status === 'cancelled') && staleReasonFor(r, endedByAsking(r) ? newerRunOf(db, r) : null)) continue
    n++
  }
  return n
}

// ── bot chat "needs you" posts ─────────────────────────────────────────────

export interface NeedsYouResolved {
  /** One plain line: why this post no longer needs anything. */
  text: string
  reason: StaleReason | 'answered elsewhere'
}

interface ChatRowLike {
  role: string
  meta?: Record<string, unknown> | null
}

/**
 * Read-time pass over bot chat messages (stored rows untouched): a needs-you
 * post whose card ended or whose decision was cleared gets `meta.resolved`; a
 * decision post is pointed at the card's CURRENT open decision.
 */
export function resolveNeedsYouMessages<T extends ChatRowLike>(db: Database.Database, messages: T[]): T[] {
  const cards = new Map<number, { stale: StaleReason | null; ended: boolean }>()
  const openFor = new Map<number, number | null>()
  const cardState = (id: number) => {
    if (!cards.has(id)) {
      try {
        const card = loadCard(db, id)
        const stale = staleReasonFor(card, card && endedByAsking(card) ? newerRunOf(db, card) : null)
        cards.set(id, { stale, ended: !card || card.status === 'done' || card.status === 'cancelled' })
      } catch {
        cards.set(id, { stale: null, ended: false })
      }
    }
    return cards.get(id)!
  }
  const open = (id: number): number | null => {
    if (!openFor.has(id)) {
      try { openFor.set(id, openDecisionForCard(db, id)?.id ?? null) } catch { openFor.set(id, null) }
    }
    return openFor.get(id) ?? null
  }
  return messages.map(m => {
    const meta = m.meta
    if (m.role !== 'assistant' || !meta || meta.kind !== BOT_NEEDS_YOU_KIND) return m
    const cardId = Number(meta.objective_id)
    if (!Number.isInteger(cardId)) return m
    if (meta.reason !== 'decision') {
      // Approval / ceiling / blocker posts only make sense on a live card.
      const c = cardState(cardId)
      return c.ended ? { ...m, meta: { ...meta, resolved: resolvedFor(c.stale ?? STALE_REASONS.finished) } } : m
    }
    const openId = open(cardId)
    const linked = typeof meta.decision_id === 'number' ? meta.decision_id : null
    if (linked != null) {
      let d: ReturnType<typeof getDecision> = null
      try { d = getDecision(db, linked) } catch { /* table missing */ }
      // Open, or answered (the briefing shows the choice and its outcome): keep it.
      if (d?.state === 'open' || d?.state === 'decided') return m
      // Superseded: point at the newer open one on the same card.
      if (openId != null) return { ...m, meta: { ...meta, decision_id: openId } }
      const reason = d?.withdrawn_reason || cardState(cardId).stale || 'answered elsewhere'
      return { ...m, meta: { ...meta, resolved: resolvedFor(reason) } }
    }
    if (openId != null) return { ...m, meta: { ...meta, decision_id: openId } }
    // No decision record at all: the post is live only while the card is.
    const c = cardState(cardId)
    if (c.ended) return { ...m, meta: { ...meta, resolved: resolvedFor(c.stale ?? STALE_REASONS.finished) } }
    return m
  })
}

function resolvedFor(reason: string): NeedsYouResolved {
  const known = Object.values(STALE_REASONS) as string[]
  if (known.includes(reason)) {
    const r = reason as StaleReason
    return { reason: r, text: `Resolved: ${r}.` }
  }
  return { reason: 'answered elsewhere', text: `Resolved: ${reason.replace(/^superseded/, 'replaced')}.` }
}
