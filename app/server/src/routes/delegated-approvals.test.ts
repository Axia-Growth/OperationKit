/**
 * obj 900839 — delegated approvals end to end over the real routers:
 *   - the owner (admin, cookie) issues a grant on the bot's settings page;
 *   - a bot on an agent key sends an approval → the worker gets a DELEGATED
 *     stamp, the card gets "Approved by … under grant #N (…)" with the quoted
 *     message, the server audit log gets a row;
 *   - deny paths: no grant, wrong workspace, wrong action, expired, revoked —
 *     each a 403 and NOTHING reaches the worker;
 *   - a bot (agent key), a Bearer JWT and a team member can never create,
 *     revoke or extend a grant — and there is no update route at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-delegated-routes-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-delegated-routes'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-delegated-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const sendFollowUpMock = vi.fn((sessionId: string, _m: string, _o: unknown, _opts?: unknown) => sessionId)
vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (...a: [string, string, unknown, unknown]) => sendFollowUpMock(...a) }
})

const { initDb, getDb } = await import('../db/index.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { stampForSession } = await import('../lib/message-provenance.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: agentChatRouter } = await import('./agent-chat.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const MEMBER = 2
const SLUG = 'your-org-cto' // a chat bot the registry maps to "Grok: CTO"
const BOT = 'Grok: CTO'
let server: http.Server
let baseUrl: string
let botKey = ''
let cardGrowth = 0
let cardOther = 0
const SESSION_GROWTH = 'cc-900839-1'
const SESSION_OTHER = 'cc-900839-2'

const cookie = (id: number, role: string, username: string) =>
  `token=${jwt.sign({ id, username, role }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`
const ownerCookie = () => cookie(OWNER, 'admin', 'operator')
const ownerBearer = () => `Bearer ${jwt.sign({ id: OWNER, username: 'operator', role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString()

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json }
}

const asOwner = (method: string, p: string, body?: unknown) => call(method, p, { Cookie: ownerCookie() }, body)
const asBot = (method: string, p: string, body?: unknown) => call(method, p, { Authorization: `Bearer ${botKey}` }, body)
const grantsUrl = `/api/agent-chat/agents/${SLUG}/delegations`

function followups(session: string): Array<{ text: string; sender?: Loose }> {
  const file = path.join(TMP, `${session}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === 'followup')
}

async function issue(actions: string[], workspace = 'growth', expires = inDays(7)): Promise<number> {
  const r = await asOwner('POST', grantsUrl, { workspace, actions, expires_at: expires })
  expect(r.status).toBe(201)
  return r.json.created.id as number
}

const flush = () => new Promise(r => setTimeout(r, 20))

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'teammate', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('growth', 'Growth'), ('other', 'Other')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'growth', 'admin'), (1, 'other', 'admin'), (2, 'growth', 'member')`).run()
  cardGrowth = Number(db.prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id) VALUES ('ship it', 'cto', 'growth', 1, 'review', ?)`).run(SESSION_GROWTH).lastInsertRowid)
  cardOther = Number(db.prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id) VALUES ('elsewhere', 'cto', 'other', 1, 'review', ?)`).run(SESSION_OTHER).lastInsertRowid)
  fs.mkdirSync(path.join(TMP_AGENTS, SLUG), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, SLUG, 'agent.yaml'), 'name: CTO\nsystem_prompt: You own engineering.\n')
  // The shared bot key, owned by the owner (as in production).
  const k = createAgentKey({ id: OWNER, role: 'admin' }, { label: 'OpKit', scopes: ['board:read', 'board:write'] })
  if (!k.ok) throw new Error(k.error)
  botKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/agent-chat', agentChatRouter)
  server = http.createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(() => {
  sendFollowUpMock.mockClear()
  const db = getDb()
  db.prepare('DELETE FROM delegation_grants').run()
  db.prepare("UPDATE objectives SET status = 'review'").run()
})

describe('owner issues a grant on the bot settings page', () => {
  it('lists the registry bot, the workspace options, and lets the owner create one', async () => {
    const before = await asOwner('GET', grantsUrl)
    expect(before.status).toBe(200)
    expect(before.json).toMatchObject({ bot: { id: BOT }, can_manage: true, grants: [] })
    expect(before.json.workspace_options.map((w: Loose) => w.slug)).toEqual(expect.arrayContaining(['growth', 'other']))

    const id = await issue(['merge', 'prod_migration', 'deploy'])
    const after = await asOwner('GET', grantsUrl)
    expect(after.json.grants).toHaveLength(1)
    expect(after.json.grants[0]).toMatchObject({ id, bot_name: BOT, workspace: 'growth', actions: ['merge', 'prod_migration', 'deploy'], state: 'active', created_by: 'operator', granted_by: 'operator' })
  })

  it('an expiry is required', async () => {
    const r = await asOwner('POST', grantsUrl, { workspace: 'growth', actions: ['merge'] })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('expiry_required')
  })
})

// obj 901388 — "Merge without asking me each time" rides on the same owner-only POST.
describe('the standing-merge switch on a grant', () => {
  it('is off by default, set only by the owner on create, and only with merge', async () => {
    const plain = await issue(['merge'])
    const on = await asOwner('POST', grantsUrl, { workspace: 'growth', actions: ['merge'], expires_at: inDays(7), standing_merge: true })
    expect(on.status).toBe(201)
    expect(on.json.created).toMatchObject({ standing_merge: true, actions: ['merge'] })
    const list = (await asOwner('GET', grantsUrl)).json.grants as Loose[]
    expect(list.find(g => g.id === plain)?.standing_merge).toBe(false)

    const deployOnly = await asOwner('POST', grantsUrl, { workspace: 'growth', actions: ['deploy'], expires_at: inDays(7), standing_merge: true })
    expect(deployOnly.status).toBe(400)
    expect(deployOnly.json.code).toBe('standing_merge_needs_merge')
    const truthy = await asOwner('POST', grantsUrl, { workspace: 'growth', actions: ['merge'], expires_at: inDays(7), standing_merge: 'yes' })
    expect(truthy.status).toBe(400)

    const bot = await asBot('POST', grantsUrl, { workspace: 'growth', actions: ['merge'], expires_at: inDays(7), standing_merge: true })
    expect(bot.status).toBe(403)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM delegation_grants WHERE standing_merge = 1').get() as { n: number }).n).toBe(1)
  })
})

describe('a bot can never grant, extend or revoke its own approvals', () => {
  it('agent key: create and revoke are refused; no grant is written', async () => {
    const id = await issue(['merge'])
    expect((await asBot('POST', grantsUrl, { workspace: 'growth', actions: ['merge', 'deploy'], expires_at: inDays(300) })).status).toBe(403)
    expect((await asBot('DELETE', `${grantsUrl}/${id}`)).status).toBe(403)
    const rows = getDb().prepare('SELECT * FROM delegation_grants').all() as Loose[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, allow_deploy: 0, revoked_at: null })
  })

  it("the owner's own Bearer JWT (a script) and a team member's cookie are refused too", async () => {
    const bearer = await call('POST', grantsUrl, { Authorization: ownerBearer() }, { workspace: 'growth', actions: ['merge'], expires_at: inDays(7) })
    expect(bearer.status).toBe(403)
    expect(bearer.json.code).toBe('owner_only')
    const member = await call('POST', grantsUrl, { Cookie: cookie(MEMBER, 'member', 'teammate') }, { workspace: 'growth', actions: ['merge'], expires_at: inDays(7) })
    expect(member.status).toBe(403)
    expect((await call('GET', grantsUrl, { Cookie: cookie(MEMBER, 'member', 'teammate') })).status).toBe(403)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM delegation_grants').get()).toEqual({ n: 0 })
  })

  it('there is no route that edits or extends a grant', async () => {
    const id = await issue(['merge'])
    for (const method of ['PUT', 'PATCH']) {
      const r = await asOwner(method, `${grantsUrl}/${id}`, { expires_at: inDays(300), actions: ['merge', 'deploy'] })
      expect(r.status).toBe(404)
    }
  })
})

describe('the approval gate on a card message', () => {
  it('ALLOW: bot approval under an active grant reaches the worker as DELEGATED, with card line + audit', async () => {
    const id = await issue(['merge'])
    const msg = 'Operator signed off in Slack. Merge PR 701.'
    const r = await asBot('POST', `/api/objectives/${cardGrowth}/message`, { message: msg, approval: 'merge', owner_bot: 'CTO' })
    expect(r.status).toBe(200)
    await flush()

    const ev = followups(SESSION_GROWTH).at(-1)!
    expect(ev.sender).toMatchObject({ kind: 'delegated', verified: false, delegation: { grant_id: id, action: 'merge', bot: BOT, on_behalf_of: 'Operator' } })
    const [, , , opts] = sendFollowUpMock.mock.calls.at(-1)! as [string, string, unknown, { sender: Loose }]
    expect(stampForSession(opts.sender, msg).split('\n')[0]).toBe(`[cc-sender] DELEGATED: ${BOT} on behalf of Operator (owner) under grant #${id} — approves merge only`)

    const line = getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'delegated_approval' ORDER BY id DESC").get(cardGrowth) as Loose
    expect(line.title).toBe(`Approved by ${BOT} on behalf of Operator under grant #${id} (merge)`)
    expect(line.detail).toBe(`> ${msg}`)
    const audit = getDb().prepare("SELECT * FROM delegation_audit WHERE event = 'approval_used' ORDER BY id DESC").get() as Loose
    expect(audit).toMatchObject({ grant_id: id, objective_id: cardGrowth, action: 'merge', agent_key_label: 'OpKit', bot_name: BOT, message_excerpt: msg })
  })

  it('an ordinary bot message (no approval field) is unchanged: plain AGENT, no audit', async () => {
    await issue(['merge'])
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM delegation_audit').get() as Loose).n
    const r = await asBot('POST', `/api/objectives/${cardGrowth}/message`, { message: 'status?' })
    expect(r.status).toBe(200)
    await flush()
    expect(followups(SESSION_GROWTH).at(-1)!.sender).toMatchObject({ kind: 'agent', label: 'OpKit' })
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM delegation_audit').get() as Loose).n).toBe(before)
  })

  async function expectDenied(card: number, body: Record<string, unknown>, code: string) {
    const r = await asBot('POST', `/api/objectives/${card}/message`, { message: 'approved', ...body })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe(code)
    expect(sendFollowUpMock).not.toHaveBeenCalled()
    const status = (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(card) as Loose).status
    expect(status).toBe('review') // the refused message did not start the worker
  }

  it('DENY: no grant', async () => {
    await expectDenied(cardGrowth, { approval: 'deploy', owner_bot: 'CTO' }, 'no_active_grant')
  })

  it('DENY: wrong workspace — a growth grant does not cover a card in another workspace', async () => {
    await issue(['merge'], 'growth')
    await expectDenied(cardOther, { approval: 'merge', owner_bot: 'CTO' }, 'no_active_grant')
  })

  it('DENY: wrong action — a merge grant does not approve a deploy', async () => {
    await issue(['merge'])
    await expectDenied(cardGrowth, { approval: 'deploy', owner_bot: 'CTO' }, 'no_active_grant')
  })

  it('DENY: expired grant', async () => {
    const id = await issue(['merge'])
    getDb().prepare("UPDATE delegation_grants SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(id)
    await expectDenied(cardGrowth, { approval: 'merge', owner_bot: 'CTO' }, 'no_active_grant')
    expect((await asOwner('GET', grantsUrl)).json.grants[0].state).toBe('expired')
  })

  it('REVOKE: one click by the owner and the next approval is refused', async () => {
    const id = await issue(['merge'])
    const ok = await asBot('POST', `/api/objectives/${cardGrowth}/message`, { message: 'merge', approval: 'merge', owner_bot: 'CTO' })
    expect(ok.status).toBe(200)
    await flush()
    sendFollowUpMock.mockClear()
    getDb().prepare("UPDATE objectives SET status = 'review'").run()

    const rev = await asOwner('DELETE', `${grantsUrl}/${id}`)
    expect(rev.status).toBe(200)
    expect(rev.json.revoked).toMatchObject({ id, state: 'revoked', revoked_by: 'operator' })
    await expectDenied(cardGrowth, { approval: 'merge', owner_bot: 'CTO' }, 'no_active_grant')
  })

  it('DENY: another bot cannot use this bot\'s grant', async () => {
    await issue(['merge'])
    await expectDenied(cardGrowth, { approval: 'merge', owner_bot: 'CFO' }, 'no_active_grant')
  })

  it('every refusal is in the server audit log', async () => {
    await expectDenied(cardGrowth, { approval: 'prod_migration', owner_bot: 'CTO' }, 'no_active_grant')
    const row = getDb().prepare("SELECT * FROM delegation_audit WHERE event = 'approval_denied' ORDER BY id DESC").get() as Loose
    expect(row).toMatchObject({ objective_id: cardGrowth, action: 'prod_migration', reason: 'no_active_grant', agent_key_label: 'OpKit' })
  })
})
