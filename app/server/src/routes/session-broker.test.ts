/**
 * /api/session-broker (obj 901743, public issue #136): card sessions reach
 * GitHub, Google Workspace and workspace MCP servers through the host, with
 * their card-scoped CC_SESSION_TOKEN, and every request is scoped:
 *   - only the card's own token, only while the card is live and unchanged;
 *   - GitHub only for repos linked to the card's workspace, and only when the
 *     owner's connector rules allow this card (agent key, delegated card);
 *   - Google only within the card's connector mode (drafts_only refuses reads
 *     BEFORE any Google request), never returning the refresh token;
 *   - workspace MCP only for the card's own workspace, token added on the host.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-session-broker-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-session-broker-xxxxxx'
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 6).toString('base64')
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.GOOGLE_OAUTH_CLIENT_ID = 'broker-test-client.apps.googleusercontent.com'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'GOCSPX-broker-test-client-secret'
process.env.CC_SESSION_BROKER_RATE_PER_MIN = '10000'

const { initDb, getDb } = await import('../db/index.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const githubTokens = await import('../services/user-github-tokens.js')
const google = await import('../services/user-google-connections.js')
const { setSecret } = await import('../services/secrets-store.js')
const { setAccess } = await import('../connectors/access.js')
const { mcpSecretKey, __setMcpFetchForTests } = await import('../services/workspace-mcp-servers.js')
const { default: router } = await import('./session-broker.js')

const OWNER = 11
const OTHER = 12
const PAT = 'github_pat_11BROKER_ownerSecret_0000000000'
const OTHER_PAT = 'github_pat_11BROKER_otherSecret_1111111111'
const REFRESH = '1//broker-owner-refresh-token-zzzzzzzz'
const ACCESS = 'ya29.broker-owner-access-token'
const MCP_TOKEN = 'mcp-server-secret-token-abcdef'

let server: http.Server
let baseUrl: string

interface GoogleCall { url: string; auth: string | null; method: string }
let googleCalls: GoogleCall[] = []
interface McpCall { url: string; headers: Record<string, string>; body: string | undefined; method: string }
let mcpCalls: McpCall[] = []

function seedUser(id: number, username: string): void {
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'admin')`).run(id, username)
}

function addCard(id: number, over: Record<string, unknown> = {}): void {
  const row = { id, title: `card ${id}`, status: 'working', workspace: 'ws-a', project: 'app', created_by: OWNER, agent_context: 'general', ...over }
  const cols = Object.keys(row)
  getDb().prepare(`INSERT INTO objectives (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => (row as Record<string, unknown>)[c]))
}

function tokenFor(objectiveId: number, workspace = 'ws-a', actingUserId: number | null = OWNER): string {
  return mintSessionToken({ objectiveId, workspace, actingUserId })
}

async function get(p: string, token?: string) {
  const res = await fetch(`${baseUrl}${p}`, { headers: token ? { 'X-CC-Session-Token': token } : {} })
  return { status: res.status, text: await res.text() }
}

async function rpc(p: string, token: string, body: unknown) {
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'X-CC-Session-Token': token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, json: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = express()
  app.use(express.json())
  app.use('/api/session-broker', router)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`

  google.__setFetchForTests(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    googleCalls.push({ url, auth: headers.get('authorization'), method: init?.method ?? 'GET' })
    if (url.includes('/messages?')) return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/messages/m1')) {
      return new Response(JSON.stringify({ id: 'm1', snippet: 'hi', payload: { headers: [{ name: 'From', value: 'a@b.c' }, { name: 'Subject', value: 'Hello' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/drafts')) return new Response(JSON.stringify({ id: 'd1' }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  __setMcpFetchForTests(async (url: string, init?: RequestInit) => {
    mcpCalls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body as string | undefined, method: init?.method ?? 'GET' })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } })
  })
})

afterAll(async () => {
  google.__setFetchForTests(null)
  __setMcpFetchForTests(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { fs.unlinkSync(TMP_DB) } catch { /* gone */ }
})

beforeEach(() => {
  const db = getDb()
  db.exec(`DELETE FROM objectives; DELETE FROM user_github_tokens; DELETE FROM agent_api_keys; DELETE FROM users;
           DELETE FROM workspace_repos; DELETE FROM workspace_mcp_servers; DELETE FROM secrets;`)
  try { db.exec('DELETE FROM connector_access') } catch { /* lazy table */ }
  try { db.exec('DELETE FROM user_google_connections') } catch { /* lazy table */ }
  googleCalls = []
  mcpCalls = []
  seedUser(OWNER, 'owner')
  seedUser(OTHER, 'other')
  for (const ws of ['ws-a', 'ws-b']) db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(ws, ws)
  db.prepare(`INSERT INTO workspace_repos (workspace, name, github) VALUES ('ws-a', 'app', 'Acme/App')`).run()
  db.prepare(`INSERT INTO workspace_repos (workspace, name, github) VALUES ('ws-b', 'other', 'acme/other-secret-repo')`).run()
  githubTokens.upsert(OWNER, { rawToken: PAT, login: 'owner-gh', githubUserId: 1, email: '1+owner-gh@users.noreply.github.com', scopes: null, tokenType: 'pat_fine' })
  githubTokens.upsert(OTHER, { rawToken: OTHER_PAT, login: 'other-gh', githubUserId: 2, email: '2+other-gh@users.noreply.github.com', scopes: null, tokenType: 'pat_fine' })
  google.upsert(OWNER, {
    googleEmail: 'owner@example.com',
    googleSub: 'sub-owner',
    refreshToken: REFRESH,
    accessToken: ACCESS,
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scopes: google.GOOGLE_SCOPES.join(' '),
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
  })
})

describe('auth: only the card\'s own live token', () => {
  it('no token / a forged token is a 401', async () => {
    addCard(1)
    expect((await get('/api/session-broker/github/token?repo=acme/app')).status).toBe(401)
    expect((await get('/api/session-broker/github/token?repo=acme/app', 'ccs_forged.payload')).status).toBe(401)
  })
  it('a request that came through a proxy (forwarding headers) is refused even with a valid token', async () => {
    addCard(4)
    const res = await fetch(`${baseUrl}/api/session-broker/github/token?repo=acme/app`, {
      headers: { 'X-CC-Session-Token': tokenFor(4), 'X-Forwarded-For': '203.0.113.9' },
    })
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).toContain('not_on_box')
    expect(text).not.toContain(PAT)
  })
  it('an ended card\'s token stops working', async () => {
    addCard(2, { status: 'done' })
    const r = await get('/api/session-broker/github/token?repo=acme/app', tokenFor(2))
    expect(r.status).toBe(403)
    expect(r.text).toContain('card_ended')
    expect(r.text).not.toContain(PAT)
  })
  it('a card reassigned since the token was minted is refused (never another person\'s connection)', async () => {
    addCard(3, { assigned_user_id: OTHER })
    const r = await get('/api/session-broker/github/token?repo=acme/app', tokenFor(3, 'ws-a', OWNER))
    expect(r.status).toBe(403)
    expect(r.text).toContain('owner_changed')
    expect(r.text).not.toContain(PAT)
    expect(r.text).not.toContain(OTHER_PAT)
  })
})

describe('GitHub: per-request repo + connector scope', () => {
  it('git credential helper: a linked repo gets the owner\'s credential for that one request', async () => {
    addCard(10)
    const r = await get('/api/session-broker/github/git-credential?protocol=https&host=github.com&path=Acme/App.git', tokenFor(10))
    expect(r.status).toBe(200)
    expect(r.text).toBe(`username=x-access-token\npassword=${PAT}\n`)
  })
  it('gh shim: owner/repo, an https URL and an ssh URL all resolve to the linked repo', async () => {
    addCard(11)
    for (const repo of ['acme/app', 'https://github.com/Acme/App.git', 'git@github.com:acme/app.git']) {
      const r = await get(`/api/session-broker/github/token?repo=${encodeURIComponent(repo)}`, tokenFor(11))
      expect(r.status, repo).toBe(200)
      expect(r.text).toBe(PAT)
    }
  })
  it('a repo linked only to ANOTHER workspace is refused, and the credential never leaves', async () => {
    addCard(12)
    for (const p of [
      '/api/session-broker/github/token?repo=acme/other-secret-repo',
      '/api/session-broker/github/git-credential?protocol=https&host=github.com&path=acme/other-secret-repo.git',
      '/api/session-broker/github/token?repo=someone/random',
    ]) {
      const r = await get(p, tokenFor(12))
      expect(r.status, p).toBe(403)
      expect(r.text).toContain('repo_out_of_scope')
      expect(r.text).not.toContain(PAT)
    }
  })
  it('naming another workspace\'s repo as the card project does not widen the scope', async () => {
    addCard(18, { project: 'other' })
    const r = await get('/api/session-broker/github/token?repo=acme/other-secret-repo', tokenFor(18))
    expect(r.status).toBe(403)
    expect(r.text).not.toContain(PAT)
    addCard(19, { project: '%' })
    expect((await get('/api/session-broker/github/token?repo=acme/other-secret-repo', tokenFor(19))).status).toBe(403)
  })
  it('a missing or traversal repo is a 400', async () => {
    addCard(13)
    expect((await get('/api/session-broker/github/token', tokenFor(13))).status).toBe(400)
    expect((await get('/api/session-broker/github/token?repo=../../etc', tokenFor(13))).status).toBe(400)
  })
  it('a non-GitHub host gets an empty answer (git moves on), not a credential', async () => {
    addCard(14)
    const r = await get('/api/session-broker/github/git-credential?protocol=https&host=gitlab.com&path=acme/app.git', tokenFor(14))
    expect(r.status).toBe(200)
    expect(r.text).toBe('')
  })
  it('a card filed by an agent key without GitHub on its list is refused (rule re-checked per request)', async () => {
    const keyId = Number(getDb()
      .prepare(`INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes, connectors) VALUES (?, 'cos-bot', 'h1', 'abcd', '[]', '[]')`)
      .run(OWNER).lastInsertRowid)
    addCard(15, { agent_key_id: keyId })
    const r = await get('/api/session-broker/github/token?repo=acme/app', tokenFor(15))
    expect(r.status).toBe(403)
    expect(r.text).toContain('github_key_connector')
    expect(r.text).not.toContain(PAT)
  })
  it('a delegated card gets the assignee\'s GitHub only after the assignee opts in', async () => {
    addCard(16, { created_by: OTHER, assigned_user_id: OWNER })
    const before = await get('/api/session-broker/github/token?repo=acme/app', tokenFor(16))
    expect(before.status).toBe(403)
    expect(before.text).not.toContain(PAT)
    setAccess('github', OWNER, { agents: null, workspaces: null, allow_delegated: true })
    const after = await get('/api/session-broker/github/token?repo=acme/app', tokenFor(16))
    expect(after.status).toBe(200)
    expect(after.text).toBe(PAT)
  })
  it('a Settings → Secrets GH_TOKEN override still wins, now through the broker', async () => {
    setSecret({ scope: { scopeType: 'workspace', workspace: 'ws-a' }, key: 'GH_TOKEN', value: 'ghp_storeOverrideToken000000000' })
    addCard(17)
    const r = await get('/api/session-broker/github/token?repo=acme/app', tokenFor(17))
    expect(r.status).toBe(200)
    expect(r.text).toBe('ghp_storeOverrideToken000000000')
  })
})

describe('Google Workspace: host-side MCP, connector mode enforced before Google is called', () => {
  it('initialize + tools/list for an ordinary card (read_and_drafts)', async () => {
    addCard(20)
    const init = await rpc('/api/session-broker/google/mcp', tokenFor(20), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(init.json.result.protocolVersion).toBe('2025-06-18')
    expect(init.json.result.instructions).toContain('read_and_drafts')
    const list = await rpc('/api/session-broker/google/mcp', tokenFor(20), { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(list.json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(['calendar_list_events', 'gmail_create_draft', 'gmail_list_inbox', 'gmail_read_message'])
  })
  it('reads the inbox with a host-refreshed access token; the refresh token and client secret never reach the session', async () => {
    addCard(21)
    const r = await rpc('/api/session-broker/google/mcp', tokenFor(21), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gmail_list_inbox', arguments: { limit: 5 } } })
    expect(r.status).toBe(200)
    expect(r.json.result.isError).toBeUndefined()
    expect(r.json.result.content[0].text).toContain('Hello')
    expect(googleCalls.length).toBeGreaterThan(0)
    expect(googleCalls.every(c => c.auth === `Bearer ${ACCESS}`)).toBe(true)
    for (const secret of [REFRESH, ACCESS, process.env.GOOGLE_OAUTH_CLIENT_SECRET as string]) expect(r.text).not.toContain(secret)
  })
  it('drafts_only (a scoped bot): reads are not listed and are refused with NO Google request; drafts still work', async () => {
    setAccess('google-workspace', OWNER, { agents: ['example-general-counsel'], workspaces: null, allow_delegated: false })
    addCard(22, { agent_context: 'example-general-counsel' })
    const list = await rpc('/api/session-broker/google/mcp', tokenFor(22), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(['gmail_create_draft'])
    const read = await rpc('/api/session-broker/google/mcp', tokenFor(22), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gmail_list_inbox', arguments: {} } })
    expect(read.json.result.isError).toBe(true)
    expect(read.json.result.content[0].text).toContain('drafts_only')
    expect(googleCalls).toEqual([])
    const draft = await rpc('/api/session-broker/google/mcp', tokenFor(22), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gmail_create_draft', arguments: { to: 'x@y.z', subject: 's', body: 'b' } } })
    expect(draft.json.result.isError).toBeUndefined()
    expect(draft.json.result.content[0].text).toContain('Nothing was sent')
    expect(googleCalls.some(c => c.url.endsWith('/drafts') && c.method === 'POST')).toBe(true)
  })
  it('a card the owner\'s Who can use it rule leaves out gets no tools and no Google request', async () => {
    setAccess('google-workspace', OWNER, { agents: ['someone-else'], workspaces: null, allow_delegated: false })
    addCard(23)
    const list = await rpc('/api/session-broker/google/mcp', tokenFor(23), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.json.result.tools).toEqual([])
    const call = await rpc('/api/session-broker/google/mcp', tokenFor(23), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gmail_create_draft', arguments: { to: 'x@y.z', subject: 's', body: 'b' } } })
    expect(call.json.result.isError).toBe(true)
    expect(googleCalls).toEqual([])
  })
  it('a read-only (reviewer) session token gets no Google tools, so no drafts either', async () => {
    addCard(25)
    const ro = mintSessionToken({ objectiveId: 25, workspace: 'ws-a', actingUserId: OWNER, readOnly: true })
    const list = await rpc('/api/session-broker/google/mcp', ro, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.json.result.tools).toEqual([])
    const call = await rpc('/api/session-broker/google/mcp', ro, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gmail_create_draft', arguments: { to: 'x@y.z', subject: 's', body: 'b' } } })
    expect(call.json.result.isError).toBe(true)
    expect(googleCalls).toEqual([])
  })
  it('a JSON-RPC batch is capped (one request cannot fan out into hundreds of Google calls)', async () => {
    addCard(26)
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'gmail_list_inbox', arguments: {} } }))
    const r = await rpc('/api/session-broker/google/mcp', tokenFor(26), batch)
    expect(r.status).toBe(400)
    expect(googleCalls).toEqual([])
  })
  it('there is no send tool', async () => {
    addCard(24)
    const r = await rpc('/api/session-broker/google/mcp', tokenFor(24), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gmail_send', arguments: {} } })
    expect(r.json.result.isError).toBe(true)
    expect(googleCalls).toEqual([])
  })
})

describe('workspace MCP relay: the server token is added on the host, own workspace only', () => {
  function addServer(workspace: string, slug: string): number {
    const id = Number(getDb()
      .prepare(`INSERT INTO workspace_mcp_servers (workspace, slug, name, url, transport, auth_type, status, enabled) VALUES (?, ?, ?, ?, 'streamable_http', 'api_key', 'connected', 1)`)
      .run(workspace, slug, slug, `https://mcp.example.com/${slug}`).lastInsertRowid)
    setSecret({ scope: { scopeType: 'workspace', workspace }, key: mcpSecretKey(id, 'ACCESS_TOKEN'), value: MCP_TOKEN, serviceOnly: true, source: 'server' })
    return id
  }
  it('relays to the card\'s workspace server with its credential', async () => {
    addServer('ws-a', 'crm')
    addCard(30)
    const r = await rpc('/api/session-broker/mcp/crm', tokenFor(30), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(r.status).toBe(200)
    expect(mcpCalls).toHaveLength(1)
    expect(mcpCalls[0].url).toBe('https://mcp.example.com/crm')
    expect(mcpCalls[0].headers.authorization).toBe(`Bearer ${MCP_TOKEN}`)
    expect(mcpCalls[0].headers['x-cc-session-token']).toBeUndefined()
    expect(r.text).not.toContain(MCP_TOKEN)
  })
  it('another workspace\'s server is a 404 and is never called', async () => {
    addServer('ws-b', 'secret-crm')
    addCard(31)
    const r = await rpc('/api/session-broker/mcp/secret-crm', tokenFor(31), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(r.status).toBe(404)
    expect(mcpCalls).toEqual([])
  })
})
