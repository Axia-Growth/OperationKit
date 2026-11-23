import { describe, it, expect } from 'vitest'
import { rollUpTree, TREE_ID_LIMIT, type TreeNode } from './tree-status'

const n = (id: number, status: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, status, session_id: null, ...extra })
const parent = (status: string, extra: Partial<TreeNode> = {}) => n(1, status, { session_id: 'cc-1', ...extra })

describe('rollUpTree: one status for a card and everything below it (obj 901519)', () => {
  it('is not finished while any part at any depth is still open', () => {
    const t = rollUpTree(parent('working'), [n(2, 'done'), n(3, 'done'), n(4, 'working', { session_id: 'cc-4' })])
    expect(t).toMatchObject({ state: 'running', settled: false, closed_early: false, descendants: 3, open: 1, done: 2, open_ids: [4] })
    expect(t.reason).toBe('1 part still open (#4).')
  })

  it('a parent marked done over open parts is NOT settled, and says so', () => {
    const t = rollUpTree(parent('done'), [n(2, 'done'), n(3, 'queue'), n(4, 'working', { session_id: 'cc-4' })])
    expect(t).toMatchObject({ state: 'running', settled: false, closed_early: true, open: 2 })
    expect(t.reason).toBe('This card is marked done, but 2 parts below it are still open (#3, #4).')
  })

  it('a failed part shows as failed, never as settled or finished', () => {
    // Failed review and still parked: open AND failed.
    const parked = rollUpTree(parent('working'), [n(2, 'done'), n(3, 'review', { ai_review_verdict: 'fail' })])
    expect(parked).toMatchObject({ state: 'failed', settled: false, failed: 1, failed_ids: [3], needs_you: 1 })
    expect(parked.reason).toContain('1 part failed review (#3)')
    // Failed review and then closed: everything has ended, and it is still failed.
    const closed = rollUpTree(parent('done'), [n(2, 'done'), n(3, 'cancelled', { ai_review_verdict: 'fail' })])
    expect(closed).toMatchObject({ state: 'failed', settled: true, failed: 1, cancelled: 1 })
    // A blocked review counts the same way.
    expect(rollUpTree(parent('done'), [n(2, 'cancelled', { ai_review_verdict: 'blocked' })]).state).toBe('failed')
    // A part that failed a review and was then fixed and finished is not failed.
    expect(rollUpTree(parent('done'), [n(2, 'done', { ai_review_verdict: 'fail' })]).state).toBe('finished')
  })

  it('needs_you: a part parked on a person is told apart from one that is running', () => {
    const review = rollUpTree(parent('working'), [n(2, 'review'), n(3, 'working', { session_id: 'cc-3' })])
    expect(review).toMatchObject({ state: 'needs_you', needs_you: 1, needs_you_ids: [2], open: 2 })
    expect(review.reason).toContain('1 part is waiting on you (#2)')
    expect(rollUpTree(parent('working'), [n(2, 'working', { session_id: 'cc-2', open_decision: 1 })]).state).toBe('needs_you')
    expect(rollUpTree(parent('working'), [n(2, 'working', { needs_secret: '[{"name":"ACME_KEY"}]' })]).state).toBe('needs_you')
    expect(rollUpTree(parent('working'), [n(2, 'working', { needs_secret: '[]' })]).state).toBe('running')
    expect(rollUpTree(parent('working'), [n(2, 'working', { needs_secret: [{ name: 'ACME_KEY' }] })]).state).toBe('needs_you')
    expect(rollUpTree(parent('working'), [n(2, 'working', { needs_secret: [] })]).state).toBe('running')
    // A review-stage part with an agent still on it is running, not waiting on a person.
    expect(rollUpTree(parent('working'), [n(2, 'review', { session_id: 'cc-review-2' })]).state).toBe('running')
    // The card itself waiting on a person counts too.
    expect(rollUpTree(n(1, 'review'), [n(2, 'done')]).state).toBe('needs_you')
  })

  it('incomplete: everything ended, but parts were cancelled', () => {
    const t = rollUpTree(parent('done'), [n(2, 'done'), n(3, 'cancelled')])
    expect(t).toMatchObject({ state: 'incomplete', settled: true, cancelled: 1, cancelled_ids: [3], failed: 0 })
    expect(t.reason).toBe('1 part was cancelled (#3).')
    expect(rollUpTree(parent('cancelled'), [n(2, 'done')]).state).toBe('incomplete')
  })

  it('finished only when the card and every part are done', () => {
    const t = rollUpTree(parent('done'), [n(2, 'done'), n(3, 'done')])
    expect(t).toMatchObject({ state: 'finished', settled: true, open: 0, done: 2 })
    expect(t.reason).toBe('This card and all 2 parts below it are done.')
    // Every part done but the card itself still open: not settled.
    const open = rollUpTree(parent('working'), [n(2, 'done')])
    expect(open).toMatchObject({ state: 'running', settled: false })
    expect(open.reason).toBe('Every part below this card is done (1); the card itself is still open.')
  })

  it('a card with no parts is just its own status', () => {
    expect(rollUpTree(parent('done'), [])).toMatchObject({ state: 'finished', settled: true, descendants: 0 })
    expect(rollUpTree(parent('working'), [])).toMatchObject({ state: 'running', settled: false })
  })

  it('caps the id lists and says how many more there are', () => {
    const many = Array.from({ length: TREE_ID_LIMIT + 7 }, (_, i) => n(100 + i, 'queue'))
    const t = rollUpTree(parent('working'), many)
    expect(t.open).toBe(TREE_ID_LIMIT + 7)
    expect(t.open_ids).toHaveLength(TREE_ID_LIMIT)
    expect(t.reason).toContain('and 7 more')
  })
})
