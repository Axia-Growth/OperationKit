/**
 * A stop for the owner with no briefing gets one written for it (obj 901151).
 *
 * WHY. Operator's Needs you stack (Nov 16) showed card #901136 "Operation Kit Dev:
 * High Agency wake" as "No briefing given" / "What is being decided was not
 * stated". The wake had ended with a bare `needs_review` note ("Decision #6
 * done ... two things to check before the next deploy"), which the server
 * recorded as a FLAGGED decision with nothing to decide on. A person cannot
 * answer that, and in this case there was nothing to answer: it was an FYI.
 *
 * So an open decision that is still `incomplete` (no briefing) is never shown
 * to the person as-is. Once its card has stopped running (the session summary
 * is then written), this module reads the note, the summary and any Q&A answer
 * the bot gave, and asks ONE tool-less model call to classify it:
 *
 *   decision  the owner has to choose or approve something: the reply is a full
 *             briefing (context, one question, 2-4 options with pros/cons/next,
 *             recommendation), validated by the same rules a raiser meets. It is
 *             written onto the decision, which leaves `incomplete` and reaches
 *             the stack, flagged `auto_briefing` so the UI says who wrote it.
 *   fyi       nothing to decide: the decision is withdrawn ("FYI, nothing to
 *             decide"), the note goes to the activity feed, and a job's
 *             disposition becomes `complete` so no Needs you surface lists it.
 *
 * When no model answers (no bot installed, provider down, unparseable reply)
 * the briefing is built deterministically from the material (`fallbackBriefing`):
 * the bot's own words as the context, "go ahead / hold" as the options. That is
 * still a real, answerable briefing, never "no briefing given".
 *
 * Card text reaches the model inside an untrusted-content frame: it is data.
 * Nothing here decides, sends, reopens or approves anything.
 */
import type Database from 'better-sqlite3'
import {
  DECISION_LIMITS,
  validateDecisionBriefing,
  type DecisionBriefing,
  type DecisionView,
  type Objective,
} from '@operationkit/shared'
import { frameAndScan } from './injection-telemetry.js'
import { cardOwnerBot } from './bots/card-owner.js'
import { getDecision, redactDecisionText } from './decisions.js'

/** Flag on a decision whose briefing the server wrote (model or fallback). */
export const AUTO_BRIEFING_FLAG = 'auto_briefing'
/** Flag when the deterministic fallback wrote it (no model answered). */
export const AUTO_BRIEFING_FALLBACK_FLAG = 'auto_briefing_fallback'
/** The withdrawn reason for a stop that turned out to be an FYI. */
export const FYI_WITHDRAWN_REASON = 'FYI only, nothing to decide: moved to the activity feed'
/** An incomplete decision on a card still running is briefed after this long anyway. */
export const AUTOBRIEF_RUNNING_GRACE_MS = 3 * 60_000

export type BriefingDraft =
  | { kind: 'decision'; briefing: DecisionBriefing }
  | { kind: 'fyi'; summary: string }

export interface AutoBriefMaterial {
  decision: DecisionView
  objective: Objective | null
  /** A Q&A answer the bot gave on this decision, if any (newest). */
  answer?: string | null
  /** The owning bot's display name (cardOwnerBot), when known. */
  botName?: string | null
}

/** One model call: system + user text in, raw reply text out. */
export type BriefingModel = (p: { system: string; user: string; material: AutoBriefMaterial }) => Promise<string>

let modelOverride: BriefingModel | null | undefined
/** Tests: replace the model (null = "no model available", undefined restores the real one). */
export function setBriefingModel(m: BriefingModel | null | undefined): void {
  modelOverride = m
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function botLabel(m: AutoBriefMaterial): string {
  return m.botName || m.decision.agent_slug || m.objective?.owner_bot || (m.objective?.agent_context && m.objective.agent_context !== 'general' ? m.objective.agent_context : '') || 'the bot'
}

/** The newest bot answer in the decision's own Q&A thread. */
export function latestBotAnswer(d: DecisionView): string | null {
  for (let i = d.thread.length - 1; i >= 0; i--) {
    if (d.thread[i].role === 'bot' && d.thread[i].body.trim()) return d.thread[i].body
  }
  return null
}

/** The prompt. Exported for tests. */
export function autoBriefPrompt(m: AutoBriefMaterial): { system: string; user: string } {
  const o = m.objective
  const summary = o?.last_session_summary ? String(o.last_session_summary).slice(0, 4000) : ''
  const material = frameAndScan(
    {
      source: 'card-summary',
      scope: o?.workspace ?? m.decision.workspace ?? null,
      label: `card #${m.decision.objective_id}`,
      text: [
        o ? `Card title: ${o.title}` : '',
        m.decision.raw_note ? `The bot's stop note: ${m.decision.raw_note}` : '',
        m.decision.briefing.context && m.decision.briefing.context !== m.decision.raw_note ? `Context it gave: ${m.decision.briefing.context}` : '',
        summary ? `Session summary:\n${summary}` : '',
        m.answer ? `The bot's answer when the owner asked what it needs:\n${m.answer.slice(0, 2000)}` : '',
      ].filter(Boolean).join('\n\n'),
      maxChars: 9000,
    },
    { objectiveId: m.decision.objective_id, workspace: o?.workspace ?? null },
  )
  const system = [
    `A bot (${botLabel(m)}) stopped work on card #${m.decision.objective_id} for the owner's review without saying what the owner should decide.`,
    'Read its note and summary and reply with JSON ONLY (no prose, no code fence), in one of two shapes:',
    '1. The owner has to choose or approve something before the work can go on (a send, spend, merge, deploy, a choice between approaches, an unblock):',
    '{"kind":"decision","context":"2-3 sentences: where things stand and what this decision is for","question":"the decision as ONE question","options":[{"key":"A","label":"short","pros":["..."],"cons":["..."],"next":"what happens right after if chosen"},{"key":"B",...}],"recommended":"A","recommended_why":"one sentence"}',
    '2. Nothing needs the owner\'s choice (a report of work done, things to keep an eye on, checks for later):',
    '{"kind":"fyi","summary":"one or two sentences"}',
    'Rules: 2-4 options, each with at least one pro and one con. Under 200 words. Use only facts in the material; do not invent work. When the material asks to approve one plan, the options are to go ahead with it or to hold it. Plain words, no jargon.',
  ].join('\n')
  const user = ['## What the bot left', material].join('\n')
  return { system, user: redactDecisionText(user) }
}

/** Pull the first JSON object out of a model reply. */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1))
          return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Parse + validate a model reply. Null = unusable (the caller falls back). */
export function parseBriefingDraft(text: string): BriefingDraft | null {
  const obj = firstJsonObject(text ?? '')
  if (!obj) return null
  const kind = String(obj.kind ?? '').toLowerCase()
  if (kind === 'fyi') {
    const summary = typeof obj.summary === 'string' ? clip(obj.summary, 600) : ''
    return summary ? { kind: 'fyi', summary } : null
  }
  if (kind !== 'decision') return null
  const v = validateDecisionBriefing(obj)
  return v.ok ? { kind: 'decision', briefing: v.briefing } : null
}

/** First sentences of a text, up to `max` characters. */
function lead(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return stop > max / 3 ? cut.slice(0, stop + 1) : `${cut.slice(0, max - 1)}…`
}

/**
 * The deterministic briefing when no model answered: the bot's own words (its
 * Q&A answer first, else the note, else the summary) as the context and
 * "go ahead / hold" as the options. Always valid.
 */
export function fallbackBriefing(m: AutoBriefMaterial): DecisionBriefing {
  const bot = botLabel(m)
  const card = `card #${m.decision.objective_id}`
  const source = (m.answer && m.answer.trim())
    || (m.decision.raw_note && m.decision.raw_note.trim())
    || (m.decision.briefing.context && m.decision.briefing.context.trim())
    || (m.objective?.last_session_summary ? String(m.objective.last_session_summary) : '')
    || `${bot} stopped ${card} for your review without a note.`
  const context = clip(`${lead(source, DECISION_LIMITS.contextMax - 80)} (${bot} stopped ${card} for your review; this briefing was written from its note.)`, DECISION_LIMITS.contextMax)
  const v = validateDecisionBriefing({
    context,
    question: clip(`Should ${bot} go ahead with what it proposes on ${card}?`, DECISION_LIMITS.questionMax),
    options: [
      { key: 'A', label: 'Go ahead as proposed', pros: ['The work continues without waiting'], cons: ['Nothing is reviewed further first'], next: `${bot} goes ahead with what its note proposes.` },
      { key: 'B', label: 'Hold', pros: ['Nothing changes until you say so'], cons: ['The work waits for you'], next: `${bot} stops this line of work and waits for your instructions.` },
    ],
    recommended: 'B',
    recommended_why: 'The bot did not say what it needs, so holding until you have read the note above is the safe default.',
  })
  if (!v.ok) throw new Error(`fallback briefing invalid: ${v.errors.join('; ')}`)
  return v.briefing
}

async function realModel(p: { system: string; user: string; material: AutoBriefMaterial }): Promise<string> {
  // Lazy: the chat engine loads agent files and providers; tests never reach it.
  const { completeAsDecisionBot } = await import('./decision-answerer.js')
  return completeAsDecisionBot(p.material.decision, p.material.objective, p.system, p.user)
}

/** Ask the model for a draft. Null = no usable reply (caller falls back). */
export async function draftBriefing(m: AutoBriefMaterial): Promise<BriefingDraft | null> {
  const model = modelOverride === undefined ? realModel : modelOverride
  if (!model) return null
  try {
    const { system, user } = autoBriefPrompt(m)
    return parseBriefingDraft(await model({ system, user, material: m }))
  } catch (err) {
    console.warn(`[decision-autobrief] model call failed for decision ${m.decision.id}:`, err instanceof Error ? err.message : String(err))
    return null
  }
}

function addFlags(existing: string[], add: string[]): string {
  const keep = existing.filter(f => f !== 'no_question' && f !== 'no_options' && !add.includes(f))
  return JSON.stringify([...keep, ...add])
}

/** Write a briefing onto an open decision (it leaves `incomplete`). */
export function writeBriefing(db: Database.Database, d: DecisionView, b: DecisionBriefing, opts: { fallback: boolean; why: string }): DecisionView | null {
  const flags = [AUTO_BRIEFING_FLAG, ...(opts.fallback ? [AUTO_BRIEFING_FALLBACK_FLAG] : [])]
  const res = db
    .prepare(
      `UPDATE decisions SET incomplete = 0, flags = ?, context = ?, question = ?, options = ?, recommended = ?, recommended_why = ?, updated_at = datetime('now')
        WHERE id = ? AND state = 'open'`,
    )
    .run(addFlags(d.flags, flags), redactDecisionText(b.context), redactDecisionText(b.question), redactDecisionText(JSON.stringify(b.options)), b.recommended, redactDecisionText(b.recommended_why), d.id)
  if (!res.changes) return null
  db.prepare("INSERT INTO decision_messages (decision_id, role, author, body, status) VALUES (?, 'system', NULL, ?, NULL)").run(d.id, opts.why)
  return getDecision(db, d.id)
}

export interface FyiSink {
  /** Put the FYI on the activity feed. */
  logFyi: (p: { objective: Objective | null; decision: DecisionView; summary: string }) => void
}

/** Withdraw a no-decision stop and send it to the activity feed. */
export function routeAsFyi(db: Database.Database, d: DecisionView, objective: Objective | null, summary: string, sink: FyiSink): boolean {
  const res = db
    .prepare("UPDATE decisions SET state = 'withdrawn', withdrawn_reason = ?, updated_at = datetime('now') WHERE id = ? AND state = 'open'")
    .run(FYI_WITHDRAWN_REASON, d.id)
  if (!res.changes) return false
  db.prepare("INSERT INTO decision_messages (decision_id, role, author, body, status) VALUES (?, 'system', NULL, ?, NULL)")
    .run(d.id, `Nothing to decide here, so this left Needs you and went to the activity feed: ${summary}`)
  // A job that only reported finishes as complete, so no Needs you surface
  // (Jobs board lane, bot chat post) keeps asking about it.
  if (objective && (objective as Objective & { job_disposition?: string | null }).job_disposition === 'needs_review') {
    db.prepare("UPDATE objectives SET job_disposition = 'complete', updated_at = datetime('now') WHERE id = ? AND job_disposition = 'needs_review'").run(objective.id)
  }
  try {
    sink.logFyi({ objective, decision: d, summary })
  } catch (err) {
    console.warn(`[decision-autobrief] could not log FYI for decision ${d.id}:`, err instanceof Error ? err.message : String(err))
  }
  return true
}

export type AutoBriefResult =
  | { kind: 'briefed'; decision: DecisionView; fallback: boolean }
  | { kind: 'fyi'; summary: string }
  | { kind: 'skipped'; why: string }

const inFlight = new Set<number>()

function loadObjective(db: Database.Database, id: number): Objective | null {
  return (db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined) ?? null
}

/**
 * Give one decision a briefing (or route it as an FYI).
 *
 * Default: only an OPEN, INCOMPLETE decision is touched. `fromAnswer` = the bot
 * just answered a question on it: that answer is used as briefing material, and
 * a decision whose briefing the server wrote earlier is rewritten with it (a
 * rewrite never turns into an FYI: the person is already engaging with it).
 */
export async function autoBriefDecision(
  db: Database.Database,
  decisionId: number,
  sink: FyiSink,
  opts: { fromAnswer?: boolean } = {},
): Promise<AutoBriefResult> {
  if (inFlight.has(decisionId)) return { kind: 'skipped', why: 'already running' }
  inFlight.add(decisionId)
  try {
    const d = getDecision(db, decisionId)
    if (!d || d.state !== 'open') return { kind: 'skipped', why: 'not open' }
    const autoWritten = d.flags.includes(AUTO_BRIEFING_FLAG)
    if (!d.incomplete && !(opts.fromAnswer && autoWritten)) return { kind: 'skipped', why: 'has a briefing' }
    const objective = loadObjective(db, d.objective_id)
    const answer = latestBotAnswer(d)
    let botName: string | null = null
    try { botName = objective ? cardOwnerBot(objective, db)?.name ?? null : null } catch { /* slug fallback */ }
    const m: AutoBriefMaterial = { decision: d, objective, answer, botName }
    const draft = await draftBriefing(m)
    // Re-read: the person may have answered (or the card withdrawn it) meanwhile.
    const now = getDecision(db, decisionId)
    if (!now || now.state !== 'open') return { kind: 'skipped', why: 'settled while drafting' }
    if (draft?.kind === 'fyi' && !opts.fromAnswer && !now.thread.some(t => t.role === 'human')) {
      return routeAsFyi(db, now, objective, draft.summary, sink) ? { kind: 'fyi', summary: draft.summary } : { kind: 'skipped', why: 'settled while drafting' }
    }
    const fallback = draft?.kind !== 'decision'
    const briefing = draft?.kind === 'decision' ? draft.briefing : fallbackBriefing(m)
    const why = answer
      ? `The bot did not give a briefing, so this one was written from its answer in this thread${fallback ? '' : ' and its session summary'}.`
      : fallback
        ? 'The bot did not give a briefing, so this one was written from its note (no model was available to summarise it).'
        : 'The bot did not give a briefing, so this one was written automatically from its note and session summary.'
    const written = writeBriefing(db, now, briefing, { fallback, why })
    return written ? { kind: 'briefed', decision: written, fallback } : { kind: 'skipped', why: 'settled while drafting' }
  } finally {
    inFlight.delete(decisionId)
  }
}

/**
 * The open, incomplete decisions due for a briefing: their card has stopped
 * running (so the summary is written), or they have waited past the grace.
 */
export function decisionsDueForBriefing(db: Database.Database, opts: { objectiveId?: number; nowMs?: number } = {}): number[] {
  getDecision(db, -1)
  const one = opts.objectiveId != null
  const graceIso = new Date((opts.nowMs ?? Date.now()) - AUTOBRIEF_RUNNING_GRACE_MS).toISOString().replace('T', ' ').slice(0, 19)
  const rows = db
    .prepare(
      `SELECT d.id FROM decisions d LEFT JOIN objectives o ON o.id = d.objective_id
        WHERE d.state = 'open' AND d.incomplete = 1
          AND (o.id IS NULL OR o.status != 'working' OR d.created_at <= ?)
          ${one ? 'AND d.objective_id = ?' : ''}
        ORDER BY d.id LIMIT 20`,
    )
    .all(graceIso, ...(one ? [opts.objectiveId] : [])) as { id: number }[]
  return rows.map(r => r.id)
}

/** Brief every due decision (optionally for one card). Never throws. */
export async function briefDueDecisions(db: Database.Database, sink: FyiSink, opts: { objectiveId?: number; nowMs?: number } = {}): Promise<AutoBriefResult[]> {
  const out: AutoBriefResult[] = []
  let ids: number[] = []
  try {
    ids = decisionsDueForBriefing(db, opts)
  } catch (err) {
    console.warn('[decision-autobrief] could not list due decisions:', err instanceof Error ? err.message : String(err))
    return out
  }
  for (const id of ids) {
    try {
      out.push(await autoBriefDecision(db, id, sink))
    } catch (err) {
      console.warn(`[decision-autobrief] decision ${id}:`, err instanceof Error ? err.message : String(err))
    }
  }
  return out
}
