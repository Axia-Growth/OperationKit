// ── What a chat bot can see about a card it reads or owns (obj 901277) ──
//
// The incident: the owner answered decision #17 on card #901231 ("A: Yes, as
// designed"), then asked Operation Kit Dev — Full access, the card's owner — to
// confirm the card was good. Dev read the card with card_read, saw `working`,
// and said it could not tell which option was chosen. It also flagged the stale
// "queued and held, do not start until Operator approves" line as if it were live.
// The answer existed in `decisions`, on the card thread and as a timeline
// divider; no chat tool returned any of it, and the bot's turn context did not
// list the cards it owns at all.
//
// This file is the ONE place that renders that context, so card_read,
// get_objective and the chat system prompt cannot drift apart:
//   - `cardDecisionsForBot`   decisions on a card: briefing, choice, who/when/result
//   - `cardThreadForBot`      the card thread's visible anchors (summaries, dividers
//                             — including the follow-up that applied a choice —
//                             errors), clipped and bounded
//   - `cardOwnerAndGrants`    the owning bot and its ACTIVE approve-on-my-behalf
//                             grants in the card's workspace (ids + action names
//                             only; a grant has no token or secret to leak)
//   - `ownedCardsPromptBlock` the per-turn system-prompt block: the bot's open
//                             cards, open decisions on them, and recent answers
//
// Everything is read-only and size-bounded. Visibility is the CALLER's job:
// each caller has already decided the person (and bot) may see the card.
import type { Database } from 'better-sqlite3'
import {
  DENY_CHOICE,
  OWN_ANSWER_CHOICE,
  chosenLabel,
  optionFor,
  type DecisionView,
  type SessionMessage,
  type ThreadSegment,
} from '@operationkit/shared'
import { listDecisionsForCard } from '../decisions.js'
import { listObjectiveThreadSessionIds } from '../objective-sessions.js'
import { getSessionOutput } from '../stream-parser.js'
import { buildThreadTimeline } from '../thread-timeline.js'
import { cardOwnerBot, cardOwnerResolver, ownerHasSlug, type CardOwnerBot } from '../bots/card-owner.js'
import { listGrantsForBot } from '../delegated-approvals.js'

function clip(text: unknown, max: number): string | null {
  if (text === null || text === undefined) return null
  const s = String(text).trim()
  if (!s) return null
  return s.length > max ? `${s.slice(0, max)}… (clipped)` : s
}

function oneLine(text: unknown, max: number): string {
  return (clip(String(text ?? '').replace(/\s+/g, ' '), max) ?? '')
}

// ── decisions ──

export interface BotDecisionView {
  id: number
  state: DecisionView['state']
  question: string
  context?: string | null
  options: { key: string; label: string; next?: string }[]
  recommended: string | null
  recommended_why?: string | null
  /** The option key, `deny`, or `own` (the person answered in their own words). Null while open. */
  chosen: string | null
  /** The chosen option's label (or "No to all options" / "Own answer"). */
  chosen_label: string | null
  /** One line a bot can repeat: "Chose A: Yes, as designed". */
  answer: string | null
  /** The person's own words (an own answer, or a note on an option). */
  decision_note: string | null
  decided_by: string | null
  decided_at: string | null
  /** What applying the choice did to the card: sent / queued / delivered / card_done / reopened / recorded / failed. */
  outcome: string | null
  outcome_text: string | null
  withdrawn_reason?: string | null
  raised_by: string | null
  raised_at: string
  /** The decision's Q&A side thread (newest last), clipped. Full view only. */
  questions?: { role: string; author: string | null; text: string; at: string }[]
}

function chosenOptionLabel(d: DecisionView): string | null {
  if (!d.chosen) return null
  if (d.chosen === DENY_CHOICE) return 'No to all options'
  if (d.chosen === OWN_ANSWER_CHOICE) return 'Own answer'
  return optionFor(d.briefing, d.chosen)?.label ?? null
}

export function toBotDecision(d: DecisionView, full: boolean): BotDecisionView {
  const out: BotDecisionView = {
    id: d.id,
    state: d.state,
    question: oneLine(d.briefing.question || d.raw_note || '', full ? 400 : 240),
    options: d.briefing.options.map(o => ({ key: o.key, label: oneLine(o.label, 160), ...(full ? { next: oneLine(o.next, 240) } : {}) })),
    recommended: d.briefing.recommended || null,
    chosen: d.chosen,
    chosen_label: chosenOptionLabel(d),
    answer: chosenLabel(d.briefing, d.chosen, d.decision_note),
    decision_note: clip(d.decision_note, full ? 1500 : 400),
    decided_by: d.decided_by,
    decided_at: d.decided_at ? `${d.decided_at} UTC` : null,
    outcome: d.outcome,
    outcome_text: clip(d.outcome_text, full ? 600 : 300),
    raised_by: d.agent_slug,
    raised_at: `${d.created_at} UTC`,
  }
  if (d.withdrawn_reason) out.withdrawn_reason = oneLine(d.withdrawn_reason, 200)
  if (full) {
    out.context = clip(d.briefing.context, 800)
    out.recommended_why = clip(d.briefing.recommended_why, 300)
    out.questions = d.thread.slice(-6).map(m => ({ role: m.role, author: m.author, text: oneLine(m.body, 400), at: `${m.created_at} UTC` }))
  }
  return out
}

/** A card's decisions, newest first. `full` = card_read (briefing context, Q&A); otherwise the short form get_objective returns. */
export function cardDecisionsForBot(db: Database, objectiveId: number, opts: { full: boolean; limit?: number }): BotDecisionView[] {
  try {
    return listDecisionsForCard(db, objectiveId, opts.limit ?? (opts.full ? 8 : 4)).map(d => toBotDecision(d, opts.full))
  } catch {
    return []
  }
}

// ── card thread ──

export interface BotThreadEntry {
  /** summary = a worker's turn result; message = a message posted to the card (a person, a bot, a decision follow-up); question = the worker's latest in-progress text; error. */
  kind: 'summary' | 'message' | 'question' | 'error'
  at: string
  /** For a message: who posted it, as the server stamped it. */
  from?: string
  queued?: boolean
  text: string
}

/** Loads a card's thread messages. Tests swap it; the host reads the session transcripts. */
export type CardThreadLoader = (db: Database, card: { id: number; session_id: string | null }) => SessionMessage[]

const hostThreadLoader: CardThreadLoader = (db, card) => {
  const ids = listObjectiveThreadSessionIds(db, card)
  if (!ids.length) return []
  return ([] as SessionMessage[]).concat(...ids.map(id => getSessionOutput(id)))
}

let threadLoader: CardThreadLoader = hostThreadLoader
/** Test seam. Pass null to restore the host loader. */
export function setCardThreadLoaderForTests(fn: CardThreadLoader | null): void {
  threadLoader = fn ?? hostThreadLoader
}

function senderLabel(seg: Extract<ThreadSegment, { type: 'divider' }>): string {
  const s = seg.sender
  if (!s) return 'system'
  if (s.kind === 'owner' && s.verified) return `${s.label} (owner, verified)`
  if (s.kind === 'member' && s.verified) return `${s.label} (team member)`
  return `${s.label} (${s.kind}, not verified)`
}

/**
 * The card thread's visible anchors, newest last: the same summary / divider /
 * error / trailing-question segments the card's timeline shows, with the folded
 * tool activity left out. Bounded to `limit` entries, each clipped.
 */
export function cardThreadForBot(db: Database, card: { id: number; session_id: string | null }, opts: { limit?: number; maxChars?: number } = {}): BotThreadEntry[] {
  const limit = opts.limit ?? 10
  const max = opts.maxChars ?? 700
  let messages: SessionMessage[]
  try {
    messages = threadLoader(db, card)
  } catch {
    return []
  }
  if (!messages.length) return []
  const out: BotThreadEntry[] = []
  for (const seg of buildThreadTimeline(messages)) {
    if (seg.type === 'actions') continue
    const at = seg.timestamp
    if (seg.type === 'summary') out.push({ kind: 'summary', at, text: clip(seg.text, max) ?? '' })
    else if (seg.type === 'divider') out.push({ kind: 'message', at, from: senderLabel(seg), ...(seg.queued ? { queued: true } : {}), text: clip(seg.text, max) ?? '' })
    else if (seg.type === 'question') out.push({ kind: 'question', at, text: clip(seg.text, max) ?? '' })
    else if (seg.type === 'error') out.push({ kind: 'error', at, text: clip(seg.text, Math.min(max, 300)) ?? '' })
  }
  return out.slice(-limit)
}

// ── owner + grants ──

export interface BotCardOwner {
  owner_bot: string | null
  /** The chat slugs that bot answers to here (empty for an outside bot). */
  owner_bot_slugs: string[]
  /** Active approve-on-my-behalf grants for that owner bot in the card's workspace. Ids and action names only. */
  owner_grants: { grant_id: number; actions: string[]; granted_by: string; expires_at: string }[]
}

export function cardOwnerAndGrants(db: Database, card: { id: number; workspace: string; owner_bot?: string | null; agent_context?: string | null }, now = new Date()): BotCardOwner {
  let owner: CardOwnerBot | null = null
  try {
    owner = cardOwnerBot(card, db)
  } catch { /* no owner rather than no card */ }
  if (!owner) return { owner_bot: card.owner_bot ?? null, owner_bot_slugs: [], owner_grants: [] }
  const names = new Set<string>([owner.botId, owner.name, ...owner.slugs].filter((x): x is string => !!x))
  const grants: BotCardOwner['owner_grants'] = []
  const seen = new Set<number>()
  try {
    for (const name of names) {
      for (const g of listGrantsForBot(db, name, now)) {
        if (g.state !== 'active' || g.workspace !== card.workspace || seen.has(g.id)) continue
        seen.add(g.id)
        grants.push({ grant_id: g.id, actions: [...g.actions], granted_by: g.granted_by, expires_at: `${g.expires_at} UTC` })
      }
    }
    // A grant issued from the bot's chat page carries its slug even when the registry id differs.
    if (owner.slugs.length) {
      const rows = db
        .prepare(`SELECT DISTINCT bot_name FROM delegation_grants WHERE workspace = ? AND lower(agent_slug) IN (${owner.slugs.map(() => '?').join(',')})`)
        .all(card.workspace, ...owner.slugs) as { bot_name: string }[]
      for (const r of rows) {
        for (const g of listGrantsForBot(db, r.bot_name, now)) {
          if (g.state !== 'active' || g.workspace !== card.workspace || seen.has(g.id)) continue
          if (!g.agent_slug || !owner.slugs.includes(g.agent_slug.toLowerCase())) continue
          seen.add(g.id)
          grants.push({ grant_id: g.id, actions: [...g.actions], granted_by: g.granted_by, expires_at: `${g.expires_at} UTC` })
        }
      }
    }
  } catch { /* no grants table on an old DB: no grants */ }
  return { owner_bot: owner.name, owner_bot_slugs: owner.slugs, owner_grants: grants }
}

/** A hold that reads as "waiting on this card's decision / the owner's go-ahead". Used to say so plainly in reads. */
export function holdView(queueHold: unknown, blockedBy: unknown): { queue_hold: string | null; blocked_by: number | null } {
  const b = Number(blockedBy)
  return { queue_hold: clip(queueHold, 600), blocked_by: Number.isInteger(b) && b > 0 ? b : null }
}

// ── the per-turn prompt block ──

interface OwnedRow {
  id: number
  title: string
  status: string
  workspace: string
  owner_bot: string | null
  agent_context: string | null
  queue_hold: string | null
  blocked_by: number | null
}

const OPEN_STATUSES = ['planning', 'queue', 'working', 'ai_review', 'review']
const OWNED_MAX = 12
const RECENT_ANSWER_DAYS = 7
const RECENT_ANSWERS_MAX = 6

/** The open cards this bot owns in these workspaces, most recently updated first. */
export function ownedOpenCards(db: Database, slug: string, workspaces: string[], max = OWNED_MAX): OwnedRow[] {
  if (!workspaces.length) return []
  const s = slug.toLowerCase()
  // Narrow in SQL to cards that name SOME bot owner (or this slug), then apply the one rule.
  const rows = db
    .prepare(
      `SELECT id, title, status, workspace, owner_bot, agent_context, queue_hold, blocked_by
         FROM objectives
        WHERE deleted_at IS NULL
          AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
          AND workspace IN (${workspaces.map(() => '?').join(',')})
          AND ((owner_bot IS NOT NULL AND owner_bot <> '') OR lower(agent_context) = ?)
        ORDER BY updated_at DESC, id DESC
        LIMIT 400`,
    )
    .all(...OPEN_STATUSES, ...workspaces, s) as OwnedRow[]
  const owner = cardOwnerResolver(db)
  return rows.filter(r => ownerHasSlug(owner(r), s)).slice(0, max)
}

/**
 * Lines for the bot's system prompt: the cards it owns (id, title, status, hold),
 * the open decision on each, and recent answers on them, so "what did Operator choose
 * on #N" never needs asking twice. No descriptions. Empty when it owns nothing.
 */
export function ownedCardsPromptBlock(db: Database, p: { slug: string; workspaces: string[]; now?: Date }): string {
  let cards: OwnedRow[]
  try {
    cards = ownedOpenCards(db, p.slug, p.workspaces)
  } catch {
    return ''
  }
  if (!cards.length) return ''
  const ids = cards.map(c => c.id)
  const inIds = ids.map(() => '?').join(',')
  let open: DecisionRowLite[] = []
  let answered: DecisionRowLite[] = []
  try {
    open = db
      .prepare(`SELECT id, objective_id, question, options, chosen, decision_note, decided_by, decided_at, outcome FROM decisions WHERE state = 'open' AND objective_id IN (${inIds}) ORDER BY id DESC`)
      .all(...ids) as DecisionRowLite[]
    const since = new Date((p.now ?? new Date()).getTime() - RECENT_ANSWER_DAYS * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    answered = db
      .prepare(`SELECT id, objective_id, question, options, chosen, decision_note, decided_by, decided_at, outcome FROM decisions WHERE state = 'decided' AND decided_at >= ? AND objective_id IN (${inIds}) ORDER BY decided_at DESC, id DESC LIMIT ?`)
      .all(since, ...ids, RECENT_ANSWERS_MAX) as DecisionRowLite[]
  } catch { /* no decisions table: cards only */ }

  const openByCard = new Map<number, DecisionRowLite>()
  for (const d of open) if (!openByCard.has(d.objective_id)) openByCard.set(d.objective_id, d)

  const lines = ['- Cards you own right now (read one with get_objective / card_read before saying anything about it):']
  for (const c of cards) {
    const hold = c.queue_hold ? ` — hold: "${oneLine(c.queue_hold, 140)}"` : ''
    const blocked = c.blocked_by ? ` — waits on #${c.blocked_by}` : ''
    lines.push(`  - #${c.id} ${oneLine(c.title, 100)} [${c.status}, ${c.workspace}]${hold}${blocked}`)
    const d = openByCard.get(c.id)
    if (d) lines.push(`    - Open decision #${d.id} waiting on the owner: ${oneLine(d.question, 200)}`)
  }
  if (answered.length) {
    lines.push(`- Decisions the owner answered on your cards in the last ${RECENT_ANSWER_DAYS} days (the answer is final; do not ask again):`)
    for (const d of answered) {
      lines.push(`  - #${d.objective_id}, decision #${d.id} "${oneLine(d.question, 140)}": ${answerLine(d)} — by ${d.decided_by ?? 'the owner'} at ${d.decided_at} UTC${d.outcome ? ` (${d.outcome})` : ''}`)
    }
  }
  return lines.join('\n')
}

interface DecisionRowLite {
  id: number
  objective_id: number
  question: string
  options: string
  chosen: string | null
  decision_note: string | null
  decided_by: string | null
  decided_at: string | null
  outcome: string | null
}

function answerLine(d: DecisionRowLite): string {
  let options: { key: string; label: string; next: string; pros: string[]; cons: string[] }[] = []
  try {
    const parsed = JSON.parse(d.options || '[]')
    if (Array.isArray(parsed)) options = parsed
  } catch { /* none */ }
  const label = chosenLabel({ context: '', question: d.question, options, recommended: '', recommended_why: '' }, d.chosen, d.decision_note) ?? 'answered'
  const note = d.chosen && d.chosen !== OWN_ANSWER_CHOICE && d.decision_note?.trim() ? ` (note: "${oneLine(d.decision_note, 160)}")` : ''
  return oneLine(label, 200) + note
}
