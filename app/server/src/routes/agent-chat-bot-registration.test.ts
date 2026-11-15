/**
 * obj 900862 — "Approve on my behalf" works for EVERY bot, with no hand-edited
 * settings row, over the real routers:
 *
 *  - EVERY chat bot has a grantable identity automatically: an install's own
 *    CTO chat bot (`your-org-cto`) that the stored registry does not know
 *    (the public/OVH build's name-scrubbed registry has no "Example CTO" alias)
 *    is linked to the shipped CTO bot; "Operation Kit Dev" gets its own. The
 *    owner grants Example CTO merge / prod migration / deploy on your-org —
 *    each separately, with an expiry — with NO register click and NO settings
 *    write, and a CTO approval naming "Example CTO" is accepted under that grant
 *    only;
 *  - the one-click register route stays as a fallback / pin: only the owner's
 *    browser click registers; an agent key / Bearer JWT / team member is
 *    refused; an already-registered bot is a 409; it writes ONLY
 *    settings.bot_registry_additions, never bot_registry / bot_agent_slugs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-registration-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-bot-registration'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-registration-agents-'))
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
const { BUILT_IN_BOTS } = await import('../services/bots/bot-registry.js')
const { TEMPLATE_PLACEHOLDER } = await import('../services/bots/install-slugs.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: agentChatRouter } = await import('./agent-chat.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const MEMBER = 2
// The live install's CTO bot is `your-org-cto`. The OSS name-scrub rewrites
// this org slug to the template placeholder, which IS the shipped CTO bot's own
// slug, so the public tree runs the same flow under a neutral org instead.
const ORG: string = 'your-org'
const CTO_SLUG = ORG === TEMPLATE_PLACEHOLDER ? 'acme-cto' : `${ORG}-cto`
const DEV_SLUG = 'operation-kit-dev'
const OTHER_SLUG = 'research-desk'
const WS = ORG
const SESSION = 'cc-900862-1'
let server: http.Server
let baseUrl: string
let botKey = ''
let card = 0
let okCard = 0

/**
 * The public (OVH) build's registry: the OSS name-scrub removes the org's own
 * aliases ("Example CTO"), so an install's localized CTO bot is unknown to it.
 * Written as settings.bot_registry here to reproduce that build in this repo.
 */
const SCRUBBED_REGISTRY = JSON.stringify(
  BUILT_IN_BOTS.map(b => ({ ...b, aliases: b.aliases.filter(a => !/example/i.test(a)) })),
)

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
const grantsUrl = (slug: string) => `/api/agent-chat/agents/${slug}/delegations`
const registerUrl = (slug: string) => `/api/agent-chat/agents/${slug}/registry`

function setting(key: string): string | null {
  return (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}
function setSetting(key: string, value: string | null) {
  if (value === null) getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
  else getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
const flush = () => new Promise(r => setTimeout(r, 20))

function writeAgent(slug: string, name: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${name}\nsystem_prompt: You help.\n`)
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'teammate', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, 'Example Growth'), ('operationkit', 'Operation Kit')`).run(WS)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, ?, 'admin'), (1, 'operationkit', 'admin'), (2, ?, 'member')`).run(WS, WS)
  card = Number(db.prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id) VALUES ('ship it', 'cto', ?, 1, 'review', ?)`).run(WS, SESSION).lastInsertRowid)
  writeAgent(CTO_SLUG, 'Example CTO')
  writeAgent(DEV_SLUG, 'Operation Kit Dev')
  writeAgent(OTHER_SLUG, 'Research Desk')
  okCard = Number(db.prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id) VALUES ('ship opkit', 'dev', 'operationkit', 1, 'review', 'cc-900862-2')`).run().lastInsertRowid)
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
  setSetting('bot_registry', SCRUBBED_REGISTRY)
  setSetting('bot_agent_slugs', null)
  setSetting('bot_registry_additions', null)
})

describe('every bot is registered automatically — no register click, no settings row (acceptance change 2026-11-14 22:56 ET)', () => {
  it('Example CTO, unknown to the stored registry: GET already has the bot (linked to the shipped CTO) and the grant form options', async () => {
    const r = await asOwner('GET', grantsUrl(CTO_SLUG))
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ bot: { id: 'Grok: CTO', name: 'CTO' }, bot_auto: { linked: true }, can_manage: true })
    expect(r.json.registration).toBeUndefined()
    expect(r.json.bot_unavailable_reason).toBeUndefined()
    expect(r.json.workspace_options.map((w: Loose) => w.slug)).toContain(WS)
    // Reading it wrote nothing.
    expect(setting('bot_registry_additions')).toBeNull()
  })

  it('Operator grants Example CTO on your-org with no registration step (each action separately, with expiry); settings untouched', async () => {
    const operatorRows = { bot_registry: setting('bot_registry'), bot_agent_slugs: setting('bot_agent_slugs') }

    // Each action is its own switch: a prod-migration-only grant, then a merge+deploy grant.
    const expiresAt = inDays(7)
    const g1 = await asOwner('POST', grantsUrl(CTO_SLUG), { workspace: WS, actions: ['prod_migration'], expires_at: expiresAt })
    expect(g1.status).toBe(201)
    expect(g1.json.created).toMatchObject({ bot_name: 'Grok: CTO', agent_slug: CTO_SLUG, workspace: WS, actions: ['prod_migration'], state: 'active' })
    expect(Date.parse(g1.json.created.expires_at.replace(' ', 'T') + 'Z')).toBeGreaterThan(Date.now() + 6 * 86_400_000)

    // The CTO approving a merge is refused: that action was not ticked.
    const merge = await asBot('POST', `/api/objectives/${card}/message`, { message: 'merge it', approval: 'merge', owner_bot: 'Example CTO' })
    expect(merge.status).toBe(403)
    expect(merge.json.code).toBe('no_active_grant')

    // ...and its prod-migration approval, naming itself "Example CTO" (unknown to the stored registry), is accepted.
    const mig = await asBot('POST', `/api/objectives/${card}/message`, { message: 'run the migration', approval: 'prod_migration', owner_bot: 'Example CTO' })
    expect(mig.status).toBe(200)
    await flush()
    const [, , , opts] = sendFollowUpMock.mock.calls.at(-1)! as [string, string, unknown, { sender: Loose }]
    expect(opts.sender).toMatchObject({ kind: 'delegated', delegation: { grant_id: g1.json.created.id, action: 'prod_migration', bot: 'Grok: CTO' } })

    const g2 = await asOwner('POST', grantsUrl(CTO_SLUG), { workspace: WS, actions: ['merge', 'deploy'], expires_at: inDays(30) })
    expect(g2.status).toBe(201)
    expect(g2.json.grants.filter((g: Loose) => g.state === 'active')).toHaveLength(2)
    const viaSlug = await asBot('POST', `/api/objectives/${card}/message`, { message: 'merge now', approval: 'merge', owner_bot: CTO_SLUG })
    expect(viaSlug.status).toBe(200)

    // A name that is neither a registry bot nor an installed chat bot is still refused.
    const nobody = await asBot('POST', `/api/objectives/${card}/message`, { message: 'merge', approval: 'merge', owner_bot: 'Nobody Bot' })
    expect(nobody.status).toBe(403)
    expect(nobody.json.code).toBe('unknown_bot')

    // Nothing was written to any registry setting.
    expect(setting('bot_registry')).toBe(operatorRows.bot_registry)
    expect(setting('bot_agent_slugs')).toBe(operatorRows.bot_agent_slugs)
    expect(setting('bot_registry_additions')).toBeNull()
  })

  it('Operation Kit Dev (no shipped bot to link to) gets its own identity and its deploy approval is accepted', async () => {
    const before = await asOwner('GET', grantsUrl(DEV_SLUG))
    expect(before.json).toMatchObject({ bot: { id: 'Operation Kit Dev', name: 'Operation Kit Dev' }, bot_auto: { linked: false } })
    const g = await asOwner('POST', grantsUrl(DEV_SLUG), { workspace: 'operationkit', actions: ['deploy'], expires_at: inDays(1) })
    expect(g.status).toBe(201)
    expect(g.json.created).toMatchObject({ bot_name: 'Operation Kit Dev', workspace: 'operationkit', actions: ['deploy'] })
    const ok = await asBot('POST', `/api/objectives/${okCard}/message`, { message: 'deploy', approval: 'deploy', owner_bot: 'Operation Kit Dev' })
    expect(ok.status).toBe(200)
    // Not the CTO's grant: the CTO has none in operationkit.
    const cto = await asBot('POST', `/api/objectives/${okCard}/message`, { message: 'deploy', approval: 'deploy', owner_bot: 'Example CTO' })
    expect(cto.status).toBe(403)
    expect(setting('bot_registry_additions')).toBeNull()
  })

  it('EVERY bot in the sidebar has a grantable identity (Example CTO, Operation Kit Dev, Research Desk)', async () => {
    const list = await asOwner('GET', '/api/agent-chat/agents')
    const slugs: string[] = list.json.agents.map((a: Loose) => a.slug)
    expect(slugs).toEqual(expect.arrayContaining([CTO_SLUG, DEV_SLUG, OTHER_SLUG]))
    for (const slug of slugs) {
      const r = await asOwner('GET', grantsUrl(slug))
      expect(r.status, slug).toBe(200)
      expect(r.json.bot, slug).not.toBeNull()
      expect(r.json.can_manage, slug).toBe(true)
      expect(r.json.workspace_options.length, slug).toBeGreaterThan(0)
    }
  })
})

describe('the one-click register route stays as the fallback / pin', () => {
  it('registering twice is a 409, and an unknown link target is a 400', async () => {
    expect((await asOwner('POST', registerUrl(CTO_SLUG), { bot: 'No Such Bot' })).status).toBe(400)
    expect((await asOwner('POST', registerUrl(CTO_SLUG), { bot: 'Grok: CTO' })).status).toBe(201)
    const again = await asOwner('POST', registerUrl(CTO_SLUG), {})
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('already_registered')
  })

  it('only the owner in the browser can register: agent key, Bearer JWT and a team member are refused', async () => {
    expect((await asBot('POST', registerUrl(CTO_SLUG), { bot: 'Grok: CTO' })).status).toBe(403)
    expect((await call('POST', registerUrl(CTO_SLUG), { Authorization: ownerBearer() }, { bot: 'Grok: CTO' })).status).toBe(403)
    expect((await call('POST', registerUrl(CTO_SLUG), { Cookie: cookie(MEMBER, 'member', 'teammate') }, { bot: 'Grok: CTO' })).status).toBe(403)
    expect(setting('bot_registry_additions')).toBeNull()
    // A Bearer admin sees the bot but cannot manage grants.
    const bearerView = await call('GET', grantsUrl(CTO_SLUG), { Authorization: ownerBearer() })
    expect(bearerView.json).toMatchObject({ bot: { id: 'Grok: CTO' }, can_manage: false })
  })

  it('an unknown agent slug is a 404', async () => {
    expect((await asOwner('POST', registerUrl('no-such-bot'), {})).status).toBe(404)
  })
})

describe('on this build (registry knows "Example CTO"), the CTO bot is grantable with no registration step', () => {
  it('GET shows the registry bot straight away and Operator grants it on your-org', async () => {
    setSetting('bot_registry', null)
    const r = await asOwner('GET', grantsUrl(CTO_SLUG))
    expect(r.json).toMatchObject({ bot: { id: 'Grok: CTO' }, can_manage: true })
    expect(r.json.registration).toBeUndefined()
    const g = await asOwner('POST', grantsUrl(CTO_SLUG), { workspace: WS, actions: ['merge', 'prod_migration', 'deploy'], expires_at: inDays(7) })
    expect(g.status).toBe(201)
    expect(g.json.created).toMatchObject({ bot_name: 'Grok: CTO', workspace: WS, actions: ['merge', 'prod_migration', 'deploy'] })
  })
})
