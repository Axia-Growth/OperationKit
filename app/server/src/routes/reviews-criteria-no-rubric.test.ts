/**
 * obj 901460 — GET /api/internal/reviews/:id/criteria over the REAL router and a real
 * migrated DB: a card with no locked rubric gets one derived + locked, or a stated
 * `reason`. The bare `{criteria: null}` that stranded #901330 (PR 871) is gone.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-reviews-no-rubric-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

const { initDb, getDb } = await import('../db/index.js')
const { internalReviewsRouter } = await import('./reviews.js')

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = express()
  app.use(express.json())
  app.use('/api/internal/reviews', internalReviewsRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
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

beforeEach(() => { getDb().prepare('DELETE FROM objectives').run() })

function insert(id: number, title: string, description: string, criteria: string | null = null) {
  getDb().prepare(
    `INSERT INTO objectives (id, title, description, status, workspace, acceptance_criteria, ai_review_iteration)
     VALUES (?, ?, ?, 'review', 'operationkit', ?, 2)`,
  ).run(id, title, description, criteria)
}
const stored = (id: number) =>
  (getDb().prepare('SELECT acceptance_criteria FROM objectives WHERE id = ?').get(id) as { acceptance_criteria: string | null }).acceptance_criteria

describe('GET /api/internal/reviews/:id/criteria — no locked rubric', () => {
  it('derives a rubric from the card text, locks it, and says so (rubric_source=derived)', async () => {
    insert(901330, 'Bot chat: show seat moves as one plain line in the thread',
      'Change: when a turn moves seats, post one line naming the seat labels.\nDone: a test shows the line and no secret.')
    const res = await fetch(`${baseUrl}/api/internal/reviews/901330/criteria`)
    expect(res.status).toBe(200)
    const body = await res.json() as { criteria: Array<{ id: string }> | null; rubric_source: string }
    expect(body.rubric_source).toBe('derived')
    expect(body.criteria!.length).toBeGreaterThanOrEqual(3)
    expect(JSON.parse(stored(901330)!).map((c: { id: string }) => c.id)).toEqual(body.criteria!.map((c) => c.id))

    // Iteration 3 reads the SAME lock.
    const again = await (await fetch(`${baseUrl}/api/internal/reviews/901330/criteria`)).json() as { criteria: unknown; rubric_source: string }
    expect(again.rubric_source).toBe('locked')
    expect(again.criteria).toEqual(body.criteria)
  })

  it('a card too thin to grade answers criteria:null WITH a reason — never a silent null', async () => {
    insert(7, 'Fix', '')
    const body = await (await fetch(`${baseUrl}/api/internal/reviews/7/criteria`)).json() as { criteria: unknown; reason?: string; rubric_source: string }
    expect(body.criteria).toBeNull()
    expect(body.rubric_source).toBe('none')
    expect(body.reason).toMatch(/none could be derived/)
    expect(stored(7)).toBeNull()
  })

  it('an already-locked rubric is returned as-is (rubric_source=locked)', async () => {
    insert(8, 'Some card title here', 'Change: x', '[{"id":"mine","criterion":"bar","type":"functional","method":"api"}]')
    const body = await (await fetch(`${baseUrl}/api/internal/reviews/8/criteria`)).json() as { criteria: Array<{ id: string }>; rubric_source: string }
    expect(body.rubric_source).toBe('locked')
    expect(body.criteria.map((c) => c.id)).toEqual(['mine'])
  })

  it('404 for an unknown objective', async () => {
    expect((await fetch(`${baseUrl}/api/internal/reviews/424242/criteria`)).status).toBe(404)
  })
})

describe('POST /api/internal/reviews/:id/criteria — empty is not a lock', () => {
  const crit = [{ id: 'a', criterion: 'it works', type: 'functional', method: 'api' }]
  const post = (id: number, criteria: unknown) => fetch(`${baseUrl}/api/internal/reviews/${id}/criteria`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ criteria }),
  })

  it('refuses an empty rubric (400)', async () => {
    insert(10, 'Some card title here', '')
    expect((await post(10, [])).status).toBe(400)
    expect(stored(10)).toBeNull()
  })

  it('a stored "[]" can be replaced by a real rubric (201), then the lock holds (409)', async () => {
    insert(11, 'Some card title here', '', '[]')
    expect((await post(11, crit)).status).toBe(201)
    expect(JSON.parse(stored(11)!)).toEqual(crit)
    const second = await post(11, [{ ...crit[0], id: 'b' }])
    expect(second.status).toBe(409)
    expect(((await second.json()) as { criteria: Array<{ id: string }> }).criteria.map((c) => c.id)).toEqual(['a'])
  })
})
