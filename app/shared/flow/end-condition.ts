// The end-condition CONTRACT of a goal-defined workflow (obj 901766,
// docs/design/WORKFLOWS.md §3.3 and §5.1 step 1).
//
// A workflow is "goal-defined": a person states the goal and how to know it
// worked. The machine-checkable form is `goal.end_condition` (deterministic
// asserts + an optional judge). It is the contract the self-test and every live
// run are graded against, so:
//   - an AGENT (builder card, agent key) may never change it once a person has
//     given or confirmed it — otherwise "self-test passed" could mean "the
//     builder weakened the test until it passed";
//   - when the builder PROPOSES it (the person only wrote plain words), a person
//     confirms it at publish, and from then on it is pinned.
//
// Pure, dependency-free; shared by the server (create / draft / publish gate)
// and the client (publish panel).

/** Max length of the plain-words "Done when" a person gives with the goal. */
export const FLOW_DONE_WHEN_MAX_CHARS = 1000

export interface EndConditionLike {
  assert?: { expr?: unknown; why?: unknown }[] | unknown
  judge?: { rubric?: unknown; on?: unknown; budget_usd?: unknown } | unknown
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')

/**
 * A canonical string for comparing two end conditions. What is compared is what
 * GRADES a run: the assert expressions (as a set, whitespace-insensitive) and
 * the judge's rubric, target and budget. An assert's `why` is explanation only
 * and is ignored, so rewording it is not a contract change.
 */
export function endConditionKey(ec: unknown): string {
  if (!ec || typeof ec !== 'object' || Array.isArray(ec)) return 'none'
  const e = ec as EndConditionLike
  const asserts = Array.isArray(e.assert) ? e.assert.map((a) => norm((a as { expr?: unknown } | null)?.expr)).filter(Boolean) : []
  const j = e.judge && typeof e.judge === 'object' && !Array.isArray(e.judge) ? (e.judge as { rubric?: unknown; on?: unknown; budget_usd?: unknown }) : null
  return JSON.stringify({
    assert: [...new Set(asserts)].sort(),
    judge: j ? { rubric: norm(j.rubric), on: norm(j.on), budget_usd: typeof j.budget_usd === 'number' ? j.budget_usd : null } : null,
  })
}

export function sameEndCondition(a: unknown, b: unknown): boolean {
  return endConditionKey(a) === endConditionKey(b)
}

/**
 * Drafts written by an AGENT, whose end condition a person has not vouched for:
 * a builder card session (`agent:<card>`), an agent API key (`agent_key:<id>`),
 * a chat bot's Full access draft (`bot:<slug>`) or the repair watcher
 * (`repair:<run>`). A person's own draft (`user:<id>`) is their own words.
 */
export function isAgentWrittenAuthor(author: string | null | undefined): boolean {
  const a = author ?? ''
  return a.startsWith('agent:') || a.startsWith('agent_key:') || a.startsWith('bot:') || a.startsWith('repair:')
}

/** The pinned contract of one workflow, as the API reports it. */
export interface FlowEndConditionContract {
  /** The person's own words for "done" (optional). */
  done_when: string | null
  /** The machine-checkable end condition that is pinned, or null when none is yet. */
  end_condition: unknown | null
  /** `user:<id>` when a person gave or confirmed it; null when an agent gave it and nobody has confirmed it yet. */
  confirmed_by: string | null
  confirmed_at: string | null
}

export type EndConditionCheck =
  | { status: 'confirmed' }
  /** No person has vouched for this version's end condition: publish needs an explicit confirm. */
  | { status: 'needs_confirmation'; reason: 'proposed_by_agent' | 'differs_from_confirmed' }

/**
 * Does publishing this version need the person to confirm its end condition?
 * A version a person wrote themselves is their own words: confirmed. A version an
 * agent wrote is confirmed only when its end condition equals a contract a
 * person gave or confirmed; otherwise the publisher must confirm it explicitly.
 */
export function checkEndConditionContract(args: {
  versionEndCondition: unknown
  versionAuthor: string | null | undefined
  contract: Pick<FlowEndConditionContract, 'end_condition' | 'confirmed_by'> | null
}): EndConditionCheck {
  if (!isAgentWrittenAuthor(args.versionAuthor)) return { status: 'confirmed' }
  const pinned = args.contract?.end_condition ?? null
  const pinnedByPerson = pinned != null && !!args.contract?.confirmed_by
  if (pinnedByPerson && sameEndCondition(args.versionEndCondition, pinned)) return { status: 'confirmed' }
  return { status: 'needs_confirmation', reason: pinnedByPerson ? 'differs_from_confirmed' : 'proposed_by_agent' }
}
