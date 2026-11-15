/**
 * Bot Full access routes (obj 900972), over real HTTP against a temp DB.
 *
 *   - only an admin signed in to the browser (cookie) can change the switch:
 *     a member, an agent API key, an admin's Bearer JWT and a card session
 *     token are all refused, and nothing is written;
 *   - every change is audit-logged (who, when, bot, workspace, on/off, expiry)
 *     and lands in the activity feed;
 *   - the bot list carries where each bot has Full access (the badge), only
 *     for workspaces the caller may see;
 *   - revoking the workspace ends Full access;
 *   - a card session of a Full access bot may message any card in its
 *     workspace, and only there; without Full access the one-hop rule stands.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-bot-full-access-routes'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-full-access-routes-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// A dead port: nothing here may reach a live Command Center.
process.env.PORT = '59948'
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-full-access-routes-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { default: internalRouter } = await import('./internal.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { fullAccessActive } = await import('../services/agent-chat/bot-full-access.js')

const ADMIN = 1
const MEMBER = 2 // member of ops only

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
let agentKey = ''

function tokenFor(id: number, role: string) {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as?: number; role?: string; body?: unknown; key?: string; bearer?: string; session?: string; base?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`
  else if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.as) headers.Cookie = `token=${tokenFor(opts.as, opts.role ?? 'member')}`
  if (opts.session) headers['X-CC-Session-Token'] = opts.session
  const res = await fetch(`${baseUrl}${opts.base ?? '/api/agent-chat'}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

const admin = (method: string, p: string, body?: unknown) => call(method, p, { as: ADMIN, role: 'admin', body })
const member = (method: string, p: string, body?: unknown) => call(method, p, { as: MEMBER, role: 'member', body })

function auditRows(): Loose[] {
  return getDb().prepare('SELECT * FROM agent_chat_bot_full_access_audit ORDER BY id').all() as Loose[]
}
function activity(kind: string): Loose[] {
  return getDb().prepare("SELECT * FROM activity_log WHERE json_extract(metadata, '$.kind') = ? ORDER BY id").all(kind) as Loose[]
}
function card(title: string, workspace: string, extra: { agent?: string; assignee?: number; status?: string; createdBy?: number; pr?: number } = {}): number {
  return Number(getDb()
    .prepare(`INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, agent_context, pr_number) VALUES (?, '', ?, ?, 'task', 'general', ?, ?, ?, ?)`)
    .run(title, workspace, extra.status ?? 'working', extra.createdBy ?? ADMIN, extra.assignee ?? ADMIN, extra.agent ?? 'general', extra.pr ?? null).lastInsertRowid)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user1', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(MEMBER)
  for (const ws of ['ops', 'sales']) db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(ws, ws)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, 'ops', 'member', 'all')`).run(MEMBER)
  fs.mkdirSync(path.join(TMP_AGENTS, 'dev'), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, 'dev', 'agent.yaml'), 'name: Operation Kit Dev\nsystem_prompt: You build.\ntools: [list_objectives]\n')
  const k = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'dev-bot' })
  if (!k.ok) throw new Error(k.error)
  agentKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  app.use('/api/internal', internalRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(async () => {
  const db = getDb()
  for (const t of ['agent_chat_bot_access', 'agent_chat_bot_workspaces', 'agent_chat_bot_full_access', 'agent_chat_bot_full_access_audit']) db.prepare(`DELETE FROM ${t}`).run()
  db.prepare("DELETE FROM activity_log WHERE json_extract(metadata, '$.kind') LIKE 'bot_full_access%'").run()
  // The bot is granted both workspaces; Full access starts off everywhere.
  expect((await admin('PUT', '/agents/dev/workspaces', { workspaces: ['ops', 'sales'] })).status).toBe(200)
})

describe('who may change the switch', () => {
  it('an admin signed in to the browser switches it on, with an expiry', async () => {
    const expires = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const r = await admin('PUT', '/agents/dev/full-access/ops', { enabled: true, expires_at: expires })
    expect(r.status).toBe(200)
    expect(r.json.can_manage).toBe(true)
    const ops = r.json.workspaces.find((w: Loose) => w.workspace === 'ops')
    expect(ops).toMatchObject({ enabled: true, state: 'on', allow: { billing: false }, updated_by: 'user1' })
    expect(ops.expires_at).toBe(expires.slice(0, 19).replace('T', ' '))
    expect(r.json.workspaces.find((w: Loose) => w.workspace === 'sales')).toMatchObject({ enabled: false, state: 'off' })
    expect(fullAccessActive('dev', 'ops')).toBe(true)
    expect(fullAccessActive('dev', 'sales')).toBe(false)
  })

  it('refuses a member, an agent key, an admin\'s Bearer JWT and a card session token — and writes nothing', async () => {
    const body = { enabled: true }
    const refusals = [
      await member('PUT', '/agents/dev/full-access/ops', body),
      await call('PUT', '/agents/dev/full-access/ops', { key: agentKey, body }),
      await call('PUT', '/agents/dev/full-access/ops', { bearer: tokenFor(ADMIN, 'admin'), body }),
      await call('PUT', '/agents/dev/full-access/ops', { session: mintSessionToken({ objectiveId: card('wake', 'ops', { agent: 'dev' }), workspace: 'ops', actingUserId: ADMIN }), body }),
    ]
    expect(refusals.map(r => r.status)).toEqual([403, 403, 403, 401])
    expect(refusals[0].json).toMatchObject({ code: 'admin_only' })
    expect(refusals[1].json).toMatchObject({ code: 'admin_only' })
    expect(fullAccessActive('dev', 'ops')).toBe(false)
    expect(auditRows()).toHaveLength(0)
    // An exclusion cannot be lifted by anyone but the admin either.
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true })
    const lift = await call('PUT', '/agents/dev/full-access/ops', { key: agentKey, body: { allow: { billing: true } } })
    expect(lift.status).toBe(403)
    expect((await admin('GET', '/agents/dev/full-access')).json.workspaces.find((w: Loose) => w.workspace === 'ops').allow.billing).toBe(false)
  })

  it('needs the workspace to be granted first, and validates the body', async () => {
    await admin('DELETE', '/agents/dev/workspaces/sales')
    expect(await admin('PUT', '/agents/dev/full-access/sales', { enabled: true })).toMatchObject({ status: 409, json: { code: 'workspace_not_granted' } })
    expect(await admin('PUT', '/agents/dev/full-access/ops', { enabled: true, expires_at: '2001-01-01T00:00:00Z' })).toMatchObject({ status: 400, json: { code: 'expiry_invalid' } })
    expect(await admin('PUT', '/agents/dev/full-access/ops', { allow: { nukes: true } })).toMatchObject({ status: 400, json: { code: 'allow_invalid' } })
    // Secret values, keys and DNS / Cloudflare Access have no switch: not even an admin can turn one on.
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true })
    for (const x of ['secret_values', 'keys', 'dns_access']) {
      expect(await admin('PUT', '/agents/dev/full-access/ops', { allow: { [x]: true } })).toMatchObject({ status: 400, json: { code: 'exclusion_permanent' } })
    }
    expect((await admin('GET', '/agents/dev/full-access')).json.workspaces.find((w: Loose) => w.workspace === 'ops').allow).toEqual({ billing: false })
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: false })
    getDb().prepare('DELETE FROM agent_chat_bot_full_access_audit').run()
    expect((await admin('PUT', '/agents/nope/full-access/ops', { enabled: true })).status).toBe(404)
    expect(auditRows()).toHaveLength(0)
  })
})

describe('every change is audit-logged', () => {
  it('records who, when, which bot and workspace, on or off, the expiry and each exclusion', async () => {
    const expires = new Date(Date.now() + 86_400_000).toISOString()
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true, expires_at: expires })
    await admin('PUT', '/agents/dev/full-access/ops', { allow: { billing: true } })
    await admin('PUT', '/agents/dev/full-access/ops', { expires_at: null })
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: false })
    const rows = auditRows()
    expect(rows.map(r => r.event)).toEqual(['enabled', 'exclusion_changed', 'expiry_changed', 'disabled'])
    for (const r of rows) {
      expect(r).toMatchObject({ slug: 'dev', workspace: 'ops', actor: 'user1', actor_user_id: ADMIN })
      expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    }
    expect(rows[0]).toMatchObject({ enabled: 1, expires_at: expires.slice(0, 19).replace('T', ' ') })
    expect(rows[1]).toMatchObject({ exclusion: 'billing', enabled: 1 })
    expect(rows[2]).toMatchObject({ enabled: 1, expires_at: null })
    expect(rows[3]).toMatchObject({ enabled: 0, expires_at: null })
    // The same history is returned to the settings panel, newest first, and is in the activity feed.
    const got = await admin('GET', '/agents/dev/full-access')
    expect(got.json.audit.map((a: Loose) => a.event)).toEqual(['disabled', 'expiry_changed', 'exclusion_changed', 'enabled'])
    const feed = activity('bot_full_access_changed')
    expect(feed).toHaveLength(4)
    expect(JSON.parse(feed[0].metadata)).toMatchObject({ slug: 'dev', workspace: 'ops', enabled: true, actor: 'user1' })
    // A no-op save logs nothing.
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: false })
    expect(auditRows()).toHaveLength(4)
  })
})

describe('what people see', () => {
  it('the bot list carries where a bot has Full access, only for workspaces the caller may see', async () => {
    const expires = new Date(Date.now() + 86_400_000).toISOString()
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true, expires_at: expires })
    await admin('PUT', '/agents/dev/full-access/sales', { enabled: true })
    const asAdmin = (await admin('GET', '/agents')).json.agents.find((a: Loose) => a.slug === 'dev')
    expect(asAdmin.full_access.workspaces).toEqual([
      { workspace: 'ops', expires_at: expires.slice(0, 19).replace('T', ' ') },
      { workspace: 'sales', expires_at: null },
    ])
    // The member belongs to ops only: no hint that sales exists.
    const asMember = (await member('GET', '/agents')).json.agents.find((a: Loose) => a.slug === 'dev')
    expect(asMember.full_access.workspaces.map((w: Loose) => w.workspace)).toEqual(['ops'])
    const panel = await member('GET', '/agents/dev/full-access')
    expect(panel.json.can_manage).toBe(false)
    expect(panel.json.workspaces.map((w: Loose) => w.workspace)).toEqual(['ops'])
    expect(panel.json.audit.every((a: Loose) => a.workspace === 'ops')).toBe(true)
  })

  it('a bot with Full access off carries an empty list', async () => {
    const dev = (await admin('GET', '/agents')).json.agents.find((a: Loose) => a.slug === 'dev')
    expect(dev.full_access).toEqual({ workspaces: [] })
  })
})

describe('revoking the workspace ends Full access', () => {
  it('on a single revoke and on replacing the list, with the reason logged', async () => {
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true })
    await admin('PUT', '/agents/dev/full-access/sales', { enabled: true })
    const r = await admin('DELETE', '/agents/dev/workspaces/ops')
    expect(r.json.full_access_switched_off).toEqual(['ops'])
    expect(fullAccessActive('dev', 'ops')).toBe(false)
    expect(fullAccessActive('dev', 'sales')).toBe(true)
    const set = await admin('PUT', '/agents/dev/workspaces', { workspaces: [] })
    expect(set.json.full_access_switched_off).toEqual(['sales'])
    expect(auditRows().filter(a => a.event === 'workspace_revoked').map(a => a.workspace)).toEqual(['ops', 'sales'])
    // Granting ops again does not bring it back.
    await admin('POST', '/agents/dev/workspaces', { workspace: 'ops' })
    expect(fullAccessActive('dev', 'ops')).toBe(false)
  })
})

describe('a card session of a Full access bot', () => {
  it('may message any card in its workspace; without Full access, or across workspaces, the one-hop rule stands', async () => {
    const wake = card('wake card', 'ops', { agent: 'dev' })
    // 'done' is a locked status: the message is accepted by the relationship check and then skipped, so no session is spawned here.
    const sameWs = card('someone else\'s card', 'ops', { status: 'done' })
    const otherWs = card('sales card', 'sales', { status: 'done' })
    const token = mintSessionToken({ objectiveId: wake, workspace: 'ops', actingUserId: ADMIN })
    const send = (to: number) => call('POST', `/objectives/${to}/message`, { base: '/api/internal', session: token, body: { message: 'please retry' } })

    expect((await send(sameWs)).status).toBe(403) // Full access is off: unrelated cards stay unreachable

    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true })
    const ok = await send(sameWs)
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ skipped: true, reason: 'locked_status' })
    expect(auditRows().filter(a => a.event === 'ability_used')).toHaveLength(1)
    expect(auditRows().find(a => a.event === 'ability_used')).toMatchObject({ slug: 'dev', workspace: 'ops', ability: 'card_comment', objective_id: sameWs, actor: 'bot:dev' })

    // Full access in sales too would still not let an ops card reach a sales card.
    await admin('PUT', '/agents/dev/full-access/sales', { enabled: true })
    expect((await send(otherWs)).status).toBe(403)

    // A self-declared sender (no token) never gets the Full access relation.
    const declared = await call('POST', `/objectives/${sameWs}/message`, { base: '/api/internal', body: { message: 'x', from_objective_id: wake } })
    expect(declared.status).toBe(403)
  })
})

describe('a card session asks what it carries, and takes a card over', () => {
  const tokenOf = (id: number, ws = 'ops') => mintSessionToken({ objectiveId: id, workspace: ws, actingUserId: ADMIN })
  const status = (session?: string) => call('GET', '/full-access', { base: '/api/internal', session })
  const takeOver = (id: number, session?: string) => call('POST', `/full-access/cards/${id}/take-over`, { base: '/api/internal', session, body: { note: 'stuck for two days' } })

  it('says false until Full access is on, then true with the exclusion switches', async () => {
    const wake = card('wake', 'ops', { agent: 'dev' })
    expect((await status()).status).toBe(401)
    expect((await status(tokenOf(wake))).json).toEqual({ card: wake, workspace: 'ops', bot: 'dev', full_access: false })
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true, allow: { billing: true } })
    expect((await status(tokenOf(wake))).json).toMatchObject({
      card: wake, workspace: 'ops', bot: 'dev', full_access: true, expires_at: null,
      billing_switched_on: true, never_allowed: ['secret_values', 'keys', 'dns_access'],
    })
    // A card worked by someone else carries nothing, whatever the bot has.
    const plain = card('plain', 'ops', { agent: 'general' })
    expect((await status(tokenOf(plain))).json.full_access).toBe(false)
  })

  it('takes over a card in its workspace only while Full access is on, and logs it', async () => {
    const wake = card('wake 2', 'ops', { agent: 'dev' })
    const theirs = card('their card', 'ops', { agent: 'general' })
    const elsewhere = card('sales card 2', 'sales', { agent: 'general' })
    const worker = (id: number) => getDb().prepare('SELECT agent_context, owner_bot FROM objectives WHERE id = ?').get(id)

    expect((await takeOver(theirs)).status).toBe(401) // no token
    expect((await takeOver(theirs, tokenOf(wake))).status).toBe(403) // Full access is off
    expect(worker(theirs)).toEqual({ agent_context: 'general', owner_bot: null })
    expect(auditRows().filter(a => a.event === 'ability_refused')).toHaveLength(1)

    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true })
    const ok = await takeOver(theirs, tokenOf(wake))
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ id: theirs, agent_context: 'dev', owner_bot: 'Operation Kit Dev', previous_agent: 'general' })
    expect(worker(theirs)).toEqual({ agent_context: 'dev', owner_bot: 'Operation Kit Dev' })
    const used = auditRows().filter(a => a.event === 'ability_used')
    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({ slug: 'dev', workspace: 'ops', ability: 'card_take_over', objective_id: theirs, actor: 'bot:dev' })
    expect(used[0].detail).toContain('stuck for two days')

    // Another workspace stays out of reach, even with Full access on there too; so does a card that does not exist.
    await admin('PUT', '/agents/dev/full-access/sales', { enabled: true })
    expect((await takeOver(elsewhere, tokenOf(wake))).status).toBe(403)
    expect(worker(elsewhere)).toEqual({ agent_context: 'general', owner_bot: null })
    expect((await takeOver(987_654, tokenOf(wake))).status).toBe(403)
  })
})

describe('a card session and the protected pull request (PR 645)', () => {
  const tokenOf = (id: number) => mintSessionToken({ objectiveId: id, workspace: 'ops', actingUserId: ADMIN })

  it('take-over of the card that carries PR 645 is refused and logged; the card is untouched', async () => {
    const wake = card('wake 645', 'ops', { agent: 'dev' })
    const guarded = card('the 645 card', 'ops', { agent: 'general', pr: 645 })
    const other = card('a 646 card', 'ops', { agent: 'general', pr: 646 })
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true })
    const r = await call('POST', `/full-access/cards/${guarded}/take-over`, { base: '/api/internal', session: tokenOf(wake), body: {} })
    expect(r.status).toBe(403)
    expect(r.json).toMatchObject({ code: 'protected_pr' })
    expect(r.json.error).toMatch(/pull request 645, which is protected/)
    expect(getDb().prepare('SELECT agent_context, owner_bot FROM objectives WHERE id = ?').get(guarded)).toEqual({ agent_context: 'general', owner_bot: null })
    const rows = auditRows().filter(a => a.event === 'protected_refused')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slug: 'dev', workspace: 'ops', ability: 'card_take_over', objective_id: guarded, actor: 'bot:dev' })
    expect(auditRows().filter(a => a.event === 'ability_used')).toHaveLength(0)
    // Any other PR is not protected.
    expect((await call('POST', `/full-access/cards/${other}/take-over`, { base: '/api/internal', session: tokenOf(wake), body: {} })).status).toBe(200)
  })

  it('the Full access branch of /message refuses the card that carries PR 645, and logs it', async () => {
    const wake = card('wake 645 b', 'ops', { agent: 'dev' })
    const guarded = card('the 645 card b', 'ops', { status: 'done', pr: 645 })
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true })
    const r = await call('POST', `/objectives/${guarded}/message`, { base: '/api/internal', session: tokenOf(wake), body: { message: 'restart and push' } })
    expect(r.status).toBe(403)
    expect(r.json).toMatchObject({ code: 'protected_pr', to_objective_id: guarded })
    const rows = auditRows().filter(a => a.event === 'protected_refused')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slug: 'dev', workspace: 'ops', ability: 'card_comment', objective_id: guarded })
    expect(auditRows().filter(a => a.event === 'ability_used')).toHaveLength(0)
  })
})

describe('a member-created card assigned to an admin', () => {
  it('carries no Full access: status says false, take-over and messaging are refused', async () => {
    const made = card('filed by a member', 'ops', { agent: 'dev', createdBy: MEMBER, assignee: ADMIN })
    const theirs = card('someone else\'s', 'ops', { agent: 'general', status: 'done' })
    await admin('PUT', '/agents/dev/full-access/ops', { enabled: true })
    const token = mintSessionToken({ objectiveId: made, workspace: 'ops', actingUserId: ADMIN })
    expect((await call('GET', '/full-access', { base: '/api/internal', session: token })).json).toEqual({ card: made, workspace: 'ops', bot: 'dev', full_access: false })
    expect((await call('POST', `/full-access/cards/${theirs}/take-over`, { base: '/api/internal', session: token, body: {} })).status).toBe(403)
    expect(getDb().prepare('SELECT agent_context FROM objectives WHERE id = ?').get(theirs)).toEqual({ agent_context: 'general' })
    expect((await call('POST', `/objectives/${theirs}/message`, { base: '/api/internal', session: token, body: { message: 'x' } })).status).toBe(403)
    expect(auditRows().filter(a => a.event === 'ability_used')).toHaveLength(0)
    // The same card created by the admin does carry it (the control).
    const byAdmin = card('filed by the admin', 'ops', { agent: 'dev' })
    expect((await call('GET', '/full-access', { base: '/api/internal', session: mintSessionToken({ objectiveId: byAdmin, workspace: 'ops', actingUserId: ADMIN }) })).json.full_access).toBe(true)
  })
})

describe('the High Agency wake brief', () => {
  it('tells the wake to check its Full access, and what that never covers', async () => {
    const { buildHighAgencyBrief } = await import('../services/agent-chat/high-agency.js')
    const brief = buildHighAgencyBrief(
      { slug: 'dev', name: 'Operation Kit Dev', description: '', system_prompt: 'You build.', knowledge_folders: [] },
      { level: 2, workspace: 'ops', allow_cards: true, allow_workflows: true },
    )
    expect(brief).toContain('## If an admin gave you Full access here')
    expect(brief).toContain('curl -s http://localhost:3002/api/internal/full-access -H "X-CC-Session-Token: $CC_SESSION_TOKEN"')
    expect(brief).toContain('/api/internal/full-access/cards/<id>/take-over')
    expect(brief).toContain('it never approves a merge, a prod migration or a deploy')
    // The standing limits are still there, after it.
    expect(brief.indexOf('## If an admin gave you Full access here')).toBeLessThan(brief.indexOf('## Limits on a wake'))
    expect(brief).toContain('Never send email or messages to people, spend money, merge, deploy')
  })
})
