/**
 * Review rubric when a card has none locked (obj 901460).
 *
 * The AI reviewer grades against `objectives.acceptance_criteria`. The rubric is normally
 * written by the reviewer itself on iteration 1 (POST /api/internal/reviews/:id/criteria),
 * or pre-supplied by a delegator. When neither happened — the iteration-1 reviewer died or
 * skipped the POST, so iteration 2+ was told to LOAD a rubric that was never locked — the
 * GET returned `{criteria: null}` and the reviewer gave up as `blocked` with no usable
 * verdict (#901330, PR 871: three reviews, three `criteria: null`).
 *
 * `ensureReviewRubric` closes that hole: a card with no (or an empty) locked rubric gets a
 * short rubric DERIVED from its own title / description / completion goal, locked the same
 * way the reviewer's POST locks it. When the card text is too thin to grade against, it
 * returns a plain `reason` instead — never a silent null.
 *
 * Deterministic, no model call: the derivation only restates what the card already asks for.
 */
import type Database from 'better-sqlite3'
import type { AcceptanceCriterion } from '@operationkit/shared'

export interface RubricCardText {
  title?: string | null
  description?: string | null
  completion_goal?: string | null
}

export type DerivedRubric =
  | { criteria: AcceptanceCriterion[]; reason?: undefined }
  | { criteria: null; reason: string }

export type EnsuredRubric =
  | { criteria: AcceptanceCriterion[]; source: 'locked' | 'derived'; reason?: undefined }
  | { criteria: null; source: 'none'; reason: string }

/** Most criteria a derived rubric carries (the reviewer's own range is 3-7). */
export const MAX_DERIVED_CRITERIA = 6
const MAX_CRITERION_CHARS = 300

/** Parse a stored rubric. Anything unparseable, non-array or empty counts as NOT locked. */
export function parseLockedCriteria(raw: unknown): AcceptanceCriterion[] {
  if (Array.isArray(raw)) return raw as AcceptanceCriterion[]
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as AcceptanceCriterion[]) : []
  } catch {
    return []
  }
}

export function hasLockedCriteria(raw: unknown): boolean {
  return parseLockedCriteria(raw).length > 0
}

// A rubric must grade the deliverable, never PR lifecycle (the review IS the gate those
// steps pass through — same rule the reviewer prompt gives a model-written rubric) or the
// card's process/guard-rail lines.
const LIFECYCLE_OR_PROCESS =
  /\bpull request\b|\bPR\s+(?:is\s+)?(?:open|opened|created|merged)\b|\bmerge[ds]?\b|\bdeploy|\bCI\b|\bNOTES\.md\b/i

const DONE_PREFIX = /^(?:done|definition of done|acceptance(?: criteria)?|success|done when)\s*[:\-–—]\s*/i
const CHANGE_PREFIX = /^(?:change|fix|goal|deliverable|build)\s*[:\-–—]\s*/i
const SECTION_HEAD = /^(?:#+\s*)?(?:done|definition of done|acceptance criteria|acceptance|success criteria|deliverables?)\s*:?\s*$/i
const BULLET = /^(?:[-*•]|\d+[.)])\s+/

function clean(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > MAX_CRITERION_CHARS ? `${t.slice(0, MAX_CRITERION_CHARS - 1)}…` : t
}

function slug(s: string, fallback: string): string {
  const v = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return v || fallback
}

/** Pure: derive a short rubric from the card's own text, or say why it cannot. */
export function deriveRubricFromCard(card: RubricCardText): DerivedRubric {
  const title = clean(card.title ?? '')
  const description = (card.description ?? '').trim()
  const goal = (card.completion_goal ?? '').trim()

  const statements: Array<{ text: string; kind: 'done' | 'change' }> = []
  const push = (text: string, kind: 'done' | 'change') => {
    const t = clean(text)
    if (t.length < 8 || LIFECYCLE_OR_PROCESS.test(t)) return
    if (statements.some((s) => s.text.toLowerCase() === t.toLowerCase())) return
    statements.push({ text: t, kind })
  }

  let inDoneSection = false
  for (const raw of `${description}\n${goal}`.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) { inDoneSection = false; continue }
    if (SECTION_HEAD.test(line)) { inDoneSection = true; continue }
    if (DONE_PREFIX.test(line)) { push(line.replace(DONE_PREFIX, ''), 'done'); continue }
    if (CHANGE_PREFIX.test(line)) { push(line.replace(CHANGE_PREFIX, ''), 'change'); continue }
    if (inDoneSection && BULLET.test(line)) { push(line.replace(BULLET, ''), 'done'); continue }
    if (inDoneSection && !BULLET.test(line)) inDoneSection = false
  }

  // Nothing structured: the description's first plain paragraph is the ask.
  if (statements.length === 0 && description) {
    const firstPara = description.split(/\n\s*\n/)[0] ?? ''
    push(firstPara, 'change')
  }
  if (goal && !statements.some((s) => s.kind === 'done')) {
    push(goal.split(/\n\s*\n/)[0] ?? '', 'done')
  }

  const titleWords = title.split(/\s+/).filter(Boolean).length
  if (statements.length === 0 && titleWords < 3) {
    const why = !title && !description && !goal
      ? 'the card has no title, description or completion goal'
      : 'the card title is too short to grade against and the description/completion goal has no testable statement'
    return {
      criteria: null,
      reason: `No acceptance criteria are locked and none could be derived: ${why}. ` +
        'Add a "Done:" line to the card description (or lock criteria via POST /api/internal/reviews/:id/criteria), then re-request the review.',
    }
  }

  const criteria: AcceptanceCriterion[] = []
  if (title) {
    criteria.push({
      id: 'card-title-delivered',
      criterion: `The change on the card's branch delivers what the card title asks for: "${title}".`,
      type: 'functional',
      method: 'doc',
    })
  }
  const used = new Set(criteria.map((c) => c.id))
  for (const [i, s] of statements.entries()) {
    if (criteria.length >= MAX_DERIVED_CRITERIA - 1) break
    let id = `${s.kind}-${slug(s.text, String(i + 1))}`
    while (used.has(id)) id = `${id}-${i + 1}`
    used.add(id)
    criteria.push({
      id,
      criterion: s.kind === 'done'
        ? `Done as the card states it: ${s.text}`
        : `The change the card asks for is made: ${s.text}`,
      type: 'functional',
      method: 'doc',
    })
  }
  criteria.push({
    id: 'checks-pass',
    criterion: 'The code on the branch typechecks and its own tests (new or updated for this change) pass.',
    type: 'functional',
    method: 'static',
  })
  return { criteria }
}

interface RubricRow {
  id: number
  title: string | null
  description: string | null
  completion_goal: string | null
  acceptance_criteria: string | null
}

/**
 * Return the locked rubric for a card; when none is locked, derive one from the card text
 * and LOCK it (only if still unlocked — a concurrent reviewer POST wins), or return the
 * reason it cannot be derived. Returns null when the objective does not exist.
 */
export function ensureReviewRubric(db: Database.Database, objectiveId: number | string): EnsuredRubric | null {
  const row = db
    .prepare('SELECT id, title, description, completion_goal, acceptance_criteria FROM objectives WHERE id = ?')
    .get(objectiveId) as RubricRow | undefined
  if (!row) return null

  const locked = parseLockedCriteria(row.acceptance_criteria)
  if (locked.length > 0) return { criteria: locked, source: 'locked' }

  const derived = deriveRubricFromCard(row)
  if (!derived.criteria) {
    console.warn(`[review-rubric] obj ${row.id}: no rubric locked and none derivable — ${derived.reason}`)
    return { criteria: null, source: 'none', reason: derived.reason }
  }

  const res = db
    .prepare(
      `UPDATE objectives SET acceptance_criteria = ?, updated_at = datetime('now')
        WHERE id = ? AND (acceptance_criteria IS NULL OR TRIM(acceptance_criteria) IN ('', '[]', 'null'))`,
    )
    .run(JSON.stringify(derived.criteria), row.id)
  if (res.changes === 0) {
    // Someone locked a rubric between our read and write — theirs is the lock.
    const again = db.prepare('SELECT acceptance_criteria FROM objectives WHERE id = ?').get(row.id) as
      | { acceptance_criteria: string | null } | undefined
    const theirs = parseLockedCriteria(again?.acceptance_criteria)
    if (theirs.length > 0) return { criteria: theirs, source: 'locked' }
  }
  console.log(`[review-rubric] obj ${row.id}: no rubric was locked — locked ${derived.criteria.length} criteria derived from the card text`)
  return { criteria: derived.criteria, source: 'derived' }
}
