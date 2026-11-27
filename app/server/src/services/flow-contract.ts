/**
 * The end-condition CONTRACT of a goal-defined workflow (obj 901766; extends
 * card B6 `flow-builder.ts` and card B5's publish gate `flow-self-test.ts`;
 * docs/design/WORKFLOWS.md §3.3 and §5.1 step 1).
 *
 * A person states a goal and how to know it worked — in plain words (`done_when`)
 * and/or as machine-checkable asserts (`goal.end_condition`). That end condition
 * is what every self-test and live run is graded against, so it is stored on the
 * flow row (not only in the builder card's brief) and enforced:
 *
 *   - Create: an end condition given with the goal is PINNED. A person's is
 *     confirmed at once; an agent key's waits for a person.
 *   - Draft: an AGENT draft (builder card, agent key) whose end condition differs
 *     from the pinned one is refused `end_condition_changed`. The builder may not
 *     weaken the test to make its own self-test pass.
 *   - First agent draft with no pin: its end condition becomes the PROPOSED
 *     contract (unconfirmed), so later drafts cannot drift from it either.
 *   - A person's own draft (cookie / JWT user) becomes the confirmed contract:
 *     their words. A chat bot's Full access draft (`bot:<slug>`) is an agent's.
 *   - Publish: an agent-written version whose end condition no person has
 *     confirmed needs `confirm_end_condition: true` from the (cookie owner/admin)
 *     publisher; publishing then pins it as confirmed by that person.
 *
 * DB-injected, so it runs on a temp DB in tests.
 */
import type Database from 'better-sqlite3'
import { initFlowSchema } from '../db/schema/flow.js'
import {
  checkEndConditionContract, isAgentWrittenAuthor, sameEndCondition, type EndConditionCheck, type FlowEndConditionContract,
} from '../../../shared/flow/end-condition.js'
import type { FlowDefinition } from '../../../shared/flow/types.js'

interface ContractRow {
  done_when: string | null
  end_condition_json: string | null
  end_condition_confirmed_by: string | null
  end_condition_confirmed_at: string | null
}

function parseJson(s: string | null): unknown | null {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function readFlowContract(db: Database.Database, flowId: number): FlowEndConditionContract {
  initFlowSchema(db)
  const row = db.prepare(
    'SELECT done_when, end_condition_json, end_condition_confirmed_by, end_condition_confirmed_at FROM flow_definitions WHERE id = ?',
  ).get(flowId) as ContractRow | undefined
  return {
    done_when: row?.done_when ?? null,
    end_condition: parseJson(row?.end_condition_json ?? null),
    confirmed_by: row?.end_condition_confirmed_by ?? null,
    confirmed_at: row?.end_condition_confirmed_at ?? null,
  }
}

/** Pin an end condition. `confirmedBy` = `user:<id>` when a person gave or confirmed it, else null (proposed). */
export function pinFlowEndCondition(
  db: Database.Database,
  flowId: number,
  endCondition: unknown,
  confirmedBy: string | null,
  now: string = new Date().toISOString(),
): void {
  initFlowSchema(db)
  db.prepare(
    `UPDATE flow_definitions SET end_condition_json = ?, end_condition_confirmed_by = ?, end_condition_confirmed_at = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  ).run(JSON.stringify(endCondition), confirmedBy, confirmedBy ? now : null, flowId)
}

export function setFlowDoneWhen(db: Database.Database, flowId: number, doneWhen: string | null): void {
  initFlowSchema(db)
  db.prepare('UPDATE flow_definitions SET done_when = ? WHERE id = ?').run(doneWhen, flowId)
}

const endConditionOf = (def: Pick<FlowDefinition, 'goal'> | null | undefined): unknown | null =>
  (def?.goal as { end_condition?: unknown } | undefined)?.end_condition ?? null

export type AgentDraftContractCheck =
  | { ok: true; pinProposed: unknown | null }
  | { ok: false; pinned: unknown; confirmed_by: string | null; error: string }

/**
 * Before an AGENT draft is saved: may it carry this end condition? Refused when
 * the flow has a pinned end condition and the draft's differs. When nothing is
 * pinned yet, `pinProposed` is the draft's end condition, to be pinned (as
 * unconfirmed) once the draft is saved.
 */
export function checkAgentDraftEndCondition(
  db: Database.Database,
  flowId: number,
  def: Pick<FlowDefinition, 'goal'>,
): AgentDraftContractCheck {
  const c = readFlowContract(db, flowId)
  const ec = endConditionOf(def)
  if (c.end_condition == null) return { ok: true, pinProposed: ec }
  if (sameEndCondition(ec, c.end_condition)) return { ok: true, pinProposed: null }
  return {
    ok: false,
    pinned: c.end_condition,
    confirmed_by: c.confirmed_by,
    error:
      'end_condition_changed: goal.end_condition is the contract this workflow is graded against and must stay exactly as pinned' +
      (c.confirmed_by ? ` (given or confirmed by ${c.confirmed_by})` : ' (your first draft proposed it; the owner confirms it at publish)') +
      '. Fix the steps, not the test. If the end condition itself is wrong, stop and say so in your summary for the owner.',
  }
}

/**
 * After a version is saved: a person's draft is their own words, so it becomes
 * the confirmed contract; an agent's draft pins its end condition only when
 * nothing is pinned yet (the PROPOSED contract, unconfirmed).
 */
export function noteFlowVersionSaved(
  db: Database.Database,
  flowId: number,
  def: Pick<FlowDefinition, 'goal'>,
  author: string,
): void {
  const ec = endConditionOf(def)
  if (ec == null) return
  if (!isAgentWrittenAuthor(author)) {
    pinFlowEndCondition(db, flowId, ec, author)
    return
  }
  if (readFlowContract(db, flowId).end_condition == null) pinFlowEndCondition(db, flowId, ec, null)
}

/** Publish-time view of one version: its end condition and whether a person must confirm it. */
export function endConditionPublishState(
  db: Database.Database,
  flowId: number,
  version: number,
  def: Pick<FlowDefinition, 'goal'> | null,
): {
  value: unknown | null
  confirmation_required: boolean
  reason: 'proposed_by_agent' | 'differs_from_confirmed' | null
  contract: FlowEndConditionContract
  check: EndConditionCheck
} {
  initFlowSchema(db)
  const contract = readFlowContract(db, flowId)
  const author = (db.prepare('SELECT author FROM flow_versions WHERE flow_id = ? AND version = ?').get(flowId, version) as
    | { author: string }
    | undefined)?.author ?? null
  const value = endConditionOf(def)
  const check = checkEndConditionContract({ versionEndCondition: value, versionAuthor: author, contract })
  return {
    value,
    confirmation_required: check.status === 'needs_confirmation',
    reason: check.status === 'needs_confirmation' ? check.reason : null,
    contract,
    check,
  }
}
