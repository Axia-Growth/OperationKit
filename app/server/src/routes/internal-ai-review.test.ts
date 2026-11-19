/**
 * obj 901381 — `POST /api/internal/ai-review/request` asks for an AI review on a
 * card already sitting in `review` with a linked PR and no verdict, without
 * re-running the work session. Run over the REAL express router and a real
 * migrated DB; only the reviewer spawn and the GitHub PR-state read are injected.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-ai-review-backfill-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

// The module graph reaches the spawn stack; no PTY is ever opened here.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

const { initDb, getDb } = await import('../db/index.js')
const { createAiReviewRouter, MAX_REVIEWS_PER_REQUEST } = await import('./internal-ai-review.js')
const { getInternalApiSecret } = await import('../middleware/internal-secret.js')
const { findStrandedPrReviews } = await import('../services/ai-review-backfill.js')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const spawnReviewer = vi.fn(async (o: Loose) => `reviewer-${o.id}-${o.ai_review_iteration}`)
const stopSession = vi.fn(async () => {})
const prStates = new Map<number, string | null>()
const prState = vi.fn(async (o: Loose) => (prStates.has(o.id) ? prStates.get(o.id)! : 'OPEN'))

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = express()
  app.use(express.json())
  app.use('/api/internal/ai-review', createAiReviewRouter(() => ({ spawnReviewer, stopSession, prState })))
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address()
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      resolve()
    })
  })
})

afterAll(() => {
  try { server?.close() } catch { /* ignore */ }
  try { getDb().close() } catch { /* ignore */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  spawnReviewer.mockClear()
  stopSession.mockClear()
  prState.mockClear()
  prStates.clear()
})

function card(over: Record<string, unknown> = {}): number {
  const f = {
    title: 'stranded', workspace: 'operationkit', status: 'review', type: 'task', origin: 'agent_chat',
    create_pr: 0, pr_number: 881, pr_url: 'https://github.com/your-org/operationkit/pull/881',
    ai_review_verdict: null, ai_review_iteration: 0, session_id: 'worker-sess', ...over,
  } as Record<string, unknown>
  const cols = Object.keys(f)
  const r = getDb()
    .prepare(`INSERT INTO objectives (${cols.join(', ')}, description, category) VALUES (${cols.map(() => '?').join(', ')}, '', 'general')`)
    .run(...cols.map((c) => f[c] as never))
  return Number(r.lastInsertRowid)
}
const row = (id: number) => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Loose

async function post(body: unknown, secret: string | null = getInternalApiSecret()) {
  const res = await fetch(`${baseUrl}/api/internal/ai-review/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Internal-Secret': secret } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Loose }
}

describe('POST /api/internal/ai-review/request', () => {
  it('needs X-Internal-Secret', async () => {
    const id = card()
    const r = await post({ ids: [id] }, null)
    expect(r.status).toBe(401)
    expect(spawnReviewer).not.toHaveBeenCalled()
    expect(row(id).status).toBe('review')
  })

  it('spawns a reviewer for a card in review with a PR and no verdict — and never re-runs the worker', async () => {
    const id = card()
    const r = await post({ ids: [id] })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ dry_run: false, requested: 1, refused: 0 })
    expect(spawnReviewer).toHaveBeenCalledTimes(1)
    // The reviewer sees the bumped iteration (rubric generation on iteration 1).
    expect(spawnReviewer.mock.calls[0][0]).toMatchObject({ id, ai_review_iteration: 1 })
    const after = row(id)
    expect(after).toMatchObject({
      status: 'ai_review',
      ai_review_session_id: `reviewer-${id}-1`,
      ai_review_iteration: 1,
      ai_review_verdict: null,
      // worker untouched: same session id, no new session started
      session_id: 'worker-sess',
    })
    const log = getDb().prepare(`SELECT title, metadata FROM activity_log WHERE objective_id = ?`).all(id) as Loose[]
    expect(log.map((l) => l.title)).toContain('ai_review_requested')
  })

  it('dry_run reports what would happen and writes nothing', async () => {
    const id = card()
    const r = await post({ ids: [id], dry_run: true })
    expect(r.json).toMatchObject({ dry_run: true, requested: 1 })
    expect(r.json.results[0]).toMatchObject({ id, ok: true, dry_run: true, iteration: 1, reviewer_session_id: null })
    expect(spawnReviewer).not.toHaveBeenCalled()
    expect(row(id)).toMatchObject({ status: 'review', ai_review_iteration: 0, ai_review_session_id: null })
  })

  it('with no ids it takes every stranded card in the workspace, and only those', async () => {
    const a = card({ title: 'a' })
    const b = card({ title: 'b', pr_number: null, pr_url: 'https://github.com/your-org/operationkit/pull/882' })
    card({ title: 'other workspace', workspace: 'elsewhere' })
    card({ title: 'has verdict', ai_review_verdict: 'pass' })
    card({ title: 'no pr', pr_number: null, pr_url: null })
    card({ title: 'working', status: 'working' })
    card({ title: 'done', status: 'done' })
    card({ title: 'routine', routine_id: 7 })
    card({ title: 'delegator', delegate_mode: 1 })
    card({ title: 'skip', skip_ai_review: 1 })
    card({ title: 'deleted', deleted_at: '2026-11-17 00:00:00' })
    expect(findStrandedPrReviews(getDb(), { workspace: 'operationkit' }).map((r) => r.id)).toEqual([a, b])
    const r = await post({ workspace: 'operationkit' })
    expect(r.json.requested).toBe(2)
    expect(row(a).status).toBe('ai_review')
    expect(row(b).status).toBe('ai_review')
    expect(spawnReviewer).toHaveBeenCalledTimes(2)
  })

  it('refuses each ineligible card by name with a code, and touches none of them', async () => {
    const verdict = card({ ai_review_verdict: 'fail' })
    const noPr = card({ pr_number: null, pr_url: null })
    const working = card({ status: 'working' })
    const merged = card()
    prStates.set(merged, 'MERGED')
    const r = await post({ ids: [verdict, noPr, working, merged, 999999] })
    const codes = Object.fromEntries(r.json.results.map((x: Loose) => [x.id, x.code]))
    expect(codes).toEqual({ [verdict]: 'has_verdict', [noPr]: 'no_pr', [working]: 'not_in_review', [merged]: 'pr_not_open', 999999: 'not_found' })
    expect(spawnReviewer).not.toHaveBeenCalled()
    expect(row(working).status).toBe('working')
    expect(row(merged).status).toBe('review')
  })

  it('an unreadable PR state still proceeds (the reviewer reads the PR itself)', async () => {
    const id = card()
    prStates.set(id, null)
    const r = await post({ ids: [id] })
    expect(r.json.requested).toBe(1)
  })

  it('a card moved while the reviewer spawned is left alone and the stray reviewer is stopped', async () => {
    const id = card()
    spawnReviewer.mockImplementationOnce(async (o: Loose) => {
      getDb().prepare(`UPDATE objectives SET status = 'done' WHERE id = ?`).run(o.id)
      return 'stray-reviewer'
    })
    const r = await post({ ids: [id] })
    expect(r.json.results[0]).toMatchObject({ ok: false, code: 'raced' })
    expect(stopSession).toHaveBeenCalledWith('stray-reviewer')
    expect(row(id).status).toBe('done')
  })

  it('a spawn failure leaves the card in review', async () => {
    const id = card()
    spawnReviewer.mockRejectedValueOnce(new Error('no account'))
    const r = await post({ ids: [id] })
    expect(r.json.results[0]).toMatchObject({ ok: false, code: 'spawn_failed', detail: 'no account' })
    expect(row(id)).toMatchObject({ status: 'review', ai_review_iteration: 0 })
  })

  it('caps one request at MAX_REVIEWS_PER_REQUEST cards and validates ids', async () => {
    const ids = Array.from({ length: MAX_REVIEWS_PER_REQUEST + 1 }, (_, i) => card({ title: `c${i}` }))
    const r = await post({ workspace: 'operationkit' })
    expect(r.status).toBe(400)
    expect(r.json.matched_ids).toEqual(ids)
    expect(spawnReviewer).not.toHaveBeenCalled()
    expect((await post({ ids: [] })).status).toBe(400)
    expect((await post({ ids: ['1'] })).status).toBe(400)
  })
})

describe('GET /api/internal/ai-review/stranded', () => {
  it('lists the stranded cards, read-only', async () => {
    const id = card()
    card({ ai_review_verdict: 'pass' })
    const res = await fetch(`${baseUrl}/api/internal/ai-review/stranded?workspace=operationkit`, { headers: { 'X-Internal-Secret': getInternalApiSecret() } })
    const json = (await res.json()) as Loose
    expect(json.count).toBe(1)
    expect(json.objectives[0].id).toBe(id)
    expect(row(id).status).toBe('review')
  })
})
