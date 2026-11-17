import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 901228 — every path that closes a parent (done / cancelled) retires its
// never-ran queued children through the ONE helper
// (cleanupOrphanedChildrenOnParentTerminal), with its orphan-cleanup audit row.
// The PATCH routes always did; the MACHINE closes (poller reviewer PASS /
// worker-end apply / cap-out through runMachineStatusUpdate, the hygiene
// hard-expiry and auto-accept, flow-repair) did not — that is how the High
// Agency `[Review]` children (#901079 under done #900956, …) stranded with
// updated_at = created_at. Review stays a park, not a kill. Driven over the real
// routers and DB; only the tmux layer is mocked.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-close-orphans-')))
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-close-paths'
delete process.env.CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL
delete process.env.INTERNAL_TRUSTED_PEER_CIDRS

vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    startSession: async (o: { id: number }) => `cc-${o.id}-worker`,
    stopSession: async () => {},
    stopPlannerSession: async () => {},
  }
})

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { registerInternalHermesRoutes } = await import('./internal-hermes.js')
const { internalApiGate } = await import('../middleware/internal-api-gate.js')
const { runMachineStatusUpdate, onMachineTerminal } = await import('../lib/status-lock.js')
const { buildHygieneDigest } = await import('../services/poller-hygiene.js')

const ADMIN_ID = 1
const WS = 'close-orphans-ws'
const PATHWAY = 'orphan-child-cleanup-on-parent-terminal'

let server: http.Server
let baseUrl: string

function cookie(): string {
  return `token=${jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}

async function call(method: string, url: string, body: unknown, internal: boolean) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(internal ? {} : { Cookie: cookie() }) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, any> }
}

function insertCard(fields: Record<string, unknown>): number {
  const row = { workspace: WS, agent_context: 'general', description: '', ...fields }
  const cols = Object.keys(row)
  return Number(
    getDb()
      .prepare(`INSERT INTO objectives (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...Object.values(row)).lastInsertRowid,
  )
}

const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const auditFor = (id: number) =>
  getDb().prepare('SELECT from_status, to_status, pathway FROM objective_audit WHERE objective_id = ? AND pathway = ?').all(id, PATHWAY)

/** A parent in `parentStatus` with the four child shapes the guards care about. */
function family(parentStatus = 'review', grandparent: number | null = null) {
  const parent = insertCard({ title: 'parent', status: parentStatus, parent_id: grandparent })
  return {
    parent,
    // the stranded shape: never ran, still queued (e.g. a legacy `[Review]` child)
    neverRan: insertCard({ title: '[Review] parent', status: 'queue', parent_id: parent, session_count: 0, workflow_hint: 'adversarial' }),
    ran: insertCard({ title: 'ran once', status: 'queue', parent_id: parent, session_count: 1 }),
    working: insertCard({ title: 'working kid', status: 'working', parent_id: parent, session_count: 0 }),
    reviewKid: insertCard({ title: 'review kid', status: 'review', parent_id: parent, session_count: 0 }),
    stranger: insertCard({ title: 'unrelated queue', status: 'queue', session_count: 0 }),
  }
}

/** Criterion 3 + 4: only the never-ran queued child is retired, with its audit. */
function expectRetired(f: ReturnType<typeof family>) {
  expect(statusOf(f.neverRan)).toBe('cancelled')
  expect(auditFor(f.neverRan)).toEqual([{ from_status: 'queue', to_status: 'cancelled', pathway: PATHWAY }])
  expectUntouchedExceptNeverRan(f)
}
function expectUntouchedExceptNeverRan(f: ReturnType<typeof family>) {
  expect(statusOf(f.ran)).toBe('queue')
  expect(statusOf(f.working)).toBe('working')
  expect(statusOf(f.reviewKid)).toBe('review')
  expect(statusOf(f.stranger)).toBe('queue')
  for (const id of [f.ran, f.working, f.reviewKid, f.stranger]) expect(auditFor(id)).toEqual([])
}
function expectNothingRetired(f: ReturnType<typeof family>) {
  expect(statusOf(f.neverRan)).toBe('queue')
  expect(auditFor(f.neverRan)).toEqual([])
  expectUntouchedExceptNeverRan(f)
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(WS, WS)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/internal', internalApiGate)
  const internal = express.Router()
  registerInternalHermesRoutes(internal)
  app.use('/api/internal', internal)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
})

describe.each([
  ['PATCH /api/objectives/:id/status (cookie / agent key / bot approval → runStatusChange)', false],
  ['PATCH /api/internal/objectives/:id/status (internal)', true],
] as const)('%s', (_label, internal) => {
  const url = (id: number) => (internal ? `/api/internal/objectives/${id}/status` : `/api/objectives/${id}/status`)

  it.each(['done', 'cancelled'] as const)('parent → %s retires its never-ran queued child, touches nothing else', async status => {
    // A delegator's worker child, so the internal PATCH may close it (a top-level
    // card's internal auto-done is redirected to review — covered below).
    const f = family('review', insertCard({ title: 'delegator', status: 'working' }))
    const r = await call('PATCH', url(f.parent), { status }, internal)
    expect(r.status).toBe(200)
    expect(statusOf(f.parent)).toBe(status)
    expectRetired(f)
  })

  it('parent → review is a park, not a kill', async () => {
    const f = family('working')
    const r = await call('PATCH', url(f.parent), { status: 'review' }, internal)
    expect(r.status).toBe(200)
    expect(statusOf(f.parent)).toBe('review')
    expectNothingRetired(f)
  })
})

describe('internal auto-done on a top-level card is redirected to review', () => {
  it('the redirect lands in review and cancels no children', async () => {
    const f = family('working')
    const r = await call('PATCH', `/api/internal/objectives/${f.parent}/status`, { status: 'done' }, true)
    expect(r.status).toBe(200)
    expect(r.json.redirected).toBe(true)
    expect(statusOf(f.parent)).toBe('review')
    expectNothingRetired(f)
  })
})

describe('machine closes through runMachineStatusUpdate (poller: reviewer PASS, worker-end apply, cap-out) — the path that skipped cleanup', () => {
  it('reviewer PASS → done (bound status) retires the never-ran child', () => {
    const f = family('review')
    const r = runMachineStatusUpdate(
      getDb(),
      "UPDATE objectives SET status = ?, ai_review_verdict = 'pass', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
      'done',
      'looks good',
      f.parent,
    )
    expect(r.changes).toBe(1)
    expect(statusOf(f.parent)).toBe('done')
    expectRetired(f)
  })

  it('literal → cancelled retires the never-ran child', () => {
    const f = family('working')
    runMachineStatusUpdate(getDb(), "UPDATE objectives SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", f.parent)
    expect(statusOf(f.parent)).toBe('cancelled')
    expectRetired(f)
  })

  it('→ review does not cancel children', () => {
    const f = family('working')
    runMachineStatusUpdate(getDb(), "UPDATE objectives SET status = ?, updated_at = datetime('now') WHERE id = ?", 'review', f.parent)
    expect(statusOf(f.parent)).toBe('review')
    expectNothingRetired(f)
  })

  it('a refused write on an already-done parent (no transition) cancels nothing', () => {
    const f = family('done')
    const r = runMachineStatusUpdate(getDb(), "UPDATE objectives SET status = ?, updated_at = datetime('now') WHERE id = ?", 'done', f.parent)
    expect(r.changes).toBe(0)
    expectNothingRetired(f)
  })

  it('onMachineTerminal (used by flow-repair close) runs the same helper', () => {
    const f = family('done')
    onMachineTerminal(getDb(), f.parent, 'done')
    expectRetired(f)
  })
})

describe('hygiene review-hard-expiry close', () => {
  it('soft-closing a stale review parent to done retires its never-ran child', () => {
    const f = family('review')
    getDb().prepare("UPDATE objectives SET ai_review_verdict = NULL, updated_at = datetime('now', '-40 days') WHERE id = ?").run(f.parent)
    const d = buildHygieneDigest(getDb(), {
      reviewStaleDays: 7,
      queueStaleDays: 14,
      hardExpiryDays: 30,
      applyHardExpiry: true,
      nowIso: new Date().toISOString(),
    })
    expect(d.hardExpiredIds).toContain(f.parent)
    expect(statusOf(f.parent)).toBe('done')
    expectRetired(f)
  })
})
