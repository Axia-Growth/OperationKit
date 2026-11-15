import { describe, it, expect, vi } from 'vitest'
import { TRIAGE_MAX_BATCH, type TriageBatchRequest, type TriageBatchResponse } from '@operationkit/shared'
import { chunkIds, mergeBatchResults, pruneSelection, runTriage, toggleSelection } from './triage'

// obj 900869 — Needs You bulk triage, pure client logic.

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

function fakeResponse(body: TriageBatchRequest, batchId: number): TriageBatchResponse {
  return {
    batch_id: batchId,
    action: body.action,
    requested: body.objective_ids.length,
    ok: body.objective_ids.length - 1,
    skipped: 1,
    failed: 0,
    items: body.objective_ids.map((id, i) => ({
      objective_id: id, title: `card ${id}`, result: i === 0 ? 'skipped' : 'ok',
      from_status: 'review', to_status: i === 0 ? null : 'done', error: i === 0 ? 'Not in Needs You' : undefined,
    })),
  }
}

describe('chunkIds', () => {
  it('splits ~405 cards into server-sized batches, keeping order', () => {
    const chunks = chunkIds(ids(405))
    expect(chunks.map(c => c.length)).toEqual([100, 100, 100, 100, 5])
    expect(chunks.flat()).toEqual(ids(405))
    expect(TRIAGE_MAX_BATCH).toBe(100)
  })
  it('returns no chunks for an empty selection', () => {
    expect(chunkIds([])).toEqual([])
  })
})

describe('toggleSelection', () => {
  const order = [10, 20, 30, 40, 50]
  it('toggles one id on and off', () => {
    const a = toggleSelection(new Set(), 20)
    expect([...a]).toEqual([20])
    expect([...toggleSelection(a, 20)]).toEqual([])
  })
  it('shift-click selects the whole range between the anchor and the click, either direction', () => {
    expect([...toggleSelection(new Set([20]), 40, { range: true, anchor: 20, order })].sort()).toEqual([20, 30, 40])
    expect([...toggleSelection(new Set(), 10, { range: true, anchor: 50, order })].sort()).toEqual([10, 20, 30, 40, 50])
  })
  it('falls back to a plain toggle when the anchor is no longer in the column', () => {
    expect([...toggleSelection(new Set(), 30, { range: true, anchor: 99, order })]).toEqual([30])
  })
})

describe('pruneSelection', () => {
  it('drops cards that left Needs You while selected', () => {
    expect([...pruneSelection(new Set([1, 2, 3]), [2, 3, 4])]).toEqual([2, 3])
  })
})

describe('runTriage', () => {
  it('sends one audited batch per chunk and merges the outcome', async () => {
    let n = 0
    const post = vi.fn(async (body: TriageBatchRequest) => fakeResponse(body, ++n))
    const progress: number[] = []
    const { result, error } = await runTriage(post, { action: 'approve', objective_ids: ids(250) }, d => progress.push(d))
    expect(error).toBeNull()
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls.map(c => c[0].objective_ids.length)).toEqual([100, 100, 50])
    expect(post.mock.calls.every(c => c[0].action === 'approve')).toBe(true)
    expect(progress).toEqual([100, 200, 250])
    expect(result).toMatchObject({ action: 'approve', batch_ids: [1, 2, 3], requested: 250, ok: 247, skipped: 3, failed: 0 })
    expect(result.items).toHaveLength(250)
  })

  it('passes reassign targets through to every chunk', async () => {
    const post = vi.fn(async (body: TriageBatchRequest) => fakeResponse(body, 1))
    await runTriage(post, { action: 'reassign', objective_ids: ids(3), assigned_user_ids: [7], owner_bot: null, note: 'clean-up' })
    expect(post.mock.calls[0][0]).toEqual({ action: 'reassign', objective_ids: [1, 2, 3], assigned_user_ids: [7], owner_bot: null, note: 'clean-up' })
  })

  it('stops at the first failing chunk and reports what already ran', async () => {
    let n = 0
    const post = vi.fn(async (body: TriageBatchRequest) => {
      if (++n === 2) throw new Error('HTTP 500')
      return fakeResponse(body, n)
    })
    const { result, error } = await runTriage(post, { action: 'dismiss', objective_ids: ids(300) })
    expect(error).toBe('HTTP 500')
    expect(post).toHaveBeenCalledTimes(2) // the third chunk is never sent
    expect(result.requested).toBe(100)
    expect(result.batch_ids).toEqual([1])
  })
})

describe('mergeBatchResults', () => {
  it('is empty-safe', () => {
    expect(mergeBatchResults('approve', [])).toMatchObject({ requested: 0, ok: 0, skipped: 0, failed: 0, items: [] })
  })
})
