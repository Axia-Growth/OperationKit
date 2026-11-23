/**
 * Per-bot secret access (obj 901484), over real HTTP against a temp DB, with the
 * chat secret tool run for real against a fake vendor.
 *
 *   - an admin gives ONE bot read access to FIVE secrets from one screen with
 *     one save, and that save also switches the bot's secrets tool on; a member,
 *     an agent key and an admin's Bearer token are refused and write nothing;
 *   - a bot without the grant cannot use the secret, and a second bot in the
 *     same workspace gains nothing;
 *   - a suggested host is shown, never saved until the admin sends it back;
 *   - read only refuses write methods; read and write allows them;
 *   - the All secrets switch: every Workspace secret with a confirmed host,
 *     also one added later; a key with no host stays unusable; off ends it at once;
 *   - Test access gives the right reason per failure and never a value;
 *   - an old workspace-wide Bot access entry still works unchanged;
 *   - every grant, removal and switch change is in the secrets audit log.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-bot-secret-access-routes'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-secret-access-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59951' // a dead port: nothing here may reach a live install
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.CC_REDACT_ENV_FILES = ''
process.env.CC_SECRETS_BROKER_RATE_PER_MIN = '1000'
delete process.env.CC_SECRETS_BROKER_POLICY
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-secret-access-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { setSecret } = await import('../services/secrets-store.js')
const { resetRateLimits } = await import('../services/file-access.js')
const { setBrokerFetchForTests, setBrokerPolicyEntry, getBrokerPolicy } = await import('../services/secrets-broker.js')
const { runChatTool } = await import('../services/agent-chat/tools.js')
const { findAgent } = await import('../services/agent-chat/engine.js')
const { KNOWN_VENDOR_HOSTS } = await import('../services/agent-chat/bot-secret-access.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const MEMBER = 2
const WS = 'growth'
// The GTM Engineer case: five vendor keys, all saved at Workspace scope.
const FIVE = ['APIFY_API_TOKEN', 'HUNTER_API_KEY', 'EXA_API_KEY', 'ACME_API_KEY', 'ZETA_API_KEY'] as const
const HOSTS: Record<string, string> = {
  APIFY_API_TOKEN: 'api.apify.com', HUNTER_API_KEY: 'api.hunter.io', EXA_API_KEY: 'api.exa.ai',
  ACME_API_KEY: 'api.acme.example', ZETA_API_KEY: 'api.zeta.example',
}
const VALUES: Record<string, string> = Object.fromEntries(FIVE.map((n, i) => [n, `value_${i}_${n.toLowerCase()}_0123456789`]))
VALUES.ACME_BASE_URL = 'https://api.acme.example/v2/'
VALUES.OLD_API_KEY = 'old_workspace_wide_value_0123456789'
VALUES.SHARED_API_KEY = 'shared_install_value_0123456789'
VALUES.LATER_API_KEY = 'added_later_value_0123456789abc'
VALUES.TINY_KEY = 'tny7'
const SECRET_VALUES = Object.entries(VALUES).filter(([n]) => n !== 'ACME_BASE_URL').map(([, v]) => v)
const noValues = (x: unknown) => { const s = JSON.stringify(x); for (const v of SECRET_VALUES) expect(s).not.toContain(v) }

let server: http.Server
let baseUrl: string
let agentKey = ''
let sent: { url: string; init: RequestInit }[] = []

function tokenFor(id: number, role: string) {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}
async function call(method: string, p: string, opts: { as?: number; role?: string; body?: unknown; key?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`
  else if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.as) headers.Cookie = `token=${tokenFor(opts.as, opts.role ?? 'member')}`
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json, text }
}
const admin = (method: string, p: string, body?: unknown) => call(method, p, { as: ADMIN, role: 'admin', body })

const ctx = (slug: string, workspace = WS): Loose => ({
  userId: ADMIN, username: 'user1', workspace, agent: findAgent(slug)!, kbRoot: os.tmpdir(), connectors: { mail: null, calendar: null },
})
/** One chat secret call by the bot. Resolves to the tool result, or the refusal text. */
async function use(slug: string, name: string, host: string, method = 'GET'): Promise<{ ok: boolean; text: string }> {
  try {
    const out = await runChatTool(ctx(slug), 'secret_http', { method, url: `https://${host}/v1/things`, headers: { Authorization: `Bearer {{secret:${name}}}` } })
    return { ok: true, text: JSON.stringify(out) }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) }
  }
}
const grantsFor = (names: readonly string[], methods?: string[]) => names.map(name => ({ name, hosts: [HOSTS[name]], ...(methods ? { methods } : {}) }))
const grantRows = () => getDb().prepare('SELECT * FROM agent_chat_bot_secret_grants ORDER BY slug, secret_name').all() as Loose[]
let auditFrom = 0 // the log is append-only, so each test reads only its own rows
const audit = () => getDb().prepare("SELECT * FROM secret_access_log WHERE action = 'bot_access' AND id > ? ORDER BY id").all(auditFrom) as Loose[]
const panel = async (slug = 'gtm') => (await admin('GET', `/agents/${slug}/secret-access?workspace=${WS}`)).json.secret_access as Loose
const row = (p: Loose, name: string) => p.secrets.find((s: Loose) => s.name === name)
const test = async (slug = 'gtm') => (await admin('POST', `/agents/${slug}/secret-access/test`, { workspace: WS })).json.test as Loose
const result = (t: Loose, name: string) => t.results.find((r: Loose) => r.name === name)

function writeBot(slug: string, name: string, tools: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${name}\nsystem_prompt: You help.\ntools: [${tools}]\n`)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user1', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(MEMBER)
  for (const ws of [WS, 'other']) db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(ws, ws)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, ?, 'member', 'all')`).run(MEMBER, WS)
  // gtm starts WITHOUT the secrets tool; rival already has it (the "second bot").
  writeBot('gtm', 'GTM Engineer', 'list_objectives')
  writeBot('rival', 'Rival Bot', 'list_objectives, secrets')
  for (const n of FIVE) setSecret({ scope: { scopeType: 'workspace', workspace: WS }, key: n, value: VALUES[n] })
  setSecret({ scope: { scopeType: 'workspace', workspace: WS }, key: 'ACME_BASE_URL', value: VALUES.ACME_BASE_URL })
  setSecret({ scope: { scopeType: 'workspace', workspace: WS }, key: 'OLD_API_KEY', value: VALUES.OLD_API_KEY })
  setSecret({ scope: { scopeType: 'workspace', workspace: WS }, key: 'TINY_KEY', value: VALUES.TINY_KEY })
  setSecret({ scope: { scopeType: 'global' }, key: 'SHARED_API_KEY', value: VALUES.SHARED_API_KEY })
  // An OLD workspace-wide Bot access entry, made in Settings → Secrets before this card.
  setBrokerPolicyEntry('OLD_API_KEY', { hosts: ['api.old.example'], methods: ['GET'] })
  const k = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'some-bot' })
  if (!k.ok) throw new Error(k.error)
  agentKey = k.key.token
  setBrokerFetchForTests(async (url, init) => {
    sent.push({ url, init })
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  setBrokerFetchForTests(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(async () => {
  const db = getDb()
  for (const t of ['agent_chat_bot_secret_grants', 'agent_chat_bot_secret_all', 'agent_chat_secret_hosts', 'agent_chat_bot_config', 'agent_chat_bot_access', 'agent_chat_bot_workspaces', 'agent_chat_bot_full_access']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  auditFrom = (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM secret_access_log').get() as { n: number }).n
  db.prepare("DELETE FROM secrets WHERE key = 'LATER_API_KEY'").run()
  resetRateLimits()
  sent = []
  for (const slug of ['gtm', 'rival']) expect((await admin('PUT', `/agents/${slug}/workspaces`, { workspaces: [WS] })).status).toBe(200)
})

describe('one screen, one save', () => {
  it('an admin gives one bot read access to five secrets with ONE save, and the tool comes on with it', async () => {
    expect(findAgent('gtm')!.tools).not.toContain('secrets')
    const before = await use('gtm', 'APIFY_API_TOKEN', HOSTS.APIFY_API_TOKEN)
    expect(before.ok).toBe(false)

    const r = await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: grantsFor(FIVE) })
    expect(r.status).toBe(200)
    expect(r.json.saved.added.sort()).toEqual([...FIVE].sort())
    expect(r.json.saved.tool_switched_on).toBe(true)
    expect(findAgent('gtm')!.tools).toContain('secrets')
    expect(findAgent('gtm')!.tools).toContain('list_objectives') // nothing else was lost
    noValues(r.json)

    for (const n of FIVE) {
      const ok = await use('gtm', n, HOSTS[n])
      expect(ok.ok, `${n}: ${ok.text}`).toBe(true)
      noValues(ok.text)
    }
    expect(sent).toHaveLength(5)
    // The real value went out, only on the outgoing request to that key's own host.
    expect((sent[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${VALUES.APIFY_API_TOKEN}`)
    expect(new URL(sent[0].url).host).toBe('api.apify.com')

    // Read only is the default: every grant is GET + HEAD and a write is refused.
    for (const g of grantRows()) expect(JSON.parse(g.methods)).toEqual(['GET', 'HEAD'])
    const post = await use('gtm', 'HUNTER_API_KEY', HOSTS.HUNTER_API_KEY, 'POST')
    expect(post.ok).toBe(false)
    expect(post.text).toMatch(/method POST is not allowed/)
    // …and a key never goes to another key's host.
    const wrongHost = await use('gtm', 'HUNTER_API_KEY', 'api.apify.com')
    expect(wrongHost.ok).toBe(false)
    expect(sent).toHaveLength(5)
  })

  it('refuses a member, an agent key and an admin Bearer token, and writes nothing', async () => {
    const body = { workspace: WS, grants: grantsFor(FIVE), all_secrets: { enabled: true, mode: 'write' } }
    const refusals = [
      await call('PUT', '/agents/gtm/secret-access', { as: MEMBER, role: 'member', body }),
      await call('PUT', '/agents/gtm/secret-access', { key: agentKey, body }),
      await call('PUT', '/agents/gtm/secret-access', { bearer: tokenFor(ADMIN, 'admin'), body }),
      await call('PUT', '/agents/gtm/secret-access', { body }),
    ]
    for (const r of refusals) expect([401, 403]).toContain(r.status)
    expect(grantRows()).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_chat_bot_secret_all').get()).toEqual({ n: 0 })
    expect(audit()).toHaveLength(0)
    expect(findAgent('gtm')!.tools).not.toContain('secrets')
    // A member cannot read the list of secret names or run Test access either.
    expect((await call('GET', `/agents/gtm/secret-access?workspace=${WS}`, { as: MEMBER, role: 'member' })).status).toBe(403)
    expect((await call('POST', '/agents/gtm/secret-access/test', { as: MEMBER, role: 'member', body: { workspace: WS } })).status).toBe(403)
  })

  it('a second bot in the same workspace gains nothing, even with the tool already on', async () => {
    await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: grantsFor(FIVE) })
    expect(findAgent('rival')!.tools).toContain('secrets')
    for (const n of FIVE) {
      const r = await use('rival', n, HOSTS[n])
      expect(r.ok).toBe(false)
      expect(r.text).toMatch(/no allowed destination hosts/)
    }
    expect(sent).toHaveLength(0)
    const p = await panel('rival')
    for (const n of FIVE) expect(row(p, n).status).toMatchObject({ usable: false, reason: 'no_host' })
    // The workspace-wide Bot access setting was not touched by the per-bot save.
    expect(Object.keys(getBrokerPolicy())).toEqual(['OLD_API_KEY'])
  })

  it('removing a tick removes the access on the next call, and both are audited by name', async () => {
    await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: grantsFor(FIVE) })
    const r = await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: grantsFor(FIVE.slice(0, 4)) })
    expect(r.json.saved).toMatchObject({ added: [], changed: [], removed: ['ZETA_API_KEY'] })
    expect((await use('gtm', 'ZETA_API_KEY', HOSTS.ZETA_API_KEY)).ok).toBe(false)
    expect((await use('gtm', 'EXA_API_KEY', HOSTS.EXA_API_KEY)).ok).toBe(true)

    const log = audit()
    const granted = log.filter(l => / granted /.test(l.detail))
    expect(granted.map(l => l.key).sort()).toEqual([...FIVE].sort())
    const apify = granted.find(l => l.key === 'APIFY_API_TOKEN')
    expect(apify).toMatchObject({ actor_user_id: ADMIN, scope: `bot:gtm@${WS}` })
    expect(apify.detail).toBe(`bot=gtm workspace=${WS} granted hosts=api.apify.com methods=GET,HEAD`)
    expect(log.find(l => l.key === 'ZETA_API_KEY' && / removed$/.test(l.detail))).toBeTruthy()
    expect(log.find(l => /tool "Use secrets by name" switched on/.test(l.detail))).toBeTruthy()
    noValues(log)
  })
})

describe('suggested hosts', () => {
  it('are shown with where they came from, and are never saved unless the admin sends them back', async () => {
    const p = await panel()
    expect(row(p, 'APIFY_API_TOKEN').suggestions).toEqual([{ host: KNOWN_VENDOR_HOSTS.APIFY, source: 'known_vendor' }])
    // From the matching *_BASE_URL secret: the host only, never the path.
    expect(row(p, 'ACME_API_KEY').suggestions).toEqual([{ host: 'api.acme.example', source: 'url_secret', from: 'ACME_BASE_URL' }])
    expect(row(p, 'OLD_API_KEY').suggestions[0]).toEqual({ host: 'api.old.example', source: 'bot_access' })
    expect(JSON.stringify(p)).not.toContain('/v2')
    noValues(p)
    // Opening the panel wrote nothing.
    expect(grantRows()).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_chat_secret_hosts').get()).toEqual({ n: 0 })

    // A tick with no host is refused whole: the server does not fill in the suggestion.
    for (const grants of [[{ name: 'APIFY_API_TOKEN' }], [{ name: 'APIFY_API_TOKEN', hosts: [] }], [...grantsFor(['EXA_API_KEY']), { name: 'APIFY_API_TOKEN', hosts: '' }]]) {
      const r = await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants })
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(/confirm a destination host/)
    }
    expect(grantRows()).toHaveLength(0)
    expect(findAgent('gtm')!.tools).not.toContain('secrets')
    // All secrets with unconfirmed hosts does not apply a suggestion either.
    await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: [], all_secrets: { enabled: true } })
    expect((await use('gtm', 'APIFY_API_TOKEN', KNOWN_VENDOR_HOSTS.APIFY)).ok).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('a wildcard, an IP address, a URL and a server-only name are refused', async () => {
    const bad = (grants: unknown, hosts?: unknown) => admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants, ...(hosts ? { hosts, all_secrets: { enabled: true } } : {}) })
    expect((await bad([{ name: 'ACME_API_KEY', hosts: ['*.acme.example'] }])).json.error).toMatch(/wildcard/)
    expect((await bad([{ name: 'ACME_API_KEY', hosts: ['10.0.0.5'] }])).status).toBe(400)
    expect((await bad([{ name: 'ACME_API_KEY', hosts: ['https://api.acme.example/x'] }])).status).toBe(400)
    expect((await bad([{ name: 'NOPE_API_KEY', hosts: ['api.acme.example'] }])).json.error).toMatch(/No secret named/)
    expect((await bad([], [{ name: 'ACME_API_KEY', hosts: ['*.acme.example'] }])).json.error).toMatch(/wildcard/)
    expect((await bad([], [{ name: 'SHARED_API_KEY', hosts: ['api.shared.example'] }])).json.error).toMatch(/Shared secret/)
    expect(grantRows()).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_chat_bot_secret_all').get()).toEqual({ n: 0 })
  })
})

describe('read only and read-and-write', () => {
  it('write methods need an explicit choice per key', async () => {
    await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: [...grantsFor(['EXA_API_KEY']), ...grantsFor(['ACME_API_KEY'], ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])] })
    expect((await use('gtm', 'EXA_API_KEY', HOSTS.EXA_API_KEY, 'POST')).ok).toBe(false)
    expect((await use('gtm', 'ACME_API_KEY', HOSTS.ACME_API_KEY, 'POST')).ok).toBe(true)
    const p = await panel()
    expect(row(p, 'EXA_API_KEY').grant.mode).toBe('read')
    expect(row(p, 'ACME_API_KEY').grant.mode).toBe('write')
  })
})

describe('All secrets switch', () => {
  const confirmAll = (names: readonly string[]) => names.map(name => ({ name, hosts: [HOSTS[name]] }))

  it('one tick + one save: every Workspace secret with a host, and one added later, for THIS bot only', async () => {
    const r = await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: [], all_secrets: { enabled: true }, hosts: confirmAll(FIVE) })
    expect(r.status).toBe(200)
    expect(r.json.saved).toMatchObject({ all_secrets: 'on_read', tool_switched_on: true })
    expect(r.json.saved.hosts_confirmed.sort()).toEqual([...FIVE].sort())
    expect(r.json.secret_access.all_secrets).toEqual({ enabled: true, mode: 'read' }) // no mode sent = read only
    expect(grantRows()).toHaveLength(0) // no per-key ticks were needed

    for (const n of FIVE) expect((await use('gtm', n, HOSTS[n])).ok, n).toBe(true)
    // Read only refuses a write; "every key" is not "any host".
    expect((await use('gtm', 'EXA_API_KEY', HOSTS.EXA_API_KEY, 'DELETE')).ok).toBe(false)
    expect((await use('gtm', 'EXA_API_KEY', 'api.hunter.io')).ok).toBe(false)
    // The second bot is unchanged, although the hosts are now confirmed for the workspace.
    for (const n of FIVE) expect((await use('rival', n, HOSTS[n])).ok).toBe(false)

    // A secret added AFTER the switch: no click on the bot. Its host is confirmed once (per key).
    setSecret({ scope: { scopeType: 'workspace', workspace: WS }, key: 'LATER_API_KEY', value: VALUES.LATER_API_KEY })
    const noHost = await use('gtm', 'LATER_API_KEY', 'api.later.example')
    expect(noHost.ok).toBe(false)
    const p = await panel()
    expect(p.needs_host).toContain('LATER_API_KEY')
    expect(row(p, 'LATER_API_KEY')).toMatchObject({ covered_by_all: true, status: { usable: false, reason: 'no_host' } })
    expect(row(p, 'LATER_API_KEY').status.detail).toMatch(/no confirmed host yet/)
    // The host is confirmed from the other bot's panel: nothing is changed on gtm.
    await admin('PUT', '/agents/rival/secret-access', { workspace: WS, grants: [], hosts: [{ name: 'LATER_API_KEY', hosts: ['api.later.example'] }] })
    expect((await use('gtm', 'LATER_API_KEY', 'api.later.example')).ok).toBe(true)
    expect((await use('rival', 'LATER_API_KEY', 'api.later.example')).ok).toBe(false)
  })

  it('Read and write is an explicit mode; changing it and switching off are immediate and audited', async () => {
    await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: [], all_secrets: { enabled: true, mode: 'read' }, hosts: confirmAll(FIVE) })
    expect((await use('gtm', 'ACME_API_KEY', HOSTS.ACME_API_KEY, 'POST')).ok).toBe(false)
    const w = await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: [], all_secrets: { enabled: true, mode: 'write' } })
    expect(w.json.saved.all_secrets).toBe('on_write')
    expect((await use('gtm', 'ACME_API_KEY', HOSTS.ACME_API_KEY, 'POST')).ok).toBe(true)
    // A save that does not mention the switch leaves it alone.
    await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: [] })
    expect((await panel()).all_secrets).toEqual({ enabled: true, mode: 'write' })

    const off = await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: [], all_secrets: { enabled: false } })
    expect(off.json.saved.all_secrets).toBe('off')
    for (const n of FIVE) expect((await use('gtm', n, HOSTS[n])).ok).toBe(false)

    const details = audit().filter(l => l.key === '*' && /All secrets/.test(l.detail)).map(l => l.detail)
    expect(details).toEqual([
      `bot=gtm workspace=${WS} All secrets switched on mode=read methods=GET,HEAD`,
      `bot=gtm workspace=${WS} All secrets switched on mode=write methods=GET,HEAD,POST,PUT,PATCH,DELETE (was read)`,
      `bot=gtm workspace=${WS} All secrets switched off`,
    ])
    expect(audit().every(l => l.actor_user_id === ADMIN)).toBe(true)
    expect((await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: [], all_secrets: { enabled: true, mode: 'admin' } })).status).toBe(400)
  })

  it('does not cover a Shared secret, and a per-key tick wins for its own key', async () => {
    await admin('PUT', '/agents/gtm/secret-access', {
      workspace: WS, all_secrets: { enabled: true, mode: 'write' }, hosts: confirmAll(FIVE),
      grants: grantsFor(['EXA_API_KEY']), // read only, for this one key
    })
    expect((await use('gtm', 'SHARED_API_KEY', 'api.shared.example')).ok).toBe(false)
    expect((await use('gtm', 'EXA_API_KEY', HOSTS.EXA_API_KEY, 'POST')).ok).toBe(false)
    expect((await use('gtm', 'HUNTER_API_KEY', HOSTS.HUNTER_API_KEY, 'POST')).ok).toBe(true)
    const p = await panel()
    expect(row(p, 'SHARED_API_KEY')).toMatchObject({ scope: 'shared', covered_by_all: false, status: { usable: false, reason: 'workspace_not_ticked' } })
    expect(row(p, 'EXA_API_KEY')).toMatchObject({ covered_by_all: false, status: { via: ['bot_grant'] } })
    expect(row(p, 'HUNTER_API_KEY')).toMatchObject({ covered_by_all: true, status: { usable: true, via: ['all_secrets'] } })
  })

  it('ends when the bot loses the workspace, and is refused for a bot with Full access there', async () => {
    await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: [], all_secrets: { enabled: true }, hosts: confirmAll(FIVE) })
    await admin('PUT', '/agents/gtm/workspaces', { workspaces: ['other'] })
    expect((await use('gtm', 'EXA_API_KEY', HOSTS.EXA_API_KEY)).ok).toBe(false)

    expect((await admin('PUT', `/agents/rival/full-access/${WS}`, { enabled: true })).status).toBe(200)
    const r = await admin('PUT', '/agents/rival/secret-access', { workspace: WS, grants: [], all_secrets: { enabled: true } })
    expect(r.status).toBe(409)
    expect(r.json.error).toMatch(/Full access/)
  })
})

describe('Test access', () => {
  it('gives the reason for each failure case, calls no vendor and never includes a value', async () => {
    // Tool off: nothing granted yet, the old workspace-wide entry is all gtm could reach.
    let t = await test()
    expect(t.tool_on).toBe(false)
    expect(result(t, 'OLD_API_KEY')).toMatchObject({ usable: false, reason: 'tool_off' })

    await admin('PUT', '/agents/gtm/secret-access', {
      workspace: WS, all_secrets: { enabled: true }, hosts: [{ name: 'EXA_API_KEY', hosts: [HOSTS.EXA_API_KEY] }, { name: 'TINY_KEY', hosts: ['api.tiny.example'] }],
      grants: grantsFor(['APIFY_API_TOKEN']),
    })
    t = await test()
    expect(result(t, 'APIFY_API_TOKEN')).toMatchObject({ usable: true, reason: 'ok', via: ['bot_grant'], hosts: ['api.apify.com'], methods: ['GET', 'HEAD'] })
    expect(result(t, 'EXA_API_KEY')).toMatchObject({ usable: true, reason: 'ok', via: ['all_secrets'] })
    expect(result(t, 'HUNTER_API_KEY')).toMatchObject({ usable: false, reason: 'no_host' })
    expect(result(t, 'TINY_KEY')).toMatchObject({ usable: false, reason: 'value_too_short' })
    expect(result(t, 'OLD_API_KEY')).toMatchObject({ usable: true, reason: 'ok', via: ['workspace_bot_access'], methods: ['GET'] })
    // What Test access says matches what the bot can really do.
    for (const r of t.results as Loose[]) {
      if (!r.hosts[0]) continue
      expect((await use('gtm', r.name, r.hosts[0])).ok, r.name).toBe(r.usable)
    }
    const calls = sent.length
    t = await test()
    expect(sent.length).toBe(calls) // the test itself sends nothing
    noValues(t)

    // A Shared secret nobody gave this workspace, on the panel row.
    expect(row(await panel(), 'SHARED_API_KEY').status).toMatchObject({ usable: false, reason: 'workspace_not_ticked' })
    // The bot is not in the workspace.
    await admin('PUT', '/agents/gtm/workspaces', { workspaces: ['other'] })
    expect((await admin('POST', '/agents/gtm/secret-access/test', { workspace: WS })).status).toBe(404)
    // Full access here blocks every secret (the existing permanent rule).
    await admin('PUT', '/agents/rival/secret-access', { workspace: WS, grants: grantsFor(['EXA_API_KEY']) })
    await admin('PUT', `/agents/rival/full-access/${WS}`, { enabled: true })
    expect(result(await test('rival'), 'EXA_API_KEY')).toMatchObject({ usable: false, reason: 'full_access_blocks_secrets' })
  })
})

describe('old Bot access entries', () => {
  it('still work unchanged for every bot with the tool, with or without a per-bot grant', async () => {
    const before = JSON.stringify(getBrokerPolicy())
    expect((await use('rival', 'OLD_API_KEY', 'api.old.example')).ok).toBe(true)
    expect((await use('rival', 'OLD_API_KEY', 'api.old.example', 'POST')).ok).toBe(false)
    await admin('PUT', '/agents/gtm/secret-access', { workspace: WS, grants: grantsFor(FIVE) })
    expect((await use('gtm', 'OLD_API_KEY', 'api.old.example')).ok).toBe(true)
    expect((await use('rival', 'OLD_API_KEY', 'api.old.example')).ok).toBe(true)
    expect(JSON.stringify(getBrokerPolicy())).toBe(before)
    // The panel says plainly that this one reaches every bot in the workspace.
    expect(row(await panel('rival'), 'OLD_API_KEY')).toMatchObject({ grant: null, workspace_wide: { hosts: ['api.old.example'], methods: ['GET'] } })
  })
})
