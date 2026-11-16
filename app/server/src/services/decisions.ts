/**
 * Decision briefings, their Q&A threads and the learning log (obj 901059).
 *
 * WHY. Operator opened a card a bot had asked him to decide on and could not see
 * what the decision was; he approved anyway, nothing visibly happened, and the
 * bot's chat then said "the card is done, reopen it before sending". This
 * module is the record that fixes that:
 *
 *   raise      a bot / worker raises ONE decision with a structured briefing
 *              (validated by shared/decision-briefing.ts: no question or fewer
 *              than two options is refused). A legacy `needs_review` note with
 *              no briefing is still recorded, flagged `incomplete`, so the card
 *              shows the gap instead of nothing.
 *   thread     the person asks questions on the decision; the raising bot
 *              answers in the same thread (services/decision-answerer.ts).
 *   decide     the person picks an option (or denies). Applying it to the card
 *              is services/decision-apply.ts; the OUTCOME it reports (sent /
 *              queued / reopened / card_done / recorded / failed) is stored with
 *              the plain one-line text the person was shown.
 *   log        every decision with its briefing, questions, answers, choice and
 *              outcome is queryable here (`decisionLog`) and summarised into the
 *              workspace knowledge base at decisions/decision-log.md. The recent
 *              questions the person HAD to ask are fed back into the briefing
 *              prompts (`briefingFeedbackBlock`) so future briefings answer them
 *              up front.
 *
 * Boundaries: nothing here grants authority. Choosing an option is a person's
 * message to the card, delivered under the person's own server-stamped sender
 * by the caller; it is never a merge, deploy or spend approval on its own.
 */
import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'
import {
  DENY_CHOICE,
  DECISION_LIMITS,
  OWN_ANSWER_CHOICE,
  chosenLabel,
  optionFor,
  validateDecisionBriefing,
  type DecisionBriefing,
  type DecisionBriefingInput,
  type DecisionOption,
  type DecisionOutcome,
  type DecisionSource,
  type DecisionState,
  type DecisionThreadMessage,
  type DecisionView,
} from '@operationkit/shared'
import { initDecisionSchema } from '../db/schema/decisions.js'
import { redactForStorage } from './secret-redaction.js'

/**
 * Secret redaction for text that leaves the decision tables: the KB summary,
 * prompt feedback lines and the JSON options column. The tables themselves are
 * in SCRUBBED_TABLES (db/write-scrubber.ts); this is the same redactor, applied
 * on the way OUT too, so a row written before scrubbing (or with scrubbing off)
 * still never reaches the knowledge base or a prompt with a key in it.
 */
export function redactDecisionText(s: string): string {
  try {
    return redactForStorage(s).text
  } catch {
    return s
  }
}

function redactOptions(options: DecisionOption[]): DecisionOption[] {
  return options.map(o => ({
    ...o,
    label: redactDecisionText(o.label),
    pros: o.pros.map(redactDecisionText),
    cons: o.cons.map(redactDecisionText),
    next: redactDecisionText(o.next),
  }))
}

export class DecisionError extends Error {
  constructor(message: string, readonly status = 400, readonly errors: string[] = []) {
    super(message)
  }
}

interface DecisionRow {
  id: number
  objective_id: number
  workspace: string
  agent_slug: string | null
  source: DecisionSource
  state: DecisionState
  incomplete: number
  flags: string | null
  context: string
  question: string
  options: string
  recommended: string | null
  recommended_why: string | null
  raw_note: string | null
  chosen: string | null
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  outcome: DecisionOutcome | null
  outcome_text: string | null
  withdrawn_reason: string | null
  delivered_to?: string | null
  created_at: string
  updated_at: string
}

const ready = new WeakSet<object>()
function ensure(db: Database.Database): void {
  if (ready.has(db)) return
  initDecisionSchema(db)
  ready.add(db)
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function briefingOf(row: DecisionRow): DecisionBriefing {
  const options = parseJson<DecisionOption[]>(row.options, [])
  return {
    context: row.context,
    question: row.question,
    options: Array.isArray(options) ? options : [],
    recommended: row.recommended ?? '',
    recommended_why: row.recommended_why ?? '',
  }
}

function threadOf(db: Database.Database, decisionId: number): DecisionThreadMessage[] {
  return db
    .prepare('SELECT id, decision_id, role, author, body, status, in_reply_to, created_at FROM decision_messages WHERE decision_id = ? ORDER BY id')
    .all(decisionId) as DecisionThreadMessage[]
}

function toView(db: Database.Database, row: DecisionRow): DecisionView {
  return {
    id: row.id,
    objective_id: row.objective_id,
    workspace: row.workspace,
    agent_slug: row.agent_slug,
    source: row.source,
    state: row.state,
    incomplete: !!row.incomplete,
    flags: parseJson<string[]>(row.flags, []),
    briefing: briefingOf(row),
    raw_note: row.raw_note,
    chosen: row.chosen,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    decision_note: row.decision_note,
    outcome: row.outcome,
    outcome_text: row.outcome_text,
    withdrawn_reason: row.withdrawn_reason,
    delivered_to: row.delivered_to ?? null,
    thread: threadOf(db, row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function getDecision(db: Database.Database, id: number): DecisionView | null {
  ensure(db)
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as DecisionRow | undefined
  return row ? toView(db, row) : null
}

/** A card's decisions, newest first. */
export function listDecisionsForCard(db: Database.Database, objectiveId: number, limit = 20): DecisionView[] {
  ensure(db)
  const rows = db
    .prepare('SELECT * FROM decisions WHERE objective_id = ? ORDER BY id DESC LIMIT ?')
    .all(objectiveId, Math.max(1, Math.min(100, limit))) as DecisionRow[]
  return rows.map(r => toView(db, r))
}

/** The open decision on a card, if any (there is at most one: a new raise supersedes). */
export function openDecisionForCard(db: Database.Database, objectiveId: number): DecisionView | null {
  ensure(db)
  const row = db
    .prepare("SELECT * FROM decisions WHERE objective_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1")
    .get(objectiveId) as DecisionRow | undefined
  return row ? toView(db, row) : null
}

/** Card ids (of those given) that have an open decision — batched for board signals. */
export function cardsWithOpenDecision(db: Database.Database, objectiveIds: number[]): Set<number> {
  ensure(db)
  const ids = objectiveIds.filter(n => Number.isInteger(n))
  if (!ids.length) return new Set()
  const rows = db
    .prepare(`SELECT DISTINCT objective_id FROM decisions WHERE state = 'open' AND objective_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { objective_id: number }[]
  return new Set(rows.map(r => r.objective_id))
}

export interface RaiseDecisionInput {
  objective_id: number
  workspace: string
  source: DecisionSource
  agent_slug?: string | null
  briefing?: DecisionBriefingInput | null
  /**
   * The free-text note of a legacy raise (job disposition needs_review with no
   * briefing). Only with `allowIncomplete`: the decision is recorded but flagged,
   * so the card says plainly that no briefing was given.
   */
  raw_note?: string | null
  allowIncomplete?: boolean
}

export type RaiseDecisionResult =
  | { ok: true; decision: DecisionView; superseded: number[] }
  | { ok: false; errors: string[] }

/**
 * Raise a decision. Validates the briefing (refusing a request with no
 * question or no options unless it is an explicitly-flagged legacy raise),
 * and supersedes any decision still open on the same card — there is only
 * ever ONE live question per card in front of the person.
 */
export function raiseDecision(db: Database.Database, input: RaiseDecisionInput): RaiseDecisionResult {
  ensure(db)
  if (!Number.isInteger(input.objective_id) || input.objective_id <= 0) return { ok: false, errors: ['objective_id must be a positive integer'] }
  const v = validateDecisionBriefing(input.briefing ?? null)
  let briefing: DecisionBriefing
  let flags: string[]
  let incomplete = false
  if (v.ok) {
    briefing = v.briefing
    flags = v.flags
  } else if (input.allowIncomplete) {
    const note = (input.raw_note ?? '').trim()
    const raw = input.briefing ?? {}
    const question = typeof raw.question === 'string' ? raw.question.trim().slice(0, DECISION_LIMITS.questionMax) : ''
    briefing = {
      context: (typeof raw.context === 'string' && raw.context.trim() ? raw.context.trim() : note).slice(0, DECISION_LIMITS.contextMax),
      question,
      options: [],
      recommended: '',
      recommended_why: '',
    }
    incomplete = true
    flags = [...(question ? [] : ['no_question']), 'no_options']
  } else {
    return { ok: false, errors: v.errors }
  }

  const tx = db.transaction((): RaiseDecisionResult => {
    const open = db.prepare("SELECT id FROM decisions WHERE objective_id = ? AND state = 'open'").all(input.objective_id) as { id: number }[]
    const info = db
      .prepare(
        `INSERT INTO decisions (objective_id, workspace, agent_slug, source, incomplete, flags, context, question, options, recommended, recommended_why, raw_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.objective_id,
        input.workspace || '',
        input.agent_slug?.trim() || null,
        input.source,
        incomplete ? 1 : 0,
        flags.length ? JSON.stringify(flags) : null,
        briefing.context,
        briefing.question,
        JSON.stringify(redactOptions(briefing.options)),
        briefing.recommended || null,
        briefing.recommended_why || null,
        input.raw_note?.trim() ? input.raw_note.trim().slice(0, 1000) : null,
      )
    const id = Number(info.lastInsertRowid)
    const superseded = open.map(o => o.id)
    if (superseded.length) {
      db.prepare(
        `UPDATE decisions SET state = 'withdrawn', withdrawn_reason = ?, updated_at = datetime('now') WHERE id IN (${superseded.map(() => '?').join(',')})`,
      ).run(`superseded by decision #${id}`, ...superseded)
    }
    return { ok: true, decision: getDecision(db, id) as DecisionView, superseded }
  })
  return tx()
}

export function withdrawDecision(db: Database.Database, id: number, reason: string): DecisionView | null {
  ensure(db)
  db.prepare("UPDATE decisions SET state = 'withdrawn', withdrawn_reason = ?, updated_at = datetime('now') WHERE id = ? AND state = 'open'")
    .run(reason.slice(0, 200), id)
  return getDecision(db, id)
}

// ── Q&A thread ──────────────────────────────────────────────────────────────

/** Record the person's question. It stays `pending` until the bot answers. */
export function askQuestion(db: Database.Database, decisionId: number, p: { author: string; body: string }): DecisionThreadMessage {
  ensure(db)
  const d = getDecision(db, decisionId)
  if (!d) throw new DecisionError('Decision not found', 404)
  const body = typeof p.body === 'string' ? p.body.trim() : ''
  if (!body) throw new DecisionError('Type a question first')
  if (body.length > DECISION_LIMITS.questionBodyMax) throw new DecisionError(`Keep the question under ${DECISION_LIMITS.questionBodyMax} characters`)
  const info = db
    .prepare("INSERT INTO decision_messages (decision_id, role, author, body, status) VALUES (?, 'human', ?, ?, 'pending')")
    .run(decisionId, p.author, body)
  db.prepare("UPDATE decisions SET updated_at = datetime('now') WHERE id = ?").run(decisionId)
  return db.prepare('SELECT * FROM decision_messages WHERE id = ?').get(Number(info.lastInsertRowid)) as DecisionThreadMessage
}

/** Store the bot's answer to a question (or a failure note) and settle the question. */
export function recordAnswer(
  db: Database.Database,
  questionId: number,
  p: { body: string; author: string | null; failed?: boolean },
): DecisionThreadMessage {
  ensure(db)
  const q = db.prepare("SELECT * FROM decision_messages WHERE id = ? AND role = 'human'").get(questionId) as DecisionThreadMessage | undefined
  if (!q) throw new DecisionError('Question not found', 404)
  const role = p.failed ? 'system' : 'bot'
  const info = db
    .prepare('INSERT INTO decision_messages (decision_id, role, author, body, status, in_reply_to) VALUES (?, ?, ?, ?, NULL, ?)')
    .run(q.decision_id, role, p.author, p.body.trim().slice(0, 4000) || '(no answer)', questionId)
  db.prepare('UPDATE decision_messages SET status = ? WHERE id = ?').run(p.failed ? 'failed' : 'answered', questionId)
  db.prepare("UPDATE decisions SET updated_at = datetime('now') WHERE id = ?").run(q.decision_id)
  return db.prepare('SELECT * FROM decision_messages WHERE id = ?').get(Number(info.lastInsertRowid)) as DecisionThreadMessage
}

// ── decide ──────────────────────────────────────────────────────────────────

/** Normalise a choice against the briefing: an option key, a label, or `deny`. */
export function resolveChoice(d: DecisionView, choice: unknown): string | null {
  if (typeof choice !== 'string' || !choice.trim()) return null
  const c = choice.trim()
  if (c.toLowerCase() === DENY_CHOICE) return DENY_CHOICE
  // obj 901139: the person's own words instead of an option (the route requires the text).
  if (c.toLowerCase() === OWN_ANSWER_CHOICE) return OWN_ANSWER_CHOICE
  // A flagged (incomplete) decision has no options; "approve" then means "go ahead as proposed".
  if (d.incomplete && c.toLowerCase() === 'approve') return 'approve'
  const byKey = d.briefing.options.find(o => o.key === c.toUpperCase())
  if (byKey) return byKey.key
  const byLabel = d.briefing.options.find(o => o.label.toLowerCase() === c.toLowerCase())
  return byLabel ? byLabel.key : null
}

/**
 * Record the person's choice. Idempotent in one direction only: an already
 * decided record cannot be re-decided (409) — except to settle a `card_done`
 * outcome with "Reopen and apply", which the caller does via `setOutcome`.
 */
export function recordChoice(
  db: Database.Database,
  id: number,
  p: { choice: string; by: string; note?: string | null },
): DecisionView {
  ensure(db)
  const res = db
    .prepare(
      "UPDATE decisions SET state = 'decided', chosen = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?, updated_at = datetime('now') WHERE id = ? AND state = 'open'",
    )
    .run(p.choice, p.by, p.note?.trim() ? p.note.trim().slice(0, p.choice === OWN_ANSWER_CHOICE ? DECISION_LIMITS.ownAnswerMax : 1000) : null, id)
  if (res.changes === 0) {
    const cur = getDecision(db, id)
    if (!cur) throw new DecisionError('Decision not found', 404)
    throw new DecisionError(
      cur.state === 'withdrawn'
        ? 'This decision was withdrawn (a newer decision replaced it, or the card no longer needs it). Answer the latest one instead.'
        : `This decision was already answered: ${chosenLabel(cur.briefing, cur.chosen, cur.decision_note) ?? cur.chosen}`,
      409,
    )
  }
  return getDecision(db, id) as DecisionView
}

export function setOutcome(db: Database.Database, id: number, outcome: DecisionOutcome, text: string): DecisionView {
  ensure(db)
  db.prepare("UPDATE decisions SET outcome = ?, outcome_text = ?, updated_at = datetime('now') WHERE id = ?").run(outcome, text, id)
  db.prepare("INSERT INTO decision_messages (decision_id, role, author, body, status) VALUES (?, 'system', NULL, ?, NULL)").run(id, text)
  return getDecision(db, id) as DecisionView
}

// ── the learning log ────────────────────────────────────────────────────────

export interface DecisionLogEntry {
  id: number
  objective_id: number
  workspace: string
  agent_slug: string | null
  source: DecisionSource
  state: DecisionState
  incomplete: boolean
  question: string
  context: string
  options: { key: string; label: string }[]
  recommended: string | null
  chosen: string | null
  chosen_label: string | null
  /** The person's note, or their own answer when `chosen` is OWN_ANSWER_CHOICE (obj 901139). */
  decision_note: string | null
  followed_recommendation: boolean | null
  decided_by: string | null
  decided_at: string | null
  outcome: DecisionOutcome | null
  outcome_text: string | null
  questions: { question: string; answer: string | null; asked_at: string }[]
  created_at: string
}

export interface DecisionLogQuery {
  workspace?: string | null
  /** Restrict to these workspaces (a member's view). null = no restriction. */
  workspaces?: string[] | null
  objective_id?: number | null
  since?: string | null
  limit?: number
}

/** The queryable learning log: decision + briefing + Q&A + choice + outcome. */
export function decisionLog(db: Database.Database, q: DecisionLogQuery = {}): DecisionLogEntry[] {
  ensure(db)
  const where: string[] = []
  const args: unknown[] = []
  if (q.workspace) {
    where.push('workspace = ?')
    args.push(q.workspace)
  }
  if (q.workspaces) {
    if (!q.workspaces.length) return []
    where.push(`workspace IN (${q.workspaces.map(() => '?').join(',')})`)
    args.push(...q.workspaces)
  }
  if (q.objective_id) {
    where.push('objective_id = ?')
    args.push(q.objective_id)
  }
  if (q.since) {
    where.push('created_at >= ?')
    args.push(q.since)
  }
  const limit = Math.max(1, Math.min(500, q.limit ?? 100))
  const rows = db
    .prepare(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as DecisionRow[]
  return rows.map(r => {
    const b = briefingOf(r)
    const thread = threadOf(db, r.id)
    const questions = thread
      .filter(m => m.role === 'human')
      .map(m => ({
        question: m.body,
        answer: thread.find(a => a.in_reply_to === m.id && a.role === 'bot')?.body ?? null,
        asked_at: m.created_at,
      }))
    const chosen = r.chosen
    return {
      id: r.id,
      objective_id: r.objective_id,
      workspace: r.workspace,
      agent_slug: r.agent_slug,
      source: r.source,
      state: r.state,
      incomplete: !!r.incomplete,
      question: b.question,
      context: b.context,
      options: b.options.map(o => ({ key: o.key, label: o.label })),
      recommended: r.recommended,
      chosen,
      chosen_label: chosenLabel(b, chosen, r.decision_note),
      decision_note: r.decision_note,
      followed_recommendation: chosen && r.recommended && optionFor(b, r.recommended) ? chosen === r.recommended : null,
      decided_by: r.decided_by,
      decided_at: r.decided_at,
      outcome: r.outcome,
      outcome_text: r.outcome_text,
      questions,
      created_at: r.created_at,
    }
  })
}

/**
 * The questions the person had to ask on recent decisions in a workspace —
 * the signal that a briefing left something out. Newest first, deduped.
 */
export function recentOwnerQuestions(
  db: Database.Database,
  workspace: string | null,
  limit = 8,
): { question: string; about: string; decision_id: number; asked_at: string }[] {
  ensure(db)
  const rows = db
    .prepare(
      `SELECT m.body, m.created_at, d.id AS decision_id, d.question AS about
         FROM decision_messages m JOIN decisions d ON d.id = m.decision_id
        WHERE m.role = 'human' ${workspace ? 'AND d.workspace = ?' : ''}
        ORDER BY m.id DESC LIMIT 50`,
    )
    .all(...(workspace ? [workspace] : [])) as { body: string; created_at: string; decision_id: number; about: string }[]
  const seen = new Set<string>()
  const out: { question: string; about: string; decision_id: number; asked_at: string }[] = []
  for (const r of rows) {
    const key = r.body.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ question: r.body.replace(/\s+/g, ' ').slice(0, 200), about: r.about.slice(0, 160), decision_id: r.decision_id, asked_at: r.created_at })
    if (out.length >= limit) break
  }
  return out
}

/**
 * The prompt lines that feed recent "questions the person had to ask" back
 * into briefing writers. Empty when there are none. Each question is the
 * person's own words, quoted as data, never as an instruction.
 */
export function briefingFeedbackLines(db: Database.Database, workspace: string | null, owner = 'the owner'): string[] {
  let qs: ReturnType<typeof recentOwnerQuestions> = []
  try {
    qs = recentOwnerQuestions(db, workspace, 6)
  } catch {
    return []
  }
  if (!qs.length) return []
  return [
    `Questions ${owner} had to ask on recent decisions (answer this kind of thing in the briefing itself, up front):`,
    ...qs.map(q => `- "${q.question.replace(/"/g, "'")}" (on: ${q.about.replace(/"/g, "'") || 'a decision'})`),
  ].map(redactDecisionText)
}

// ── knowledge-base summary ──────────────────────────────────────────────────

export const DECISION_LOG_KB_PATH = 'decisions/decision-log.md'

export function renderDecisionLogMarkdown(workspace: string, entries: DecisionLogEntry[], now: Date = new Date()): string {
  const decided = entries.filter(e => e.state === 'decided')
  const followed = decided.filter(e => e.followed_recommendation === true).length
  const asked = entries.reduce((n, e) => n + e.questions.length, 0)
  const lines = [
    '---',
    `title: Decision log (${workspace})`,
    'type: decision-log',
    `workspace: ${workspace}`,
    `updated: ${now.toISOString()}`,
    'generated_by: command-center decisions (obj 901059)',
    '---',
    '',
    `# Decision log: ${workspace}`,
    '',
    'Every decision a bot or worker asked for, the briefing it gave, the questions that had to be asked, what was chosen and what happened. Generated from the board; edits here are overwritten.',
    '',
    `- Decisions: ${entries.length} (${decided.length} answered)`,
    `- Recommendation followed: ${followed} of ${decided.filter(e => e.followed_recommendation !== null).length}`,
    `- Questions asked before deciding: ${asked}`,
    '',
  ]
  const qs = entries.flatMap(e => e.questions.map(q => ({ q: q.question, about: e.question })))
  if (qs.length) {
    lines.push('## Questions that briefings should answer up front', '')
    for (const q of qs.slice(0, 15)) lines.push(`- ${oneLine(q.q)} _(on: ${oneLine(q.about) || 'a decision'})_`)
    lines.push('')
  }
  lines.push('## Decisions', '')
  for (const e of entries) {
    lines.push(`### #${e.id} · card #${e.objective_id} · ${e.created_at.slice(0, 10)}`)
    lines.push('')
    lines.push(`**Question:** ${oneLine(e.question) || '_(no question given: the raise had no briefing)_'}`)
    if (e.context) lines.push(`**Context:** ${oneLine(e.context)}`)
    if (e.options.length) lines.push(`**Options:** ${e.options.map(o => `${o.key}) ${oneLine(o.label)}${o.key === e.recommended ? ' (recommended)' : ''}`).join('; ')}`)
    for (const q of e.questions) {
      lines.push(`- Q: ${oneLine(q.question)}`)
      lines.push(`  A: ${q.answer ? oneLine(q.answer) : '_(no answer)_'}`)
    }
    lines.push(`**Result:** ${e.state === 'decided' ? `${e.chosen_label ?? e.chosen}${e.decided_by ? ` by ${e.decided_by}` : ''}` : e.state}`)
    if (e.chosen === OWN_ANSWER_CHOICE && e.decision_note) lines.push(`**Own answer:** ${oneLine(e.decision_note)}`)
    if (e.outcome_text) lines.push(`**Outcome:** ${oneLine(e.outcome_text)}`)
    lines.push('')
  }
  // Every line is bot- or person-written text headed for a file bots read and
  // index: redact the whole document, not field by field.
  return lines.map(redactDecisionText).join('\n')
}

function oneLine(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Rewrite the workspace's decisions/decision-log.md from the table. Best effort:
 * the table is the source of truth, so a KB write failure is logged and the
 * decision still stands. `kbRoot` is injectable for tests.
 */
export function writeDecisionLogToKb(
  db: Database.Database,
  workspace: string,
  deps: { kbRoot: (ws: string) => string; noteWrite?: (abs: string) => void; now?: Date },
): string | null {
  if (!workspace) return null
  try {
    const root = deps.kbRoot(workspace)
    const abs = path.join(root, DECISION_LOG_KB_PATH)
    const entries = decisionLog(db, { workspace, limit: 200 })
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, renderDecisionLogMarkdown(workspace, entries, deps.now))
    deps.noteWrite?.(abs)
    return abs
  } catch (err) {
    console.warn(`[decisions] could not write the decision log for ${workspace}:`, err instanceof Error ? err.message : String(err))
    return null
  }
}
