/**
 * Decision briefings (obj 901059).
 *
 * Operator's feedback (Nov 15 2026): a bot asked him for a decision on a card. He
 * opened the card and could not see what the decision was, approved anyway,
 * nothing visibly happened, and the bot's chat then said "the card is done,
 * reopen it before sending". He could not tell what he had approved.
 *
 * So every decision a bot or worker raises now carries a SHORT, STRUCTURED
 * briefing, and the same pure rules (validation, the outcome line) are shared
 * by the server (which enforces them) and the client (which renders them):
 *
 *   context          2-3 sentences: where we are, what this is for, where it fits
 *   question         the decision, as ONE question
 *   options          2-4, each with pros, cons and what happens next
 *   recommended      the option key the raiser recommends, plus why
 *
 * Nothing here talks to a database or the network.
 */

export const DECISION_STATES = ['open', 'decided', 'withdrawn'] as const
export type DecisionState = (typeof DECISION_STATES)[number]

/** How the decision reached the human. */
export const DECISION_SOURCES = ['worker', 'bot', 'job_disposition', 'owner'] as const
export type DecisionSource = (typeof DECISION_SOURCES)[number]

/**
 * What the approve/deny click actually did to the card. Never a silent no-op:
 * every value below has a plain one-line explanation (`decisionOutcomeText`).
 */
export const DECISION_OUTCOMES = [
  'sent', //            the card was restarted with the choice
  'queued', //          the card is mid-run; the choice reaches it when this turn ends
  'reopened', //        the card was done; it was reopened and the choice sent
  'card_done', //       the card is done; the choice is recorded but NOT sent (offer Reopen and apply)
  'recorded', //        nothing to restart (no worker session) — the choice is recorded for the bot
  'failed', //          recorded, but the restart failed
] as const
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number]

/** The pseudo-choice for "no, none of these". */
export const DENY_CHOICE = 'deny'

export const DECISION_LIMITS = {
  minOptions: 2,
  maxOptions: 4,
  contextMax: 700,
  questionMax: 300,
  labelMax: 120,
  pointMax: 200,
  pointsMax: 4,
  nextMax: 240,
  whyMax: 300,
  /** The target is "under about 200 words"; past this the briefing is flagged as long (not refused). */
  softWordLimit: 220,
  questionBodyMax: 1000,
} as const

export interface DecisionOption {
  /** Short stable key: A, B, C, D. Assigned by the server when missing. */
  key: string
  label: string
  pros: string[]
  cons: string[]
  /** What happens next if this option is chosen. */
  next: string
}

export interface DecisionBriefing {
  context: string
  question: string
  options: DecisionOption[]
  recommended: string
  recommended_why: string
}

export type DecisionThreadRole = 'human' | 'bot' | 'system'

export interface DecisionThreadMessage {
  id: number
  decision_id: number
  role: DecisionThreadRole
  author: string | null
  body: string
  /** Human questions: pending until the bot answers, then answered (or failed). */
  status: 'pending' | 'answered' | 'failed' | null
  /** For a bot answer: the question it answers. */
  in_reply_to: number | null
  created_at: string
}

export interface DecisionView {
  id: number
  objective_id: number
  workspace: string
  /** The bot that raised it (chat bot slug or the card's agent), if any. */
  agent_slug: string | null
  source: DecisionSource
  state: DecisionState
  /** True when the raiser did not give a usable briefing (legacy needs_review note). */
  incomplete: boolean
  /** Validation notes kept on the record, e.g. `long`, `no_question`, `no_options`. */
  flags: string[]
  briefing: DecisionBriefing
  /** Free-text note that came with a legacy raise (job_review_note). */
  raw_note: string | null
  chosen: string | null
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  outcome: DecisionOutcome | null
  outcome_text: string | null
  /** Why it left the queue unanswered (superseded, or "no longer needed (card finished)"). obj 901084. */
  withdrawn_reason?: string | null
  /**
   * obj 901084: for an answered decision whose card was done (`outcome = card_done`),
   * whether "Reopen and apply" is still offered. False once the ask is stale (the card
   * was closed by a person, cancelled, or a newer run replaced it). Absent = not computed.
   */
  can_reopen?: boolean
  thread: DecisionThreadMessage[]
  created_at: string
  updated_at: string
}

/** Input as a raiser sends it (keys optional). */
export interface DecisionBriefingInput {
  context?: unknown
  question?: unknown
  options?: unknown
  recommended?: unknown
  recommended_why?: unknown
}

export type BriefingValidation =
  | { ok: true; briefing: DecisionBriefing; flags: string[]; words: number }
  | { ok: false; errors: string[] }

const OPTION_KEYS = ['A', 'B', 'C', 'D']

function str(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function points(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []
  return list
    .map(p => clip(str(p), DECISION_LIMITS.pointMax))
    .filter(Boolean)
    .slice(0, DECISION_LIMITS.pointsMax)
}

export function countWords(s: string): number {
  const t = s.trim()
  return t ? t.split(/\s+/).length : 0
}

/** Words in the whole briefing, as the human reads it. */
export function briefingWordCount(b: DecisionBriefing): number {
  let n = countWords(b.context) + countWords(b.question) + countWords(b.recommended_why)
  for (const o of b.options) {
    n += countWords(o.label) + countWords(o.next)
    for (const p of [...o.pros, ...o.cons]) n += countWords(p)
  }
  return n
}

/**
 * Validate and normalise a briefing. A request with no question or fewer than
 * two options is REFUSED (the errors say exactly what is missing, in words a
 * model can act on). An over-long briefing is accepted and flagged `long`.
 */
export function validateDecisionBriefing(input: DecisionBriefingInput | null | undefined): BriefingValidation {
  const errors: string[] = []
  const raw = input ?? {}
  const context = clip(str(raw.context), DECISION_LIMITS.contextMax)
  const question = clip(str(raw.question), DECISION_LIMITS.questionMax)
  if (!question) errors.push('question is required: the decision as ONE question (e.g. "Should we send the draft to the 40 leads today?")')
  if (!context) errors.push('context is required: 2-3 sentences on where we are, what the decision is for, and where it fits')

  const rawOptions = Array.isArray(raw.options) ? raw.options : []
  if (rawOptions.length < DECISION_LIMITS.minOptions) {
    errors.push(`options is required: give ${DECISION_LIMITS.minOptions}-${DECISION_LIMITS.maxOptions} options, each with label, pros, cons and next`)
  } else if (rawOptions.length > DECISION_LIMITS.maxOptions) {
    errors.push(`too many options: give at most ${DECISION_LIMITS.maxOptions}`)
  }

  const options: DecisionOption[] = []
  const seen = new Set<string>()
  rawOptions.slice(0, DECISION_LIMITS.maxOptions).forEach((o: unknown, i: number) => {
    const rec = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
    const label = clip(str(rec.label ?? rec.title ?? (typeof o === 'string' ? o : '')), DECISION_LIMITS.labelMax)
    let key = str(rec.key).toUpperCase().slice(0, 2)
    if (!key || seen.has(key)) key = OPTION_KEYS.find(k => !seen.has(k)) ?? String(i + 1)
    seen.add(key)
    const pros = points(rec.pros)
    const cons = points(rec.cons)
    const next = clip(str(rec.next ?? rec.what_happens_next), DECISION_LIMITS.nextMax)
    const n = `option ${i + 1}`
    if (!label) errors.push(`${n}: label is required`)
    if (!pros.length) errors.push(`${n}${label ? ` ("${label}")` : ''}: give at least one pro`)
    if (!cons.length) errors.push(`${n}${label ? ` ("${label}")` : ''}: give at least one con`)
    if (!next) errors.push(`${n}${label ? ` ("${label}")` : ''}: next is required (what happens if this is chosen)`)
    options.push({ key, label, pros, cons, next })
  })

  let recommended = str(raw.recommended)
  if (recommended) {
    const byKey = options.find(o => o.key === recommended.toUpperCase())
    const byLabel = options.find(o => o.label.toLowerCase() === recommended.toLowerCase())
    const hit = byKey ?? byLabel
    if (hit) recommended = hit.key
    else if (options.length) errors.push(`recommended must name one of the options (${options.map(o => o.key).join(', ')})`)
  } else {
    errors.push('recommended is required: the option key you recommend')
  }
  const recommended_why = clip(str(raw.recommended_why), DECISION_LIMITS.whyMax)
  if (!recommended_why) errors.push('recommended_why is required: one sentence on why')

  if (errors.length) return { ok: false, errors }
  const briefing: DecisionBriefing = { context, question, options, recommended, recommended_why }
  const words = briefingWordCount(briefing)
  const flags = words > DECISION_LIMITS.softWordLimit ? ['long'] : []
  return { ok: true, briefing, flags, words }
}

/** The option a choice names, or null (deny / unknown). */
export function optionFor(b: DecisionBriefing, choice: string | null | undefined): DecisionOption | null {
  if (!choice) return null
  return b.options.find(o => o.key === choice) ?? null
}

/**
 * The one-line result shown after approve/deny. Plain words, always says what
 * was chosen and what happens next — never a dead click.
 */
export function decisionOutcomeText(p: {
  objectiveId: number
  briefing: DecisionBriefing
  chosen: string
  outcome: DecisionOutcome
  error?: string | null
}): string {
  const card = `card #${p.objectiveId}`
  const opt = optionFor(p.briefing, p.chosen)
  const what = p.chosen === DENY_CHOICE
    ? 'You said no to all the options'
    : opt
      ? `You chose ${opt.key}: ${opt.label}`
      : `You chose ${p.chosen}`
  const next = p.chosen === DENY_CHOICE
    ? 'The worker is told not to go ahead with any of them.'
    : opt?.next
      ? `Next: ${opt.next}`
      : ''
  switch (p.outcome) {
    case 'sent':
      return `${what}. ${cap(card)} restarted with your choice. ${next}`.trim()
    case 'queued':
      return `${what}. ${cap(card)} is mid-run, so your choice is queued and reaches it when this turn ends. ${next}`.trim()
    case 'reopened':
      return `${what}. ${cap(card)} was done, so it was reopened and your choice sent. ${next}`.trim()
    case 'card_done':
      return `${what}. ${cap(card)} is already done, so nothing was sent yet. Press Reopen and apply to act on it.`
    case 'recorded':
      if (p.chosen === DENY_CHOICE) return `${what}. Recorded on ${card}; it is already finished, so nothing else changes.`
      return `${what}. Recorded on ${card}; there is no worker to restart, so the bot picks it up from here. ${next}`.trim()
    case 'failed':
      return `${what}. Your choice is recorded, but ${card} could not be restarted${p.error ? `: ${p.error}` : ''}.`
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * The text the worker receives when the owner decides. The server stamps who
 * sent it; this is the body only.
 */
export function decisionFollowUpText(p: {
  decisionId: number
  briefing: DecisionBriefing
  chosen: string
  note?: string | null
}): string {
  const opt = optionFor(p.briefing, p.chosen)
  const lines = [`Decision #${p.decisionId}: ${p.briefing.question}`]
  if (p.chosen === DENY_CHOICE) {
    lines.push('Answer: NO to all the options. Do not go ahead with any of them. Stop this line of work, say so in one line, and wait for new instructions.')
  } else if (opt) {
    lines.push(`Answer: option ${opt.key} — ${opt.label}.`)
    lines.push(`Do this next: ${opt.next}`)
  } else {
    lines.push(`Answer: ${p.chosen}.`)
  }
  if (p.note?.trim()) lines.push(`Note from the owner: ${p.note.trim()}`)
  return lines.join('\n')
}

/** Short label for a decided record ("Chose B: Ship the draft" / "Denied"). */
export function chosenLabel(b: DecisionBriefing, chosen: string | null): string | null {
  if (!chosen) return null
  if (chosen === DENY_CHOICE) return 'Denied'
  const opt = optionFor(b, chosen)
  return opt ? `Chose ${opt.key}: ${opt.label}` : `Chose ${chosen}`
}
