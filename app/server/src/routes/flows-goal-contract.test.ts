// obj 901766 — goal-defined workflows: a person states a goal and how to know it
// worked; the end condition is a CONTRACT the builder cannot weaken.
//   1. POST /api/flows {goal, done_when} stores the plain words and puts them in the builder brief
//   2. the builder's FIRST draft pins its proposed end condition; a later agent draft that changes it is 409 end_condition_changed
//   3. an end condition the owner gave at create is pinned + confirmed; the builder may not change it
//   4. publish of a builder-written end condition needs confirm_end_condition: true; publishing pins it as confirmed
//   5. a person's own draft may change it (their words); an agent key's end condition waits for a person
//   6. the end-to-end path: goal → builder draft → dry self-test green → owner confirms + approves send node → published
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import { endConditionKey, sameEndCondition, checkEndConditionContract, isAgentWrittenAuthor } from '../../../shared/flow/end-condition.js'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in flows tests') } }))

const TMP_DB = path.join(os.tmpdir(), `cc-flows-goal-contract-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-flows-goal-contract'
process.env.ALERTS_ENABLED = 'false'
process.env.OKIT_BIN = path.join(os.tmpdir(), `no-okit-${process.pid}`)

const { initDb, getDb } = await import('../db/index.js')
const { default: flowsRouter } = await import('./flows.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { registerFlowTool } = await import('../services/flow-engine.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')
const { readFlowContract } = await import('../services/flow-contract.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = { id: 811, username: 'owner', role: 'admin' as const }
const WS = 'ws-goal'

let server: http.Server
let baseUrl = ''
let botKey = ''

async function call(
  method: string,
  p: string,
  opts: { session?: string; bearer?: string; owner?: boolean; body?: unknown } = {},
): Promise<{ status: number; json: Loose }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.session) headers['X-CC-Session-Token'] = opts.session
  else if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.owner) headers.Cookie = `token=${jwt.sign(ADMIN, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: unknown = text
  try { json = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, json }
}

const DONE_WHEN = 'Everyone who signed up yesterday got exactly one welcome message.'
const PROPOSED = { assert: [{ expr: 'steps.welcome.output.sent == len(steps.fetch.output.signups)', why: 'one welcome per signup' }] }
const WEAKER = { assert: [{ expr: 'steps.welcome.output.sent >= 0', why: 'always true' }] }

function draft(slug: string, endCondition: unknown, name = 'Welcome new signups'): Record<string, unknown> {
  return {
    apiVersion: 'okflow/1', id: slug, name, workspace: WS,
    goal: { statement: 'Welcome yesterday\'s signups', end_condition: endCondition },
    nodes: [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'signups-list', effect: 'read', mock: { output: { signups: [{ email: 'a@example.test' }, { email: 'b@example.test' }] } }, next: 'welcome' },
      { id: 'welcome', kind: 'mcp', connector: 'mailer', tool: 'send_welcome', effect: 'send', arguments: { to: '{{ steps.fetch.output.signups }}' }, mock: { output: { sent: 2 } }, next: 'done' },
      { id: 'done', kind: 'end' },
    ],
  }
}

async function newFlow(body: Record<string, unknown>, as: { owner?: boolean; bearer?: string } = { owner: true }) {
  const r = await call('POST', '/api/flows', { ...as, body: { workspace: WS, ...body } })
  expect(r.status, JSON.stringify(r.json)).toBe(201)
  const session = mintSessionToken({ objectiveId: r.json.objective_id, workspace: WS, actingUserId: ADMIN.id })
  return { flowId: r.json.flow_id as number, slug: r.json.slug as string, objectiveId: r.json.objective_id as number, session, created: r.json }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)").run(ADMIN.id, ADMIN.username, ADMIN.role)
  db.prepare('INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)').run(WS, 'Goal WS')
  invalidateWorkspacesCache()
  db.prepare("INSERT INTO settings (key, value) VALUES ('flows_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run()
  db.prepare(
    `INSERT INTO workspace_mcp_servers (workspace, slug, name, url, status, tools_json, disabled_tools_json, enabled)
     VALUES (?, 'mailer', 'Mailer', 'https://mcp.example.test', 'connected', ?, '[]', 1)`,
  ).run(WS, JSON.stringify([{ name: 'send_welcome' }]))
  registerFlowTool('signups-list', { effect: 'read', run: async () => ({ signups: [] }) })
  const minted = createAgentKey(ADMIN, { label: 'goal-bot', scopes: ['board:read', 'board:write', 'board:start'], workspaces: [WS] })
  if (!minted.ok) throw new Error(minted.error)
  botKey = minted.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/flows', flowsRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  try { fs.unlinkSync(TMP_DB) } catch { /* gone */ }
})

describe('shared: end-condition contract helpers', () => {
  it('compares what grades a run: assert expressions as a set (whitespace-insensitive) and the judge; `why` is ignored', () => {
    const a = { assert: [{ expr: 'x == 1', why: 'one' }, { expr: 'len(y)  > 0' }] }
    expect(sameEndCondition(a, { assert: [{ expr: 'len(y) > 0' }, { expr: 'x == 1', why: 'reworded' }] })).toBe(true)
    expect(sameEndCondition(a, { assert: [{ expr: 'x == 1' }] })).toBe(false)
    expect(sameEndCondition(a, { ...a, judge: { rubric: 'r', on: '{{ steps.a.output }}' } })).toBe(false)
    expect(endConditionKey(null)).toBe('none')
  })
  it('agent-written authors are builder sessions, agent keys and the repair watcher', () => {
    expect(['agent:5', 'agent_key:2', 'repair:9'].every(isAgentWrittenAuthor)).toBe(true)
    expect(isAgentWrittenAuthor('user:1')).toBe(false)
  })
  it('a person\'s version is confirmed; an agent\'s needs a person unless it equals a confirmed contract', () => {
    expect(checkEndConditionContract({ versionEndCondition: WEAKER, versionAuthor: 'user:1', contract: null })).toEqual({ status: 'confirmed' })
    expect(checkEndConditionContract({ versionEndCondition: PROPOSED, versionAuthor: 'agent:4', contract: null }))
      .toEqual({ status: 'needs_confirmation', reason: 'proposed_by_agent' })
    expect(checkEndConditionContract({ versionEndCondition: PROPOSED, versionAuthor: 'agent:4', contract: { end_condition: PROPOSED, confirmed_by: null } }))
      .toEqual({ status: 'needs_confirmation', reason: 'proposed_by_agent' })
    expect(checkEndConditionContract({ versionEndCondition: PROPOSED, versionAuthor: 'repair:7', contract: { end_condition: PROPOSED, confirmed_by: 'user:1' } }))
      .toEqual({ status: 'confirmed' })
    expect(checkEndConditionContract({ versionEndCondition: WEAKER, versionAuthor: 'agent:4', contract: { end_condition: PROPOSED, confirmed_by: 'user:1' } }))
      .toEqual({ status: 'needs_confirmation', reason: 'differs_from_confirmed' })
  })
})

describe('goal + plain-words "Done when"', () => {
  it('stores done_when, returns it, and the builder brief tells the builder to turn it into asserts', async () => {
    const { flowId, objectiveId, created } = await newFlow({ goal: 'Welcome every new signup', done_when: DONE_WHEN })
    expect(created.end_condition).toEqual({ done_when: DONE_WHEN, end_condition: null, confirmed_by: null, confirmed_at: null })
    const detail = await call('GET', `/api/flows/${flowId}`, { owner: true })
    expect(detail.json.builder.done_when).toBe(DONE_WHEN)
    const card = getDb().prepare('SELECT description, completion_goal FROM objectives WHERE id = ?').get(objectiveId) as Loose
    expect(card.description).toContain(`> ${DONE_WHEN}`)
    expect(card.description).toContain('Turn those words into the machine-checkable end condition')
    expect(card.description).toContain('end_condition_changed')
    expect(card.completion_goal).toContain('never changes a pinned end condition')
  })

  it('done_when is also accepted inside goal {statement, done_when}; a non-string or over-long one is a 400', async () => {
    const ok = await call('POST', '/api/flows', { owner: true, body: { workspace: WS, goal: { statement: 'Nested goal', done_when: 'It is done.' } } })
    expect(ok.status).toBe(201)
    expect(ok.json.end_condition.done_when).toBe('It is done.')
    expect((await call('POST', '/api/flows', { owner: true, body: { workspace: WS, goal: 'g', done_when: 5 } })).status).toBe(400)
    expect((await call('POST', '/api/flows', { owner: true, body: { workspace: WS, goal: 'g', done_when: 'x'.repeat(1001) } })).status).toBe(400)
  })
})

describe('the builder cannot weaken the end condition', () => {
  it('first agent draft pins its proposal (unconfirmed); a later draft that changes it is refused and counted', async () => {
    const { flowId, slug, session } = await newFlow({ goal: 'Welcome signups (pin on first draft)', done_when: DONE_WHEN })
    const v1 = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: draft(slug, PROPOSED) } })
    expect(v1.status, JSON.stringify(v1.json)).toBe(201)
    expect(readFlowContract(getDb(), flowId)).toMatchObject({ end_condition: PROPOSED, confirmed_by: null })

    const weak = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: draft(slug, WEAKER) } })
    expect(weak.status).toBe(409)
    expect(weak.json.reason).toBe('end_condition_changed')
    expect(weak.json.pinned_end_condition).toEqual(PROPOSED)
    expect(weak.json.builder.used).toBe(2) // the refused attempt still costs an iteration
    // Rewording an assert's `why` is not a change.
    const reworded = { assert: [{ ...PROPOSED.assert[0], why: 'each signup is welcomed once' }] }
    const v2 = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: draft(slug, reworded, 'Renamed') } })
    expect(v2.status, JSON.stringify(v2.json)).toBe(201)
  })

  it('an end condition the owner gave at create is pinned and confirmed; the builder may not change it even on its first draft', async () => {
    const { flowId, slug, session, created } = await newFlow({ goal: 'Welcome signups (owner gave checks)', end_condition: PROPOSED })
    expect(created.end_condition).toMatchObject({ end_condition: PROPOSED, confirmed_by: `user:${ADMIN.id}` })
    const weak = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: draft(slug, WEAKER) } })
    expect(weak.status).toBe(409)
    expect(weak.json).toMatchObject({ reason: 'end_condition_changed', confirmed_by: `user:${ADMIN.id}` })
    expect((await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: draft(slug, PROPOSED) } })).status).toBe(201)
  })

  it('an agent key\'s end condition at create is pinned but waits for a person; an agent-key draft cannot change it either', async () => {
    const { flowId, slug, created } = await newFlow({ goal: 'Welcome signups (bot filed)', end_condition: PROPOSED }, { bearer: botKey })
    expect(created.end_condition).toMatchObject({ end_condition: PROPOSED, confirmed_by: null })
    const weak = await call('POST', `/api/flows/${flowId}/versions`, { bearer: botKey, body: { definition: draft(slug, WEAKER) } })
    expect(weak.status).toBe(409)
    expect(weak.json.reason).toBe('end_condition_changed')
  })

  it('a person\'s own draft may change it (their words) and becomes the confirmed contract the builder must keep', async () => {
    const { flowId, slug, session } = await newFlow({ goal: 'Welcome signups (owner edits)', end_condition: PROPOSED })
    const mine = await call('POST', `/api/flows/${flowId}/versions`, { owner: true, body: { definition: draft(slug, WEAKER) } })
    expect(mine.status, JSON.stringify(mine.json)).toBe(201)
    expect(readFlowContract(getDb(), flowId)).toMatchObject({ end_condition: WEAKER, confirmed_by: `user:${ADMIN.id}` })
    const back = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: draft(slug, PROPOSED) } })
    expect(back.status).toBe(409)
    expect(back.json.reason).toBe('end_condition_changed')
  })

  it('an agent key cannot go around the check by posting a whole definition to POST /api/flows', async () => {
    const { flowId, slug } = await newFlow({ goal: 'Welcome signups (bypass attempt)', end_condition: PROPOSED })
    const sneaky = await call('POST', '/api/flows', { bearer: botKey, body: { workspace: WS, definition: { ...draft(slug, WEAKER), version: 7 } } })
    expect(sneaky.status).toBe(409)
    expect(sneaky.json.reason).toBe('end_condition_changed')
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM flow_versions WHERE flow_id = ?').get(flowId)).toEqual({ n: 0 })
    // A brand-new workflow from JSON by an agent key: its end condition is pinned but unconfirmed.
    const fresh = await call('POST', '/api/flows', { bearer: botKey, body: { workspace: WS, definition: { ...draft('bot-made-flow', PROPOSED), version: 1 } } })
    expect(fresh.status, JSON.stringify(fresh.json)).toBe(201)
    expect(readFlowContract(getDb(), fresh.json.flow_id)).toMatchObject({ end_condition: PROPOSED, confirmed_by: null })
  })
})

describe('end to end: goal → builder → self-test → owner confirms the checks → published', () => {
  it('publish of a builder-written end condition needs confirm_end_condition; publishing pins it as confirmed', async () => {
    const { flowId, slug, session } = await newFlow({ goal: 'Welcome every signup (e2e)', done_when: DONE_WHEN })
    const v = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: draft(slug, PROPOSED) } })
    expect(v.status).toBe(201)
    const t = await call('POST', `/api/flows/${flowId}/test`, { session, body: { version: v.json.version, mode: 'dry' } })
    expect(t.json.self_test.status, JSON.stringify(t.json.self_test?.result)).toBe('passed')

    // The publish panel sees what to confirm.
    const detail = await call('GET', `/api/flows/${flowId}`, { owner: true })
    expect(detail.json.publish.end_condition).toMatchObject({
      value: PROPOSED, confirmation_required: true, reason: 'proposed_by_agent',
      contract: { done_when: DONE_WHEN, confirmed_by: null },
    })
    expect(detail.json.publish.nodes_requiring_approval).toEqual(['welcome'])

    // The builder itself can never publish.
    expect((await call('POST', `/api/flows/${flowId}/publish`, { session, body: { version: v.json.version, approve: ['welcome'], confirm_end_condition: true } })).status).toBe(403)

    // The owner approving the send node is not enough: the checks need a person too.
    const refused = await call('POST', `/api/flows/${flowId}/publish`, { owner: true, body: { version: v.json.version, approve: ['welcome'] } })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ reason: 'end_condition_unconfirmed', end_condition: PROPOSED, done_when: DONE_WHEN, why: 'proposed_by_agent' })
    expect(getDb().prepare('SELECT published_version FROM flow_definitions WHERE id = ?').get(flowId)).toEqual({ published_version: null })

    // …and the send node still needs its own approval.
    const noApprove = await call('POST', `/api/flows/${flowId}/publish`, { owner: true, body: { version: v.json.version, confirm_end_condition: true } })
    expect(noApprove.status).toBe(409)
    expect(noApprove.json.reason).toBe('approval_required')

    const ok = await call('POST', `/api/flows/${flowId}/publish`, { owner: true, body: { version: v.json.version, approve: ['welcome'], confirm_end_condition: true } })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.approvals.nodes).toEqual(['welcome'])
    expect(readFlowContract(getDb(), flowId)).toMatchObject({ end_condition: PROPOSED, confirmed_by: `user:${ADMIN.id}` })

    // Once confirmed, the same checks on a later builder version publish without asking again…
    const after = await call('GET', `/api/flows/${flowId}`, { owner: true })
    expect(after.json.publish.end_condition).toMatchObject({ confirmation_required: false, contract: { confirmed_by: `user:${ADMIN.id}` } })
    // …and a builder draft that changes them is refused, naming who confirmed them.
    const weak = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: draft(slug, WEAKER) } })
    expect(weak.status).toBe(409)
    expect(weak.json).toMatchObject({ reason: 'end_condition_changed', confirmed_by: `user:${ADMIN.id}` })
  })
})
