/**
 * obj 901230 — MCP update_status carries override_reason.
 *
 * The REST close gate (obj 900952, objectives-status.ts) refuses an agent key
 * that sets a PR card to done without a passing AI review unless it states an
 * override_reason. The MCP tool used to accept only {id, status}, so a connector
 * agent could never close such a card. Real MCP router → loopback → real
 * agent-key guard → real status route, throwaway DB.
 *
 *   1. the tool's input schema lists optional override_reason (string), and the
 *      published description names it;
 *   2. agent key + reason closes a non-pass PR card; the audit row holds the
 *      reason and the card payload exposes closed_over_review.reason;
 *   3. the same close without a reason is still a 409 no_passing_review;
 *   4. a person (cookie) closes without any reason;
 *   5. a card whose verdict is pass closes without a reason.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-override-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-mcp-override-reason'
process.env.TRANSCRIPT_DIR = TMP

vi.mock('../services/worktree-reaper.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, scheduleObjectiveWorktreeReap: () => {} }
})

const { initDb, getDb } = await import('../db/index.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: agentMcpRouter, MCP_TOOLS } = await import('./agent-mcp.js')
const { readClosedOverReview } = await import('../services/review-hygiene.js')

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

let nextRpc = 1
async function callTool(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${botKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpc++, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const result = (await res.json()).result as { content: { text: string }[]; isError?: boolean; structuredContent?: Loose }
  return { result, data: result.isError ? null : JSON.parse(result.content[0].text) }
}

async function listTools(): Promise<Loose[]> {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${botKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpc++, method: 'tools/list', params: {} }),
  })
  return (await res.json()).result.tools
}

async function getCard(id: number, headers: Record<string, string>): Promise<Loose> {
  const res = await fetch(`${baseUrl}/api/objectives/${id}`, { headers })
  expect(res.status).toBe(200)
  return res.json()
}

function card(spec: { verdict?: string | null; pr?: boolean } = {}): number {
  const pr = spec.pr ?? true
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, ai_review_verdict, pr_url, pr_number)
     VALUES ('mcp override fixture', 'cto', 'growth', ?, 'review', ?, ?, ?)`,
  ).run(OWNER, spec.verdict ?? null, pr ? PR_URL : null, pr ? 9 : null).lastInsertRowid)
}

const statusOf = (id: number) =>
  (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
/** The status handler's own audit rows (the agent-key guard writes a separate mirror row). */
const statusAudit = (id: number) =>
  getDb().prepare(
    `SELECT to_status, actor, reason FROM objective_audit
      WHERE objective_id = ? AND event_type = 'status_change' AND pathway = 'public-patch-status' ORDER BY id`,
  ).all(id) as Loose[]

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('growth', 'Growth')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'growth', 'admin')`).run()
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ci_green_gate_enabled', '0')`).run()
  const k = createAgentKey({ id: OWNER, role: 'admin' }, { label: KEY_LABEL, scopes: ['board:read', 'board:write', 'board:done'] })
  if (!k.ok) throw new Error(k.error)
  botKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api', agentMcpRouter)
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

describe('1. update_status schema', () => {
  it('lists override_reason as an optional string, and the description names it', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'update_status')!
    const props = (tool.inputSchema as Loose).properties
    expect(props.override_reason.type).toBe('string')
    expect((tool.inputSchema as Loose).required).toEqual(['id', 'status'])
    expect(tool.description).toMatch(/override_reason/)
    expect(tool.description).toMatch(/no_passing_review/)

    // What the connector publishes over tools/list matches the schema above.
    const published = (await listTools()).find(t => t.name === 'update_status')
    expect(published.inputSchema).toEqual(tool.inputSchema)
    expect(published.description).toBe(tool.description)
  })
})

describe('2. agent key + override_reason closes a non-pass PR card', () => {
  for (const verdict of ['fail', 'blocked', null] as const) {
    it(`verdict ${verdict ?? 'none'}: closes, audits the reason, the card shows it`, async () => {
      const id = card({ verdict })
      const reason = 'PR merged by the owner; the review was blocked on a preview outage.'
      const { result, data } = await callTool('update_status', { id, status: 'done', override_reason: `  ${reason}  ` })
      expect(result.isError).toBeFalsy()
      expect(data.status).toBe('done')
      expect(data.closed_over_review).toMatchObject({ verdict, by: `bot:${KEY_LABEL}`, reason })
      expect(statusOf(id)).toBe('done')
      expect(statusAudit(id)).toEqual([{ to_status: 'done', actor: `bot:${KEY_LABEL}`, reason }])

      // The card payload a person or another agent reads afterwards still shows it,
      // even though the agent-key guard wrote its own (reasonless) mirror row later.
      const readers: Record<string, string>[] = [{ Cookie: ownerCookie() }, { Authorization: `Bearer ${botKey}` }]
      for (const headers of readers) {
        const c = await getCard(id, headers)
        expect(c.closed_over_review).toMatchObject({ verdict, by: `bot:${KEY_LABEL}`, reason })
        expect(typeof c.closed_over_review.at).toBe('string')
      }
    })
  }
})

describe('3. no override_reason → still 409 no_passing_review', () => {
  it('omitted, empty or blank reason is refused with the code, and the card does not move', async () => {
    const id = card({ verdict: 'fail' })
    for (const args of [{}, { override_reason: '' }, { override_reason: '   ' }]) {
      const { result } = await callTool('update_status', { id, status: 'done', ...args })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/^Error 409: .*override_reason/)
      expect(result.structuredContent).toMatchObject({ status: 409, code: 'no_passing_review' })
    }
    expect(statusOf(id)).toBe('review')
    expect(statusAudit(id)).toEqual([])
  })

  it('a non-string reason is refused by the tool before anything is sent', async () => {
    const id = card({ verdict: 'fail' })
    const { result } = await callTool('update_status', { id, status: 'done', override_reason: 42 })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/override_reason must be a string/)
    expect(statusOf(id)).toBe('review')
  })
})

describe('4. a person is not gated', () => {
  it('a cookie close of a non-pass PR card needs no reason; the card shows the close with no reason (PR 836)', async () => {
    const id = card({ verdict: 'fail' })
    const res = await fetch(`${baseUrl}/api/objectives/${id}/status`, {
      method: 'PATCH',
      headers: { Cookie: ownerCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(res.status).toBe(200)
    expect(statusOf(id)).toBe('done')
    expect((await getCard(id, { Cookie: ownerCookie() })).closed_over_review)
      .toMatchObject({ verdict: 'fail', by: 'user', reason: null })
  })
})

describe('5. a passing review needs no reason', () => {
  it('agent key closes a pass PR card over MCP without override_reason', async () => {
    const id = card({ verdict: 'pass' })
    const { result, data } = await callTool('update_status', { id, status: 'done' })
    expect(result.isError).toBeFalsy()
    expect(data.status).toBe('done')
    expect(data.closed_over_review).toBeUndefined()
    expect(statusAudit(id)).toEqual([{ to_status: 'done', actor: `bot:${KEY_LABEL}`, reason: null }])
  })

  it('a reason sent anyway on a pass card is not recorded as an override', async () => {
    const id = card({ verdict: 'pass' })
    const { result } = await callTool('update_status', { id, status: 'done', override_reason: 'not needed' })
    expect(result.isError).toBeFalsy()
    expect(statusAudit(id)[0].reason).toBeNull()
    expect((await getCard(id, { Cookie: ownerCookie() })).closed_over_review).toBeNull()
  })
})

describe('readClosedOverReview', () => {
  const audit = (id: number, to: string, actor: string, pathway: string, reason: string | null = null) =>
    getDb().prepare(
      `INSERT INTO objective_audit (objective_id, event_type, from_status, to_status, actor, pathway, reason)
       VALUES (?, 'status_change', 'review', ?, ?, ?, ?)`,
    ).run(id, to, actor, pathway, reason)

  it('reads the handler row, not the agent-key guard mirror written after it', () => {
    const id = card({ verdict: 'fail' })
    audit(id, 'done', 'bot:x', 'public-patch-status', 'merged by owner')
    audit(id, 'done', 'agent_key:1:x', 'agent_api PATCH /api/objectives/1/status')
    expect(readClosedOverReview(getDb(), { id, status: 'done', ai_review_verdict: 'fail' }))
      .toMatchObject({ verdict: 'fail', by: 'bot:x', reason: 'merged by owner' })
  })

  it('a card that is not done, or passed review, shows nothing', () => {
    const id = card({ verdict: 'fail' })
    audit(id, 'done', 'bot:x', 'public-patch-status', 'merged by owner')
    expect(readClosedOverReview(getDb(), { id, status: 'queue', ai_review_verdict: 'fail' })).toBeNull()
    expect(readClosedOverReview(getDb(), { id, status: 'done', ai_review_verdict: 'pass' })).toBeNull()
  })

  it('a later reasonless close (after a reopen) does not reuse the old reason', () => {
    const id = card({ verdict: 'fail' })
    audit(id, 'done', 'bot:x', 'public-patch-status', 'first close')
    audit(id, 'queue', 'user', 'public-patch-status')
    audit(id, 'done', 'user', 'public-patch-status')
    // PR 836: a person closing over a fail is still shown, with no reason.
    expect(readClosedOverReview(getDb(), { id, status: 'done', ai_review_verdict: 'fail' }))
      .toMatchObject({ verdict: 'fail', by: 'user', reason: null })
  })
})
