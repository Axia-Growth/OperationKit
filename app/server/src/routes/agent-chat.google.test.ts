// obj 901331 — real Gmail / Google Calendar drafts for chat bots, demo inbox only
// for the demo assistant.
//
// Drives the real chat route end to end on the scripted demo provider (no AI
// account), with Google's HTTPS calls replaced by a fake. Proves:
//   1. a real bot gets the person's own Google mailbox + calendar, not the sample inbox;
//   2. the demo assistant stays on sample data and needs no Google connection;
//   3. no agent tool can send mail or add an event — only the person's click does;
//   4. "Who can use it" (connector_access) is honoured in chat;
//   5. the install-wide demo switch no longer forces the sample inbox on real bots
//      (AGENT_CHAT_DEMO=1 is ON for this whole file);
//   + a stale refresh token says "reconnect" and is never revoked or replaced.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-agent-chat-google'
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-agent-chat-google-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-chat-google-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-chat-google-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB
process.env.AGENT_CHAT_PROVIDER = 'demo'
// The install-wide demo switch is ON for every test here (requirement 5).
process.env.AGENT_CHAT_DEMO = '1'
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.com'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret-not-real'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { findAgent } = await import('../services/agent-chat/engine.js')
const { resolveConnectors } = await import('../services/agent-chat/connectors.js')
const { runChatTool, toolSpecsFor } = await import('../services/agent-chat/tools.js')
const { setAccess } = await import('../connectors/access.js')
const { __setFetchForTests, upsert, getForUser, TOKEN_ENDPOINT, REVOKE_ENDPOINT } = await import('../services/user-google-connections.js')
const { GMAIL_API, CALENDAR_API } = await import('../services/agent-chat/google-connectors.js')

const OPERATOR = 1
const CASEY = 2
const WS = 'your-org'
const MIKE_EMAIL = 'operator@example.example'
const REFRESH = 'refresh-value-for-tests-only'
const ACCESS = 'access-value-for-tests-only'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string

interface Seen { method: string; url: string; auth: string; body: string }
let seen: Seen[] = []
let refreshStatus = 200

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

function installFakeGoogle() {
  seen = []
  __setFetchForTests(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? init.body : ''
    seen.push({ method, url, auth: headers.Authorization || '', body })
    if (url === TOKEN_ENDPOINT) {
      return refreshStatus === 200 ? json(200, { access_token: ACCESS, expires_in: 3600 }) : json(refreshStatus, { error: 'invalid_grant' })
    }
    if (url === REVOKE_ENDPOINT) return json(200, {})
    if (headers.Authorization !== `Bearer ${ACCESS}`) return json(401, { error: 'bad token' })
    const u = new URL(url)
    if (url.startsWith(`${GMAIL_API}/messages?`)) return json(200, { messages: [{ id: 'g-1' }] })
    if (u.pathname.endsWith('/messages/g-1')) {
      const full = u.searchParams.get('format') === 'full'
      return json(200, {
        id: 'g-1',
        threadId: 't-1',
        labelIds: ['INBOX', 'UNREAD'],
        snippet: 'Can you confirm the Q4 invoice?',
        internalDate: String(Date.now() - 3600_000),
        payload: {
          headers: [
            { name: 'From', value: 'Dana Real <dana@client.example>' },
            { name: 'Subject', value: 'Q4 invoice' },
            { name: 'Message-ID', value: '<abc@client.example>' },
          ],
          ...(full ? { mimeType: 'text/plain', body: { data: b64url('Hi Operator, can you confirm the Q4 invoice? — Dana') } } : {}),
        },
      })
    }
    if (url === `${GMAIL_API}/drafts` && method === 'POST') return json(200, { id: 'r-1', message: { id: 'm-9' } })
    if (url === `${GMAIL_API}/drafts/r-1` && method === 'PUT') return json(200, { id: 'r-1' })
    if (url === `${GMAIL_API}/drafts/r-1` && method === 'DELETE') return new Response(null, { status: 204 })
    if (url === `${GMAIL_API}/drafts/send` && method === 'POST') return json(200, { id: 'm-9' })
    if (url.startsWith(`${CALENDAR_API}/events?`) && method === 'GET') {
      const start = new Date(Date.now() + 26 * 3600_000)
      return json(200, { items: [{ id: 'ev-1', summary: 'Pipeline review', start: { dateTime: start.toISOString() }, end: { dateTime: new Date(start.getTime() + 1800_000).toISOString() }, attendees: [{ email: 'dana@client.example', displayName: 'Dana Real' }, { email: MIKE_EMAIL, self: true }] }] })
    }
    if (url.startsWith(`${CALENDAR_API}/events?`) && method === 'POST') return json(200, { id: 'ev-new' })
    return json(404, { error: `unexpected ${method} ${url}` })
  })
}

/** Any Google call that would deliver something. */
const deliveries = () => seen.filter(s =>
  (s.method === 'POST' && (s.url.endsWith('/messages/send') || s.url.endsWith('/drafts/send') || (s.url.startsWith(`${CALENDAR_API}/events`)))),
)

function connectMike(expiredAccess = true) {
  upsert(OPERATOR, {
    googleEmail: MIKE_EMAIL,
    googleSub: 'sub-1',
    refreshToken: REFRESH,
    accessToken: 'stale-access',
    accessTokenExpiresAt: new Date(Date.now() + (expiredAccess ? -3600_000 : 3600_000)).toISOString(),
    scopes: 'openid https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar',
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
  })
}

function tokenFor(id: number, role = 'member') {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as: number; role?: string; body?: unknown } ) {
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `token=${tokenFor(opts.as, opts.role)}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null } as { status: number; json: Loose }
}
const say = (as: number, slug: string, text: string) => call('POST', `/agents/${slug}/messages`, { as, role: as === OPERATOR ? 'admin' : 'member', body: { text } })

function writeBot(slug: string, name: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug))
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${name}\nsystem_prompt: You help Operator.\ntools: [email, calendar]\ncolour: blue\nversion: 1.0.0\nauthor: Test\n`)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'user2', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, 'Example')`).run(WS)
  for (const u of [OPERATOR, CASEY]) db.prepare('INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(u, WS)
  writeBot('example-cfo', 'Example CFO')
  writeBot('example-client-success', 'Example Client Success')
  const { seedExistingBotsOnce } = await import('../services/agent-chat/bot-workspaces.js')
  seedExistingBotsOnce(['example-cfo', 'example-client-success', 'demo-assistant'])

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

beforeEach(() => {
  refreshStatus = 200
  connectMike()
  setAccess('google-workspace', OPERATOR, { agents: null, workspaces: null, allow_delegated: false })
  installFakeGoogle()
})

afterAll(async () => {
  __setFetchForTests(null)
  delete process.env.AGENT_CHAT_DEMO
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('real bot + connected Google (requirements 1 and 5)', () => {
  it('example-cfo reads Operator\'s real Gmail, not the sample inbox, even with the install demo switch on', async () => {
    const r = await say(OPERATOR, 'example-cfo', "What's in my inbox?")
    expect(r.status).toBe(200)
    expect(r.json.messages[1]).toMatchObject({ tool_name: 'email_list_inbox', content: expect.stringMatching(/Checked inbox \(1 emails\)/) })
    const reply = r.json.messages.at(-1).content as string
    expect(reply).toMatch(/Dana/)
    expect(reply).not.toMatch(/Thursday's review|Harbor Coffee/i) // the sample inbox's first email
    // The expired cached token was refreshed with the stored refresh token, then used.
    expect(seen[0].url).toBe(TOKEN_ENDPOINT)
    expect(seen.some(s => s.url.startsWith(`${GMAIL_API}/messages?`) && s.auth === `Bearer ${ACCESS}`)).toBe(true)
    expect(getForUser(OPERATOR)?.last_error).toBeNull()
  })

  it('resolveConnectors gives a real bot the Google connectors (also example-client-success)', () => {
    for (const slug of ['example-cfo', 'example-client-success']) {
      const c = resolveConnectors({ agentSlug: slug, userId: OPERATOR, workspace: WS })
      expect(c.mail?.id).toBe(`google:${MIKE_EMAIL}`)
      expect(c.mail?.label).toBe(`Gmail (${MIKE_EMAIL})`)
      expect(c.calendar?.label).toBe(`Google Calendar (${MIKE_EMAIL})`)
    }
    // Even an explicit "demo switch on" input is not a parameter any more: only the slug decides.
    expect(resolveConnectors({ agentSlug: 'example-cfo', userId: OPERATOR, workspace: WS }).mail?.id).not.toBe('demo')
  })

  it('drafts a reply into Gmail Drafts; nothing is sent until Operator clicks Send', async () => {
    const r = await say(OPERATOR, 'example-cfo', 'Reply to Dana')
    expect(r.status).toBe(200)
    expect(r.json.messages.map((m: Loose) => m.tool_name).filter(Boolean)).toEqual(['email_list_inbox', 'email_read', 'email_create_draft'])
    const draft = r.json.drafts[0]
    expect(draft).toMatchObject({ kind: 'email', status: 'draft', connector: `google:${MIKE_EMAIL}`, payload: { to: 'dana@client.example', remote_id: 'r-1' } })
    // A Gmail DRAFT was created, threaded on the original; nothing delivered.
    const create = seen.find(s => s.method === 'POST' && s.url === `${GMAIL_API}/drafts`)!
    expect(JSON.parse(create.body).message.threadId).toBe('t-1')
    const raw = Buffer.from(JSON.parse(create.body).message.raw, 'base64url').toString('utf8')
    expect(raw).toMatch(/^To: dana@client\.example\r\n/)
    expect(raw).toMatch(/In-Reply-To: <abc@client\.example>/)
    expect(deliveries()).toEqual([])

    // Operator edits it, then presses Send: the Gmail draft is updated, then that draft is sent.
    await call('PUT', `/drafts/${draft.id}`, { as: OPERATOR, role: 'admin', body: { body: 'Confirmed. — Operator' } })
    seen = []
    const sent = await call('POST', `/drafts/${draft.id}/send`, { as: OPERATOR, role: 'admin' })
    expect(sent.status).toBe(200)
    expect(sent.json.draft.status).toBe('sent')
    expect(seen.map(s => `${s.method} ${s.url}`)).toEqual([
      `GET ${GMAIL_API}/messages/g-1?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
      `PUT ${GMAIL_API}/drafts/r-1`,
      `POST ${GMAIL_API}/drafts/send`,
    ])
    expect(Buffer.from(JSON.parse(seen[1].body).message.raw, 'base64url').toString('utf8')).toMatch(/Confirmed\. — Operator$/)
  })

  it('reads the real calendar and only adds an event on Operator\'s click (guests not emailed)', async () => {
    const list = await say(OPERATOR, 'example-cfo', "What's on my calendar?")
    expect(list.json.messages.at(-1).content).toMatch(/Pipeline review/)
    const r = await say(OPERATOR, 'example-cfo', 'Move the meeting with Dana to Friday')
    const d = r.json.drafts[0]
    expect(d).toMatchObject({ kind: 'event', status: 'draft', connector: `google:${MIKE_EMAIL}`, payload: { title: 'Pipeline review' } })
    expect(deliveries()).toEqual([])
    const added = await call('POST', `/drafts/${d.id}/send`, { as: OPERATOR, role: 'admin' })
    expect(added.json.draft.status).toBe('added')
    expect(deliveries().map(s => s.url)).toEqual([`${CALENDAR_API}/events?sendUpdates=none`])
  })

  it('refuses Send when the connection is now a different Google account', async () => {
    const r = await say(OPERATOR, 'example-cfo', 'Reply to Dana')
    upsert(OPERATOR, { googleEmail: 'someone-else@example.example', googleSub: 's2', refreshToken: REFRESH, scopes: 'https://www.googleapis.com/auth/gmail.modify', clientId: process.env.GOOGLE_OAUTH_CLIENT_ID as string })
    seen = []
    const sent = await call('POST', `/drafts/${r.json.drafts[0].id}/send`, { as: OPERATOR, role: 'admin' })
    expect(sent.status).toBe(409)
    expect(deliveries()).toEqual([])
  })
})

describe('demo assistant stays on sample data (requirement 2)', () => {
  it('uses the sample inbox for a person with NO Google connection', async () => {
    const r = await say(CASEY, 'demo-assistant', "What's in my inbox?")
    expect(r.status).toBe(200)
    expect(r.json.messages.at(-1).content).toMatch(/Priya/)
    expect(seen).toEqual([])
  })

  it('uses the sample inbox even for Operator, whose Google IS connected', async () => {
    const c = resolveConnectors({ agentSlug: 'demo-assistant', userId: OPERATOR, workspace: WS })
    expect(c.mail?.id).toBe('demo')
    expect(c.calendar?.id).toBe('demo')
    const r = await say(OPERATOR, 'demo-assistant', 'Reply to Priya')
    expect(r.json.drafts[0]).toMatchObject({ connector: 'demo' })
    expect(seen).toEqual([])
    const sent = await call('POST', `/drafts/${r.json.drafts[0].id}/send`, { as: OPERATOR, role: 'admin' })
    expect(sent.json.draft.status).toBe('sent')
    expect(seen).toEqual([]) // a demo draft never leaves the server
  })
})

describe('no send path from agent tools (requirement 3)', () => {
  it('no tool an agent can be given sends mail or inserts a calendar event', () => {
    fs.mkdirSync(path.join(TMP_AGENTS, 'everything'))
    fs.writeFileSync(path.join(TMP_AGENTS, 'everything', 'agent.yaml'), 'name: Everything\nsystem_prompt: x\ntools: [all]\ncolour: blue\nversion: 1.0.0\nauthor: Test\n')
    const names = toolSpecsFor(findAgent('everything')!).map(t => t.function.name)
    expect(names).toContain('email_create_draft')
    expect(names).toContain('calendar_draft_event')
    const mailCal = names.filter(n => /^(email|calendar|gmail|gcal)_/.test(n)).sort()
    expect(mailCal).toEqual(['calendar_draft_event', 'calendar_list_events', 'email_create_draft', 'email_list_inbox', 'email_read'])
    expect(names.filter(n => /(^|_)(send|deliver|insert)(_|$)|add_event|add_to_calendar|email_send|send_email/.test(n))).toEqual([])
  })

  it('the connectors handed to tools have no send / add / deliver method', () => {
    const c = resolveConnectors({ agentSlug: 'example-cfo', userId: OPERATOR, workspace: WS })
    for (const conn of [c.mail, c.calendar, resolveConnectors({ agentSlug: 'demo-assistant' }).mail, resolveConnectors({ agentSlug: 'demo-assistant' }).calendar]) {
      const keys = Object.keys(conn!)
      expect(keys.filter(k => /send|deliver|add|insert/i.test(k))).toEqual([])
    }
  })

  it('every mail/calendar tool run against the real mailbox makes zero delivery calls', async () => {
    const agent = findAgent('example-cfo')!
    const ctx = { userId: OPERATOR, username: 'user1', workspace: WS, agent, kbRoot: TMP_KB, connectors: resolveConnectors({ agentSlug: 'example-cfo', userId: OPERATOR, workspace: WS }) }
    await runChatTool(ctx, 'email_list_inbox', {})
    await runChatTool(ctx, 'email_read', { id: 'g-1' })
    await runChatTool(ctx, 'email_create_draft', { to: 'dana@client.example', subject: 'Hi', body: 'x' })
    await runChatTool(ctx, 'calendar_list_events', {})
    await runChatTool(ctx, 'calendar_draft_event', { title: 'Call', start: new Date().toISOString(), end: new Date(Date.now() + 1800_000).toISOString(), with: ['dana@client.example'] })
    expect(seen.length).toBeGreaterThan(0)
    expect(deliveries()).toEqual([])
  })

  it('tools.ts never imports the delivery path', () => {
    const src = fs.readFileSync(new URL('../services/agent-chat/tools.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/resolveDelivery|googleDelivery/)
  })
})

describe('"Who can use it" is honoured in chat (requirement 4)', () => {
  it('a bot left off the list gets no Google connector and makes no Google call', async () => {
    setAccess('google-workspace', OPERATOR, { agents: ['example-cfo'], workspaces: null, allow_delegated: false })
    const c = resolveConnectors({ agentSlug: 'example-client-success', userId: OPERATOR, workspace: WS })
    expect(c).toEqual({ mail: null, calendar: null })
    const r = await say(OPERATOR, 'example-client-success', "What's in my inbox?")
    expect(r.json.messages.map((m: Loose) => m.content).join('\n')).not.toMatch(/Dana|Priya/)
    expect(seen).toEqual([])
    // The bot that IS on the list still works.
    expect(resolveConnectors({ agentSlug: 'example-cfo', userId: OPERATOR, workspace: WS }).mail?.id).toBe(`google:${MIKE_EMAIL}`)
  })

  it('a workspace left off the list gets nothing either', () => {
    setAccess('google-workspace', OPERATOR, { agents: null, workspaces: ['operationkit'], allow_delegated: false })
    expect(resolveConnectors({ agentSlug: 'example-cfo', userId: OPERATOR, workspace: WS })).toEqual({ mail: null, calendar: null })
  })

  it('a rule tightened mid-chat stops an already-resolved connector at the next call', async () => {
    const c = resolveConnectors({ agentSlug: 'example-client-success', userId: OPERATOR, workspace: WS })
    setAccess('google-workspace', OPERATOR, { agents: ['example-cfo'], workspaces: null, allow_delegated: false })
    await expect(Promise.resolve(c.mail!.listInbox(5, false))).rejects.toThrow(/Reconnect|not available/)
    expect(seen.filter(s => s.url.startsWith(GMAIL_API))).toEqual([])
  })

  it('another person chatting with the same bot never gets Operator\'s mailbox', async () => {
    expect(resolveConnectors({ agentSlug: 'example-cfo', userId: CASEY, workspace: WS })).toEqual({ mail: null, calendar: null })
    const r = await say(CASEY, 'example-cfo', "What's in my inbox?")
    expect(r.json.messages.map((m: Loose) => m.content).join('\n')).not.toMatch(/Dana/)
    expect(seen).toEqual([])
  })
})

describe('stale refresh token', () => {
  it('says to reconnect, records the error, and never revokes or replaces the stored grant', async () => {
    refreshStatus = 400
    const before = getDb().prepare('SELECT refresh_token_encrypted FROM user_google_connections WHERE user_id = ?').get(OPERATOR) as { refresh_token_encrypted: string }
    const r = await say(OPERATOR, 'example-cfo', "What's in my inbox?")
    const tool = r.json.messages.find((m: Loose) => m.tool_name === 'email_list_inbox')
    expect(tool.content).toMatch(/Reconnect Google at Settings → Account → Google Workspace/)
    expect(tool.content).not.toContain(REFRESH)
    expect(getForUser(OPERATOR)?.last_error).toMatch(/HTTP 400/)
    expect(seen.map(s => s.url)).not.toContain(REVOKE_ENDPOINT)
    const after = getDb().prepare('SELECT refresh_token_encrypted FROM user_google_connections WHERE user_id = ?').get(OPERATOR) as { refresh_token_encrypted: string }
    expect(after.refresh_token_encrypted).toBe(before.refresh_token_encrypted)
  })

  it('a cached token Google rejects is refreshed once and the call retried', async () => {
    connectMike(false) // cached 'stale-access' looks valid but Google answers 401
    const c = resolveConnectors({ agentSlug: 'example-cfo', userId: OPERATOR, workspace: WS })
    const msgs = await c.mail!.listInbox(5, false)
    expect(msgs[0]).toMatchObject({ id: 'g-1', subject: 'Q4 invoice', unread: true })
    expect(seen.filter(s => s.url === TOKEN_ENDPOINT)).toHaveLength(1)
  })
})
