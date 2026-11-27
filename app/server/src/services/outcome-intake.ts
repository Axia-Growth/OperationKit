/**
 * Outcome-first intake (obj 901764): propose → the person edits → approve → filed and started.
 *
 * The shape and its checks live in `shared/outcome-intake.ts`. This module owns
 * the two tables (`db/schema/outcome-intake.ts`) and the approve step, which
 * reuses every existing path instead of a parallel intake system:
 *
 *   - filing      `createCard` (agent-chat/tools.ts) — the same guarded path a
 *                 chat bot's `create_objective` takes: person ∩ bot workspace,
 *                 protected-PR text check, possible-duplicate guard, idempotency
 *                 key, bot ownership and model. The cards are the bot's cards.
 *   - planning    the approved breakdown is written to the card's
 *                 `approved_plan` / `plan_approved_at` — the planning stage's own
 *                 columns, rendered to the worker as "Approved Plan".
 *   - criteria    `acceptance_criteria`, the column the worker prompt and the
 *                 independent AI reviewer already read. Standing rules are frozen
 *                 into it as `rule-<id>`.
 *   - children    filed under the outcome card and registered as a fan-out
 *                 (`registerFanout`), so the poller's fan-out tick starts them
 *                 under its concurrency ceiling, exactly like a worker's fan-out.
 *   - start       the caller's `startCard` — the route passes the board's own
 *                 Start (`runStatusChange` → working), so every start gate applies.
 */
import type { Database } from 'better-sqlite3'
import { initOutcomeIntakeSchema } from '../db/schema/outcome-intake.js'
import {
  MAX_RULES_PER_WORKSPACE,
  normalizeProposal,
  normalizeRuleScope,
  normalizeRuleText,
  renderApprovedBreakdown,
  withRuleCriteria,
  type OutcomeProposal,
  type OutcomeRule,
  type ProposalStatus,
  type RuleScope,
} from '../../../shared/outcome-intake.js'
import { registerFanout } from './fanout.js'

export interface ProposalRow {
  id: number
  user_id: number
  agent_slug: string
  thread_id: number | null
  workspace: string
  proposal: OutcomeProposal
  status: ProposalStatus
  card_id: number | null
  child_ids: number[]
  start_note: string | null
  created_at: string
  updated_at: string
  decided_at: string | null
}

interface RawRow extends Omit<ProposalRow, 'proposal' | 'child_ids'> {
  proposal_json: string
  child_ids: string | null
}

let ensured = new WeakSet<object>()
function ensure(db: Database): void {
  if (ensured.has(db)) return
  initOutcomeIntakeSchema(db as never)
  ensured.add(db)
}

/** Test hook: forget which DB handles already have the tables. */
export function _resetOutcomeIntakeSchemaCache(): void {
  ensured = new WeakSet()
}

function toRow(r: RawRow): ProposalRow {
  let proposal: OutcomeProposal
  try {
    proposal = normalizeProposal(JSON.parse(r.proposal_json)).proposal
  } catch {
    proposal = normalizeProposal({}).proposal
  }
  let childIds: number[] = []
  try {
    childIds = r.child_ids ? (JSON.parse(r.child_ids) as number[]) : []
  } catch { /* stays empty */ }
  const { proposal_json: _json, ...rest } = r
  return { ...rest, proposal, child_ids: childIds }
}

export function getProposal(db: Database, id: number): ProposalRow | null {
  ensure(db)
  const r = db.prepare('SELECT * FROM outcome_proposals WHERE id = ?').get(id) as RawRow | undefined
  return r ? toRow(r) : null
}

export type CreateProposalResult = { ok: true; row: ProposalRow } | { ok: false; errors: string[] }

/** Store a proposed breakdown. Nothing is filed: the person approves it first. */
export function createProposal(
  db: Database,
  input: { userId: number; agentSlug: string; threadId?: number | null; workspace: string; raw: unknown },
): CreateProposalResult {
  ensure(db)
  const n = normalizeProposal(input.raw)
  if (!n.ok) return { ok: false, errors: n.errors }
  const info = db
    .prepare('INSERT INTO outcome_proposals (user_id, agent_slug, thread_id, workspace, proposal_json) VALUES (?, ?, ?, ?, ?)')
    .run(input.userId, input.agentSlug, input.threadId ?? null, input.workspace, JSON.stringify(n.proposal))
  return { ok: true, row: getProposal(db, Number(info.lastInsertRowid))! }
}

/** End a reason with a full stop so the next sentence of the note reads cleanly. */
const sentence = (t: string): string => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`)

// ── standing rules ──

export function listRules(db: Database, workspace: string): OutcomeRule[] {
  ensure(db)
  return db
    .prepare('SELECT id, workspace, text, applies_to, created_by, created_at FROM outcome_rules WHERE workspace = ? AND deleted_at IS NULL ORDER BY id')
    .all(workspace) as OutcomeRule[]
}

export type AddRuleResult = { ok: true; rule: OutcomeRule; existing: boolean } | { ok: false; error: string }

/** Save a standing rule for a workspace. The same words twice return the rule already saved. */
export function addRule(
  db: Database,
  input: { workspace: string; text: unknown; appliesTo?: unknown; userId: number | null; sourceProposalId?: number | null },
): AddRuleResult {
  ensure(db)
  const text = normalizeRuleText(input.text)
  if (!text) return { ok: false, error: 'A standing rule needs its text, e.g. "before-and-after screenshots in the pull request".' }
  const appliesTo: RuleScope = normalizeRuleScope(input.appliesTo)
  const current = listRules(db, input.workspace)
  const same = current.find(r => r.text.toLowerCase() === text.toLowerCase())
  if (same) return { ok: true, rule: same, existing: true }
  if (current.length >= MAX_RULES_PER_WORKSPACE) {
    return { ok: false, error: `This workspace already has ${MAX_RULES_PER_WORKSPACE} standing rules. Remove one first.` }
  }
  const info = db
    .prepare('INSERT INTO outcome_rules (workspace, text, applies_to, created_by, source_proposal_id) VALUES (?, ?, ?, ?, ?)')
    .run(input.workspace, text, appliesTo, input.userId, input.sourceProposalId ?? null)
  const rule = db
    .prepare('SELECT id, workspace, text, applies_to, created_by, created_at FROM outcome_rules WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as OutcomeRule
  return { ok: true, rule, existing: false }
}

/** Remove a standing rule (soft delete). Cards that already froze it keep their criterion. */
export function removeRule(db: Database, input: { id: number; workspace?: string; userId: number | null }): boolean {
  ensure(db)
  const where = input.workspace === undefined ? 'id = ?' : 'id = ? AND workspace = ?'
  const args: unknown[] = input.workspace === undefined ? [input.id] : [input.id, input.workspace]
  const r = db
    .prepare(`UPDATE outcome_rules SET deleted_at = datetime('now'), deleted_by = ? WHERE ${where} AND deleted_at IS NULL`)
    .run(input.userId, ...args)
  return r.changes > 0
}

export function getRule(db: Database, id: number): (OutcomeRule & { deleted_at: string | null }) | null {
  ensure(db)
  return (db.prepare('SELECT id, workspace, text, applies_to, created_by, created_at, deleted_at FROM outcome_rules WHERE id = ?').get(id) as (OutcomeRule & { deleted_at: string | null }) | undefined) ?? null
}

// ── edit / discard ──

export type EditResult = { ok: true; row: ProposalRow } | { ok: false; code: 'not_found' | 'not_pending' | 'invalid'; error: string; errors?: string[] }

/** Save the person's edits to a pending proposal. Invalid edits are refused with the exact gaps. */
export function updateProposal(db: Database, id: number, raw: unknown): EditResult {
  ensure(db)
  const row = getProposal(db, id)
  if (!row) return { ok: false, code: 'not_found', error: 'Proposal not found' }
  if (row.status !== 'pending') return { ok: false, code: 'not_pending', error: `This breakdown is already ${row.status}` }
  const n = normalizeProposal(raw)
  if (!n.ok) return { ok: false, code: 'invalid', error: n.errors.join('; '), errors: n.errors }
  db.prepare("UPDATE outcome_proposals SET proposal_json = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'").run(JSON.stringify(n.proposal), id)
  return { ok: true, row: getProposal(db, id)! }
}

export function discardProposal(db: Database, id: number): EditResult {
  ensure(db)
  const row = getProposal(db, id)
  if (!row) return { ok: false, code: 'not_found', error: 'Proposal not found' }
  if (row.status !== 'pending') return { ok: false, code: 'not_pending', error: `This breakdown is already ${row.status}` }
  db.prepare("UPDATE outcome_proposals SET status = 'discarded', decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'").run(id)
  return { ok: true, row: getProposal(db, id)! }
}

// ── approve ──

/** One card filed through the chat bot's own create path. */
export type FileCardOutcome =
  | { filed: true; id: number; reused: boolean }
  | { filed: false; duplicate: { id: number; title: string; status: string } }

export interface ApproveDeps {
  /** File one card the way the bot's create_objective does. Throws with a person-readable message on refusal. */
  fileCard: (input: {
    title: string
    description: string
    doneWhen: string
    stopConditions: string[]
    parentId: number | null
    idempotencyKey: string
    fileAnyway: boolean
  }) => FileCardOutcome
  /** Start a card the way the board's Start button does. */
  startCard: (id: number) => Promise<{ ok: boolean; status?: string; reason?: string }>
  /** Who approved it, for the approved plan's first line. */
  approvedBy: string
  /** Max children the fan-out runs at once. */
  fanoutConcurrency?: number
}

export type ApproveResult =
  | { ok: true; row: ProposalRow; cardId: number; childIds: number[]; started: boolean; startNote: string }
  | { ok: false; code: 'not_found' | 'not_pending' | 'invalid' | 'duplicate' | 'refused'; error: string; errors?: string[]; duplicate?: { id: number; title: string; status: string } }

/**
 * File and start an approved breakdown. `raw` is the proposal AS THE PERSON
 * LEFT IT in the panel (their edits win over what the bot proposed). The claim
 * (`pending → approving`) makes a double click file nothing twice.
 */
export async function approveProposal(
  db: Database,
  id: number,
  raw: unknown,
  opts: { userId: number; fileAnyway?: boolean },
  deps: ApproveDeps,
): Promise<ApproveResult> {
  ensure(db)
  const row = getProposal(db, id)
  if (!row) return { ok: false, code: 'not_found', error: 'Proposal not found' }
  if (row.status !== 'pending') return { ok: false, code: 'not_pending', error: `This breakdown is already ${row.status}` }
  const n = normalizeProposal(raw === undefined || raw === null ? row.proposal : raw)
  if (!n.ok) return { ok: false, code: 'invalid', error: n.errors.join('; '), errors: n.errors }
  const p = n.proposal

  const claimed = db
    .prepare("UPDATE outcome_proposals SET status = 'approving', proposal_json = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(JSON.stringify(p), id)
  if (claimed.changes === 0) return { ok: false, code: 'not_pending', error: 'This breakdown is already being approved' }
  const release = () => db.prepare("UPDATE outcome_proposals SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'approving'").run(id)

  // (1) The outcome card. A refusal or a possible duplicate leaves the
  // proposal pending and NOTHING filed, so the person can fix and retry.
  let parent: FileCardOutcome
  try {
    parent = deps.fileCard({
      title: p.card.title,
      description: p.card.brief,
      doneWhen: p.card.done_when,
      stopConditions: p.card.stop_conditions,
      parentId: null,
      idempotencyKey: `outcome-${id}`,
      fileAnyway: !!opts.fileAnyway,
    })
  } catch (err) {
    release()
    return { ok: false, code: 'refused', error: err instanceof Error ? err.message : String(err) }
  }
  if (!parent.filed) {
    release()
    return {
      ok: false,
      code: 'duplicate',
      error: `An open card looks like the same work: #${parent.duplicate.id} "${parent.duplicate.title}" (${parent.duplicate.status}). Follow that card, or approve again with "File anyway".`,
      duplicate: parent.duplicate,
    }
  }
  const cardId = parent.id

  // (2) Standing rules: save the ones the person kept ticked, then freeze every
  // rule that applies into the criteria (the reviewer grades them by id).
  for (const s of p.suggested_rules) {
    if (!s.save) continue
    addRule(db, { workspace: row.workspace, text: s.text, appliesTo: s.applies_to, userId: opts.userId, sourceProposalId: id })
  }
  const skip = new Set(p.skip_rule_ids)
  const rules = listRules(db, row.workspace).filter(r => !skip.has(r.id))

  // (3) Children, under the outcome card. The person approved each one, so a
  // look-alike elsewhere on the board never holds a child back half-filed.
  const childIds: number[] = []
  const problems: string[] = []
  p.children.forEach((c, i) => {
    try {
      const out = deps.fileCard({
        title: c.title,
        description: `Part ${i + 1} of ${p.children.length} of the outcome on card #${cardId} ("${p.card.title}"). Do only this part.\n\n${c.brief}`,
        doneWhen: c.done_when,
        stopConditions: c.stop_conditions,
        parentId: cardId,
        idempotencyKey: `outcome-${id}-c${i + 1}`,
        fileAnyway: true,
      })
      if (out.filed) childIds.push(out.id)
      else problems.push(`"${c.title}" was not filed (looks like #${out.duplicate.id})`)
    } catch (err) {
      problems.push(`"${c.title}" was not filed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // (4) The approved bar on every card: criteria (+ rules) and the approved plan.
  const setBar = db.prepare("UPDATE objectives SET acceptance_criteria = ?, approved_plan = ?, plan_approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
  setBar.run(
    JSON.stringify(withRuleCriteria(p.card.criteria, rules)),
    renderApprovedBreakdown(p, { approvedBy: deps.approvedBy, childIds }),
    cardId,
  )
  p.children.forEach((c, i) => {
    const cid = childIds[i]
    if (!cid) return
    setBar.run(
      JSON.stringify(withRuleCriteria(c.criteria, rules)),
      [`Approved by ${deps.approvedBy} as part ${i + 1} of the outcome on card #${cardId}.`, '', `Done when: ${c.done_when}`, '', 'An independent reviewer grades this card against the acceptance criteria below; you do not grade yourself.'].join('\n'),
      cid,
    )
  })

  // (5) Children run as a fan-out under the server's ceiling.
  if (childIds.length > 0) {
    try {
      registerFanout(db, cardId, childIds, deps.fanoutConcurrency ?? 3)
    } catch (err) {
      problems.push(`the child cards could not be registered to start in parallel (${err instanceof Error ? err.message : String(err)}); start them from the board`)
    }
  }

  db.prepare("UPDATE outcome_proposals SET status = 'approved', card_id = ?, child_ids = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(cardId, JSON.stringify(childIds), id)

  // (6) Start the outcome card with the board's own Start.
  let started = false
  let startNote: string
  try {
    const s = await deps.startCard(cardId)
    started = s.ok && s.status === 'working'
    startNote = started
      ? `Card #${cardId} started.`
      : `Card #${cardId} is filed but did not start yet: ${sentence(s.reason ?? s.status ?? 'unknown reason')}`
  } catch (err) {
    startNote = `Card #${cardId} is filed but did not start yet: ${sentence(err instanceof Error ? err.message : String(err))}`
  }
  if (childIds.length > 0) startNote += ` ${childIds.length} child card(s) (${childIds.map(c => `#${c}`).join(', ')}) start in parallel as slots free.`
  if (problems.length > 0) startNote += ` Problems: ${problems.join('; ')}.`
  db.prepare('UPDATE outcome_proposals SET start_note = ? WHERE id = ?').run(startNote, id)

  return { ok: true, row: getProposal(db, id)!, cardId, childIds, started, startNote }
}

/**
 * The chat system-prompt line for a bot with propose_outcome (implied by
 * create_objective). The person owns the problem and the done-bar; the bot owns
 * how it is done.
 */
export const OUTCOME_INTAKE_PROMPT_LINE =
  '- When the person states an outcome they want built or done (not a quick question), propose the breakdown with propose_outcome: ' +
  'one card in their words, a checkable done_when, acceptance criteria a reviewer can test, and child cards only for independent parts. ' +
  'They approve or edit it in this chat, and their click files and starts the work. Never ask them to pick skills, tools or knowledge folders; ' +
  'ask at most one short question first, and only if the outcome is unclear. A rule they want on every card ("screenshots on every PR") goes in standing_rules, never a skill file. ' +
  'For a small, fully specified job they ask you to file directly, create_objective is still fine.'

// ── standing rules on every card in the workspace ──

/**
 * The standing rules a card in `workspace` must also meet, as prompt lines for
 * the worker or the reviewer. A rule already frozen into the card's acceptance
 * criteria (an intake card, `rule-<id>`) is left out here: it is graded there.
 * No rules (or no workspace) = no lines, so the prompt is byte-identical to
 * before this feature.
 */
export function standingRulesPromptLines(
  db: Database | (() => Database),
  objective: { workspace?: string | null; acceptance_criteria?: unknown },
  audience: 'worker' | 'reviewer',
): string[] {
  const ws = typeof objective.workspace === 'string' ? objective.workspace.trim() : ''
  if (!ws) return []
  let rules: OutcomeRule[]
  try {
    // A getter, so a prompt built with no database (tests, tools) is unchanged rather than an error.
    rules = listRules(typeof db === 'function' ? db() : db, ws)
  } catch {
    return []
  }
  let criteria: unknown = objective.acceptance_criteria
  if (typeof criteria === 'string') {
    try { criteria = JSON.parse(criteria) } catch { criteria = null }
  }
  const frozen = new Set(Array.isArray(criteria) ? (criteria as { id?: unknown }[]).map(c => String(c?.id ?? '')) : [])
  const open = rules.filter(r => !frozen.has(`rule-${r.id}`))
  if (open.length === 0) return []
  const items = open.map(r => `- ${r.applies_to === 'pr' ? 'Every pull request: ' : ''}${r.text}`)
  return audience === 'worker'
    ? [
        '',
        '## Standing outcome rules for this workspace',
        '',
        'The people who run this workspace set these rules for EVERY card. They are part of your definition of done, and the reviewer checks them. A rule marked "Every pull request" applies only if you open one.',
        '',
        ...items,
      ]
    : [
        '',
        '## Standing outcome rules (set for every card in this workspace)',
        '',
        'Grade these exactly like acceptance criteria. A rule marked "Every pull request" applies only when this card opened a pull request; otherwise skip it. A rule that applies and is not met is a FAIL.',
        '',
        ...items,
      ]
}
