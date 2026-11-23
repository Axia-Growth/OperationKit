/**
 * One status for a card's WHOLE tree (obj 901519).
 *
 * A card that handed work to children is not finished until every card below
 * it is finished, and a part that failed must read as failed, never as
 * settled. The board keeps one status per card; this rolls a card and all of
 * its descendants up into one value plus the counts and one plain sentence.
 *
 * It is DERIVED and read-only: nothing here gates a status change. A parent
 * can still be closed while children run; this is what makes that visible.
 */

/** The fields the roll-up reads from each card in the tree. */
export interface TreeNode {
  id: number
  status: string
  session_id?: string | null
  ai_review_verdict?: string | null
  /** `needs_secret` as stored (JSON text) or as parsed (a list); empty = nothing pending. */
  needs_secret?: unknown
  /** The card has an open (unanswered) decision. */
  open_decision?: boolean | number | null
}

/**
 *  - `failed`     a part failed its review (or was closed after failing it)
 *  - `needs_you`  nothing failed, but a part is waiting on a person
 *  - `running`    parts are still open and none of them needs a person
 *  - `incomplete` everything has ended, but some parts were cancelled
 *  - `finished`   the card and every part below it are done
 */
export type TreeState = 'failed' | 'needs_you' | 'running' | 'incomplete' | 'finished'

export interface TreeStatus {
  state: TreeState
  /** True only when the card AND every descendant has ended (done or cancelled). */
  settled: boolean
  /** The card's own status says done/cancelled while parts below it are still open. */
  closed_early: boolean
  /** Cards below this one (the card itself is not counted). */
  descendants: number
  open: number
  done: number
  cancelled: number
  failed: number
  needs_you: number
  /** Up to TREE_ID_LIMIT ids each, lowest first. */
  open_ids: number[]
  failed_ids: number[]
  needs_you_ids: number[]
  cancelled_ids: number[]
  /** One plain sentence a person can read without the counts. */
  reason: string
}

export const TREE_ID_LIMIT = 20

const ENDED = new Set(['done', 'cancelled'])
const FAILED_VERDICTS = new Set(['fail', 'blocked'])

export function treeNodeEnded(n: Pick<TreeNode, 'status'>): boolean {
  return ENDED.has(n.status)
}

/** A part that failed: its AI review failed or was blocked and it did not go on to done. */
export function treeNodeFailed(n: Pick<TreeNode, 'status' | 'ai_review_verdict'>): boolean {
  return n.status !== 'done' && FAILED_VERDICTS.has(String(n.ai_review_verdict ?? ''))
}

function secretPending(raw: TreeNode['needs_secret']): boolean {
  if (!raw) return false
  if (Array.isArray(raw)) return raw.length > 0
  const s = String(raw).trim()
  return s !== '' && s !== '[]' && s !== 'null'
}

/** An open part that waits on a person: parked in review with no agent on it,
 *  an unanswered decision, or a secret only the person can supply. */
export function treeNodeNeedsYou(n: TreeNode): boolean {
  if (treeNodeEnded(n)) return false
  if (n.status === 'review' && !n.session_id) return true
  return !!n.open_decision || secretPending(n.needs_secret)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const ids = (list: number[], total: number) =>
  list.map(i => `#${i}`).join(', ') + (total > list.length ? ` and ${total - list.length} more` : '')

/**
 * Roll a card and everything below it up into one status. `descendants` is
 * every card under `self` at any depth (not `self`).
 */
export function rollUpTree(self: TreeNode, descendants: readonly TreeNode[]): TreeStatus {
  const sorted = [...descendants].sort((a, b) => a.id - b.id)
  const open = sorted.filter(n => !treeNodeEnded(n))
  const failed = sorted.filter(treeNodeFailed)
  const needsYou = sorted.filter(treeNodeNeedsYou)
  const cancelled = sorted.filter(n => n.status === 'cancelled')
  const done = sorted.filter(n => n.status === 'done').length
  const selfEnded = treeNodeEnded(self)
  const settled = selfEnded && open.length === 0
  const closedEarly = selfEnded && open.length > 0

  const cut = (list: TreeNode[]) => list.slice(0, TREE_ID_LIMIT).map(n => n.id)
  const openIds = cut(open), failedIds = cut(failed), needsYouIds = cut(needsYou), cancelledIds = cut(cancelled)

  let state: TreeState
  if (failed.length > 0) state = 'failed'
  else if (needsYou.length > 0 || (!selfEnded && treeNodeNeedsYou(self))) state = 'needs_you'
  else if (!settled) state = 'running'
  else if (cancelled.length > 0 || self.status === 'cancelled') state = 'incomplete'
  else state = 'finished'

  const parts: string[] = []
  if (closedEarly) parts.push(`This card is marked ${self.status}, but ${plural(open.length, 'part')} below it ${open.length === 1 ? 'is' : 'are'} still open (${ids(openIds, open.length)})`)
  if (failed.length > 0) parts.push(`${plural(failed.length, 'part')} failed review (${ids(failedIds, failed.length)})`)
  if (needsYou.length > 0) parts.push(`${plural(needsYou.length, 'part')} ${needsYou.length === 1 ? 'is' : 'are'} waiting on you (${ids(needsYouIds, needsYou.length)})`)
  if (!closedEarly && open.length > 0) parts.push(`${plural(open.length, 'part')} still open (${ids(openIds, open.length)})`)
  if (cancelled.length > 0) parts.push(`${plural(cancelled.length, 'part')} ${cancelled.length === 1 ? 'was' : 'were'} cancelled (${ids(cancelledIds, cancelled.length)})`)
  if (parts.length === 0) {
    parts.push(settled
      ? (sorted.length === 0 ? 'This card has ended and has no parts below it' : `This card and all ${plural(sorted.length, 'part')} below it are done`)
      : (sorted.length === 0 ? 'This card is still open' : `Every part below this card is done (${sorted.length}); the card itself is still open`))
  }

  return {
    state,
    settled,
    closed_early: closedEarly,
    descendants: sorted.length,
    open: open.length,
    done,
    cancelled: cancelled.length,
    failed: failed.length,
    needs_you: needsYou.length,
    open_ids: openIds,
    failed_ids: failedIds,
    needs_you_ids: needsYouIds,
    cancelled_ids: cancelledIds,
    reason: `${parts.join('. ')}.`,
  }
}
