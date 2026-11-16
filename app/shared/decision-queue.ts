/**
 * The "Needs you" decision stack (obj 901084).
 *
 * One queue of every decision waiting on the person, across bots and cards,
 * shown one at a time. Pure helpers live here so the server (ordering, count)
 * and the client (stack navigation, keyboard shortcuts) agree on one rule.
 */
import type { DecisionView } from './decision-briefing.js'

/**
 * How urgent a waiting decision is. Computed from the card, never typed by a bot:
 *   blocking  the work is stopped until the person answers (the card is parked,
 *             or a job finished by asking)
 *   running   the card keeps working meanwhile; the answer steers it
 */
export const DECISION_URGENCIES = ['blocking', 'running'] as const
export type DecisionUrgency = (typeof DECISION_URGENCIES)[number]

export const URGENCY_LABELS: Record<DecisionUrgency, { label: string; why: string }> = {
  blocking: { label: 'Work stopped', why: 'Nothing moves on this card until you answer.' },
  running: { label: 'Still running', why: 'The card keeps working; your answer steers what it does next.' },
}

/** The card a queued decision belongs to — final values only. */
export interface DecisionQueueCard {
  id: number
  title: string
  status: string
  workspace: string | null
  project: string | null
  /** The bot that owns / works the card, if any. */
  bot: string | null
}

export interface DecisionQueueItem {
  decision: DecisionView
  card: DecisionQueueCard
  urgency: DecisionUrgency
}

export interface DecisionQueueResponse {
  items: DecisionQueueItem[]
  count: number
  /** Stale asks cleared on this read ("no longer needed"), for the UI's toast. */
  cleared: number
}

/** The reason text a stale decision is withdrawn with. Shown to the person as-is. */
export const STALE_REASONS = {
  finished: 'no longer needed (card finished)',
  cancelled: 'no longer needed (card cancelled)',
  missing: 'no longer needed (card deleted)',
  closedByPerson: 'no longer needed (card closed by a person)',
  newerRun: 'no longer needed (a newer run of this job replaced it)',
} as const
export type StaleReason = (typeof STALE_REASONS)[keyof typeof STALE_REASONS]

const URGENCY_RANK: Record<DecisionUrgency, number> = { blocking: 0, running: 1 }

/** SQLite `datetime('now')` strings are UTC with no zone suffix. */
export function decisionTimestamp(s: string): number {
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : 0
}

/** Urgency first (blocking before running), then age (oldest first), then id. */
export function compareQueueItems(a: Pick<DecisionQueueItem, 'urgency' | 'decision'>, b: Pick<DecisionQueueItem, 'urgency' | 'decision'>): number {
  const u = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]
  if (u) return u
  const t = decisionTimestamp(a.decision.created_at) - decisionTimestamp(b.decision.created_at)
  if (t) return t
  return a.decision.id - b.decision.id
}

/** Urgency for a card in a given status (the open-decision case). */
export function urgencyForCard(status: string): DecisionUrgency {
  return status === 'working' ? 'running' : 'blocking'
}

/**
 * Keyboard shortcuts on the stack page. One table: the page binds these, the
 * help overlay lists them, the test asserts them.
 */
export const STACK_SHORTCUTS: { keys: string[]; action: StackAction; label: string }[] = [
  { keys: ['Enter'], action: 'approve', label: 'Approve the recommendation' },
  { keys: ['1', '2', '3', '4'], action: 'option', label: 'Choose option A-D' },
  { keys: ['d'], action: 'deny', label: 'Deny (none of these)' },
  { keys: ['s', 'j', 'ArrowRight'], action: 'next', label: 'Skip to the next decision' },
  { keys: ['k', 'ArrowLeft'], action: 'prev', label: 'Back to the previous one' },
  { keys: ['q', '/'], action: 'ask', label: 'Ask the bot a question' },
  { keys: ['o'], action: 'open', label: 'Open the card' },
  { keys: ['?'], action: 'help', label: 'Show these shortcuts' },
]
export type StackAction = 'approve' | 'option' | 'deny' | 'next' | 'prev' | 'ask' | 'open' | 'help'

/** Map a key press to a stack action (+ option index for 1-4). Null = not a shortcut. */
export function stackActionForKey(key: string): { action: StackAction; index?: number } | null {
  for (const s of STACK_SHORTCUTS) {
    const i = s.keys.indexOf(key.length === 1 ? key.toLowerCase() : key)
    if (i === -1) continue
    return s.action === 'option' ? { action: 'option', index: i } : { action: s.action }
  }
  return null
}

/**
 * Stack navigation over a list that changes underneath (an item is answered
 * and leaves, a new one arrives). Pure: given the current list, the id being
 * looked at and a move, return the id to show next. Wraps at both ends so
 * Skip on the last one goes back to the first one still waiting.
 */
export function stackMove(ids: number[], currentId: number | null, move: 'next' | 'prev' | 'stay'): number | null {
  if (!ids.length) return null
  const i = currentId == null ? -1 : ids.indexOf(currentId)
  if (i === -1) return ids[0]
  if (move === 'stay') return ids[i]
  const n = ids.length
  return ids[(i + (move === 'next' ? 1 : -1) + n) % n]
}

/**
 * After the current item is answered and removed from the list: the id that
 * took its place (the one that was after it), else the first. `prevIds` is the
 * list before removal.
 */
export function stackAfterAnswer(prevIds: number[], answeredId: number, nextIds: number[]): number | null {
  if (!nextIds.length) return null
  const i = prevIds.indexOf(answeredId)
  for (let k = i + 1; k > 0 && k < prevIds.length; k++) {
    if (nextIds.includes(prevIds[k])) return prevIds[k]
  }
  return nextIds[0]
}

/** True when a decision has no usable briefing (legacy raise). */
export function hasNoBriefing(d: Pick<DecisionView, 'incomplete' | 'briefing'>): boolean {
  return d.incomplete || (!d.briefing.question.trim() && d.briefing.options.length === 0)
}

/** The plain line shown in place of a missing briefing. */
export const NO_BRIEFING_TEXT = 'No briefing given — ask the bot what it needs before you choose.'
