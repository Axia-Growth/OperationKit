/**
 * obj 900952 — PATCH /api/objectives/:id/status when the caller is an agent API
 * key. Real objectives router behind the real agent-key guard, throwaway DB.
 *
 *   - an agent key closing a PR card with no passing AI review is refused (409)
 *     unless it sends `override_reason`;
 *   - with a reason the close goes through and the audit row names the bot and
 *     the reason;
 *   - an agent-key close never sets `terminal_by_human`;
 *   - a person (cookie) closing the same card is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-status-agent-close-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-status-agent-close'
process.env.TRANSCRIPT_DIR = TMP

vi.mock('../services/worktree-reaper.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, scheduleObjectiveWorktreeReap: () => {} }
})

const { initDb, getDb } = await import('../db/index.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { default: objectivesRouter } = await import('./objectives.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const KEY_LABEL = 'Grok: Closer'
const PR_URL = 'https://github.com/x/y/pull/9'
let server: http.Server
let baseUrl: string
let botKey = ''

const ownerCookie = () =>
  `token=${jwt.sign({ id: OWNER, username: 'operator', role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`

async function patchStatus(id: number, headers: Record<string, string>, body: unknown) {
  const res = await fetch(`${baseUrl}/api/objectives/${id}/status`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json }
}
const asBot = (id: number, body: unknown) => patchStatus(id, { Authorization: `Bearer ${botKey}` }, body)
const asOwner = (id: number, body: unknown) => patchStatus(id, { Cookie: ownerCookie() }, body)

function card(spec: { verdict?: string | null; pr?: boolean } = {}): number {
  const pr = spec.pr ?? true
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, ai_review_verdict, pr_url, pr_number)
     VALUES ('agent close fixture', 'cto', 'growth', ?, 'review', ?, ?, ?)`,
  ).run(OWNER, spec.verdict ?? null, pr ? PR_URL : null, pr ? 9 : null).lastInsertRowid)
}

const row = (id: number) =>
  getDb().prepare('SELECT status, terminal_by_human FROM objectives WHERE id = ?').get(id) as { status: string; terminal_by_human: number }
/** The status handler's own audit rows (the agent-key guard writes a second, separate row). */
const statusAudit = (id: number) =>
  getDb().prepare(
    `SELECT from_status, to_status, actor, pathway, reason FROM objective_audit
      WHERE objective_id = ? AND event_type = 'status_change' AND pathway = 'public-patch-status' ORDER BY id`,
  ).all(id) as Loose[]

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('growth', 'Growth')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'growth', 'admin')`).run()
  // The CI-green gate would shell out to gh for a PR card; it has its own suite.
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ci_green_gate_enabled', '0')`).run()
  const k = createAgentKey({ id: OWNER, role: 'admin' }, { label: KEY_LABEL, scopes: ['board:read', 'board:write', 'board:done'] })
  if (!k.ok) throw new Error(k.error)
  botKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/objectives', objectivesRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('agent key closing a PR card without a passing review', () => {
  for (const verdict of ['fail', 'blocked', null] as const) {
    it(`verdict ${verdict ?? 'none'} + no override_reason → 409, card not moved, nothing audited as a close`, async () => {
      const id = card({ verdict })
      const r = await asBot(id, { status: 'done' })
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('no_passing_review')
      expect(r.json.ai_review_verdict).toBe(verdict)
      expect(r.json.error).toContain('override_reason')
      expect(row(id)).toEqual({ status: 'review', terminal_by_human: 0 })
      expect(statusAudit(id)).toEqual([])
    })
  }

  it('an empty, blank or non-text override_reason is not a reason → 409', async () => {
    const id = card({ verdict: 'fail' })
    for (const override_reason of ['', '   \n ', 42, true, null, ['x']]) {
      const r = await asBot(id, { status: 'done', override_reason })
      expect(r.status).toBe(409)
    }
    expect(row(id).status).toBe('review')
    expect(statusAudit(id)).toEqual([])
  })

  it('with override_reason → 200, and the audit row names the bot and the reason', async () => {
    const id = card({ verdict: 'fail' })
    const r = await asBot(id, { status: 'done', override_reason: '  Reviewer blocked on a flaky preview; PR merged by the owner.  ' })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('done')
    expect(row(id)).toEqual({ status: 'done', terminal_by_human: 0 })
    expect(statusAudit(id)).toEqual([{
      from_status: 'review',
      to_status: 'done',
      actor: `bot:${KEY_LABEL}`,
      pathway: 'public-patch-status',
      reason: 'Reviewer blocked on a flaky preview; PR merged by the owner.',
    }])
  })
})

describe('agent key closes that need no reason', () => {
  it('PR card with a passing review → 200, recorded as the bot, not a human terminal', async () => {
    const id = card({ verdict: 'pass' })
    const r = await asBot(id, { status: 'done' })
    expect(r.status).toBe(200)
    expect(row(id)).toEqual({ status: 'done', terminal_by_human: 0 })
    expect(statusAudit(id)).toEqual([{ from_status: 'review', to_status: 'done', actor: `bot:${KEY_LABEL}`, pathway: 'public-patch-status', reason: null }])
  })

  it('card with no PR → 200 without a reason, still not a human terminal', async () => {
    const id = card({ verdict: 'fail', pr: false })
    const r = await asBot(id, { status: 'done' })
    expect(r.status).toBe(200)
    expect(row(id)).toEqual({ status: 'done', terminal_by_human: 0 })
    expect(statusAudit(id)[0].actor).toBe(`bot:${KEY_LABEL}`)
  })

  it('an override_reason sent where none is needed is not recorded', async () => {
    const id = card({ verdict: 'pass' })
    const r = await asBot(id, { status: 'done', override_reason: 'not needed' })
    expect(r.status).toBe(200)
    expect(statusAudit(id)[0].reason).toBeNull()
  })
})

describe('a person (cookie) is unchanged', () => {
  it('closes a PR card with a failed review, no reason needed, as a human terminal', async () => {
    const id = card({ verdict: 'fail' })
    const r = await asOwner(id, { status: 'done' })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('done')
    expect(row(id)).toEqual({ status: 'done', terminal_by_human: 1 })
    expect(statusAudit(id)).toEqual([{ from_status: 'review', to_status: 'done', actor: 'user', pathway: 'public-patch-status', reason: null }])
  })
})
