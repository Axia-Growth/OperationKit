/**
 * obj 900948 — regressions for the adversarial review of PR 797 (#900950):
 *   1. workspace isolation: a member of workspace A never lists, searches, reads
 *      or writes workspace B's notes through a bot, restricted or not;
 *   2. a card owned by a chat bot is worked by a worker persona (instructions +
 *      working directory), the bot stays the owner;
 *   3. the project-grain agent restriction applies to a granted bot;
 *   4. name clashes: (a) a chat bot named like a worker persona gets no pool
 *      exception, (b) a registered bot that shares a chat bot's display name
 *      cannot close that chat bot's reviewed cards.
 *
 * Real DB, real routers. Fixtures only (temp DB + temp KB).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-bot-pr797-${process.pid}-${Date.now()}.db`)
const EMPTY_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-pr797-agents-'))
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-bot-pr797-xxxxxxxx'
// No installed agent files: the built-in bots are the only chat bots.
process.env.AGENT_FILES_DIR = EMPTY_AGENTS
delete process.env.AGENT_CHAT_BUILTINS

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: internalRouter } = await import('./internal.js')
const { checkAgentInWorkspacePool } = await import('./objectives-helpers.js')
const { grantBotWorkspace, seedExistingBotsOnce, SEED_MARKER } = await import('../services/agent-chat/bot-workspaces.js')
const { runTool, runChatTool, chatCardAgent, chatOwnerBotName, kbWorkspacesForChat } = await import('../services/agent-chat/tools.js')
const { systemPromptFor } = await import('../services/agent-chat/engine.js')
const { parseAgentText, BUILTIN_DIR } = await import('../services/agent-chat/agent-defs.js')
const { withResolvedKnowledgeFolders } = await import('../services/agent-chat/knowledge-folders.js')
const { setAssignment } = await import('../services/resource-assignments.js')
const { buildPrompt, resolveWorkdir } = await import('../services/prompt-builder.js')
const { resolveCardWorker } = await import('../services/prompt-builder-workdir.js')
const { resolveAgentWorkdir } = await import('../services/agent-registry.js')
const { botApprovalEligibility } = await import('../services/bot-approval.js')
const { BOT_REGISTRY_ADDITIONS_SETTING } = await import('../services/bots/bot-registry.js')
type Agent = import('../services/agent-chat/agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const MEMBER = 2
const A = 'alpha-co'
const B = 'beta-co'
const NOCFO = 'no-cfo-co'
const POOL = ['general', 'cto', 'coo', 'cfo', 'kb-librarian']
const DEV = 'operation-kit-dev'

let server: http.Server
let baseUrl: string
const adminCookie = () => `token=${jwt.sign({ id: ADMIN, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

const row = (id: number) => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Loose

function builtinDev(): Agent {
  const file = path.join(BUILTIN_DIR, DEV, 'agent.md')
  const parsed = parseAgentText(fs.readFileSync(file, 'utf8'), file, DEV, 'builtin')
  if (!parsed.agent) throw new Error(`built-in ${DEV} did not parse: ${parsed.errors.join('; ')}`)
  return parsed.agent
}

function ctxFor(userId: number, a: Agent, kbRoot: string, workspace = A) {
  return { userId, username: userId === ADMIN ? 'admin' : 'member', workspace, agent: a, kbRoot, connectors: { mail: null, calendar: null } }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'member', 'x', 'member')`).run(MEMBER)
  db.prepare(`INSERT INTO settings (key, value) VALUES ('duplicate_guard_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`).run()
  createWorkspace({ slug: A, name: 'Alpha', default_agent_pool: POOL })
  createWorkspace({ slug: B, name: 'Beta', default_agent_pool: POOL })
  createWorkspace({ slug: NOCFO, name: 'No CFO', default_agent_pool: ['general', 'cto'] })
  // The member belongs to A only.
  db.prepare('DELETE FROM user_workspaces WHERE user_id = ?').run(MEMBER)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(MEMBER, A)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/internal', internalRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(EMPTY_AGENTS, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM agent_chat_bot_access').run()
  db.prepare('DELETE FROM agent_chat_bot_workspaces').run()
  db.prepare('DELETE FROM resource_assignments').run()
  db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(SEED_MARKER, BOT_REGISTRY_ADDITIONS_SETTING)
})

// ── 1. workspace isolation ───────────────────────────────────────────────────

describe('1. knowledge base: a member of A never reaches B through a bot', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-pr797-kb-'))
  beforeAll(() => {
    for (const [rel, text] of [
      [`workspaces/${A}/business/profile.md`, 'Alpha profile: zebrafish automation'],
      [`workspaces/${B}/business/profile.md`, 'Beta profile: SECRET zebrafish numbers'],
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true })
      fs.writeFileSync(path.join(kb, rel), text)
    }
  })
  afterAll(() => fs.rmSync(kb, { recursive: true, force: true }))

  const bPath = `workspaces/${B}/business/profile.md`
  const aPath = `workspaces/${A}/business/profile.md`

  async function expectWalled(c: ReturnType<typeof ctxFor>) {
    // list_folders: B is not offered and cannot be opened.
    const folders = (runTool(c, 'list_folders', {}).result as Loose).folders as string[]
    expect(folders.some(f => f.includes(B))).toBe(false)
    expect(() => runTool(c, 'list_folders', { path: `workspaces/${B}/business` })).toThrow()
    expect(() => runTool(c, 'list_folders', { path: `workspaces/${B}` })).toThrow()
    // search: keyword and the engine's async entry point (hybrid → keyword).
    const hits = (runTool(c, 'search', { q: 'zebrafish' }).result as Loose).results.map((h: Loose) => h.path)
    expect(hits).toEqual([aPath])
    for (const mode of ['keyword', 'hybrid']) {
      const viaEngine = ((await runChatTool(c, 'search', { q: 'zebrafish', mode })).result as Loose).results.map((h: Loose) => h.path)
      expect(viaEngine.some((p: string) => p.includes(B)), mode).toBe(false)
    }
    // read_file and write_doc.
    expect(() => runTool(c, 'read_file', { path: bPath })).toThrow()
    expect(() => runTool(c, 'write_doc', { path: `workspaces/${B}/business/planted.md`, content: '# planted\n' })).toThrow()
    expect(fs.existsSync(path.join(kb, `workspaces/${B}/business/planted.md`))).toBe(false)
    // A is fully usable, full path and short form.
    expect((runTool(c, 'list_folders', { path: `workspaces/${A}/business` }).result as Loose).items.map((i: Loose) => i.name)).toContain('profile.md')
    expect((runTool(c, 'read_file', { path: aPath }).result as Loose).content).toMatch(/Alpha profile/)
    expect((runTool(c, 'read_file', { path: 'business/profile.md' }).result as Loose).content).toMatch(/Alpha profile/)
    runTool(c, 'write_doc', { path: `workspaces/${A}/business/note.md`, content: '# note\n' })
    expect(fs.existsSync(path.join(kb, `workspaces/${A}/business/note.md`))).toBe(true)
    fs.rmSync(path.join(kb, `workspaces/${A}/business/note.md`))
  }

  it("the reviewer's case: an UNRESTRICTED bot (every bot on first boot) + a non-admin member of A only", async () => {
    seedExistingBotsOnce([DEV])
    const dev = builtinDev()
    expect(kbWorkspacesForChat(MEMBER, DEV)).toEqual([A])
    const c = ctxFor(MEMBER, dev, kb)
    await expectWalled(c)
    // The prompt names A's folders only.
    const prompt = systemPromptFor(withResolvedKnowledgeFolders(dev, kb, kbWorkspacesForChat(MEMBER, DEV)), { username: 'member', now: new Date(), connectors: [], workspace: A, userId: MEMBER })
    expect(prompt).toContain(`workspaces/${A}/business`)
    expect(prompt).not.toContain(B)
  })

  it('an unrestricted bot whose own folders span every workspace is walled by the person too', async () => {
    seedExistingBotsOnce(['wide-bot'])
    const wide = { ...builtinDev(), slug: 'wide-bot', name: 'Wide', knowledge_folders: ['workspaces'] }
    const c = ctxFor(MEMBER, wide, kb)
    expect(() => runTool(c, 'read_file', { path: bPath })).toThrow()
    expect(() => runTool(c, 'write_doc', { path: `workspaces/${B}/business/planted.md`, content: 'x' })).toThrow()
    expect(fs.existsSync(path.join(kb, `workspaces/${B}/business/planted.md`))).toBe(false)
    const hits = (runTool(c, 'search', { q: 'zebrafish' }).result as Loose).results.map((h: Loose) => h.path)
    expect(hits).toEqual([aPath])
    expect((runTool(c, 'read_file', { path: aPath }).result as Loose).content).toMatch(/Alpha profile/)
  })

  it('a bot GRANTED both A and B is still narrowed to the member (person ∩ bot)', async () => {
    grantBotWorkspace(DEV, A, 'admin')
    grantBotWorkspace(DEV, B, 'admin')
    await expectWalled(ctxFor(MEMBER, builtinDev(), kb))
  })

  it('an admin with the same unrestricted bot reaches both (unchanged), and a restricted bot is held to its grant', () => {
    seedExistingBotsOnce([DEV])
    const admin = ctxFor(ADMIN, builtinDev(), kb)
    expect((runTool(admin, 'read_file', { path: bPath }).result as Loose).content).toMatch(/Beta profile/)
    expect((runTool(admin, 'read_file', { path: aPath }).result as Loose).content).toMatch(/Alpha profile/)
    getDb().prepare('DELETE FROM agent_chat_bot_access').run()
    grantBotWorkspace(DEV, A, 'admin')
    expect(() => runTool(ctxFor(ADMIN, builtinDev(), kb), 'read_file', { path: bPath })).toThrow()
  })
})

// ── 2. bot-owned cards keep instructions + working directory ─────────────────

describe('2. a card owned by a chat bot is worked by a worker persona', () => {
  it('built-in bot slug: default worker persona for instructions and workdir; the bot stays the owner; the brief is kept', async () => {
    grantBotWorkspace(DEV, A, 'admin')
    const out = runTool(ctxFor(ADMIN, builtinDev(), os.tmpdir()), 'create_objective', { title: 'Audit the integrations', description: 'Check every connector and list the broken ones.' })
    const card = row(out.objective_id!)
    expect(card.agent_context).toBe(DEV)
    expect(card.owner_bot).toBe('Operation Kit Dev')

    const worker = resolveCardWorker(card)
    expect(worker).toEqual({ persona: 'general', workdirPersona: 'general', bot: { slug: DEV, name: 'Operation Kit Dev' } })

    const prompt = buildPrompt(card)
    expect(prompt).toContain('You are the general agent.')
    expect(prompt).not.toContain(`agents/${DEV}.md`)
    expect(prompt).toContain(`This card is owned by the Operation Kit Dev bot (${DEV}).`)
    expect(prompt).toContain('Check every connector and list the broken ones.')

    // Working directory: the persona's, not the unknown-slug home fallback.
    expect(resolveWorkdir(card)).toBe(resolveAgentWorkdir('general'))
    expect(resolveWorkdir(card)).toBe(resolveWorkdir({ ...card, agent_context: 'general' }))
  })

  it('worker personas and unknown slugs resolve to themselves, as before', () => {
    expect(resolveCardWorker({ agent_context: 'cto', workspace: A } as Loose)).toEqual({ persona: 'cto', workdirPersona: 'cto', bot: null })
    expect(resolveCardWorker({ agent_context: 'not-a-thing', workspace: A } as Loose)).toEqual({ persona: 'not-a-thing', workdirPersona: 'not-a-thing', bot: null })
    expect(buildPrompt({ ...row(1), agent_context: 'cto' })).toContain('You are the cto agent.')
  })
})

// ── 3. project-grain restriction ─────────────────────────────────────────────

describe('3. the project-grain agent restriction applies to a granted bot', () => {
  it('a workspace restricted to cto refuses the granted bot on check, create, update and internal-create; assigning the bot lets it in', async () => {
    grantBotWorkspace(DEV, A, 'admin')
    expect(checkAgentInWorkspacePool(A, DEV)).toBeNull()
    const made = await call('POST', '/api/objectives', { title: 'Card before the restriction', workspace: A })
    expect(made.status).toBe(201)

    setAssignment({ resourceType: 'agent', resourceId: 'cto', scope: { scopeType: 'workspace', workspace: A, project: null, userId: null }, actorUserId: ADMIN })
    expect(checkAgentInWorkspacePool(A, DEV)).toMatch(/is not assigned to workspace 'alpha-co'/)
    const create = await call('POST', '/api/objectives', { title: 'Restricted create', workspace: A, agent_context: DEV })
    expect(create.status).toBe(400)
    expect(create.json.error).toMatch(/is not assigned to/)
    const update = await call('PUT', `/api/objectives/${made.json.id}`, { agent_context: DEV })
    expect(update.status).toBe(400)
    const internal = await call('POST', '/api/internal/objectives', [{ title: 'Restricted wake card', workspace: A, agent_context: DEV, type: 'task' }])
    expect(internal.status).toBe(400)
    // A chat-filed card falls back to the default agent rather than a refused one.
    expect(chatCardAgent({ slug: DEV }, A).ownedByBot).toBe(false)

    setAssignment({ resourceType: 'agent', resourceId: DEV, scope: { scopeType: 'workspace', workspace: A, project: null, userId: null }, actorUserId: ADMIN })
    expect(checkAgentInWorkspacePool(A, DEV)).toBeNull()
    const allowed = await call('POST', '/api/internal/objectives', [{ title: 'Assigned wake card', workspace: A, agent_context: DEV, type: 'task' }])
    expect(allowed.status, JSON.stringify(allowed.json)).toBe(201)
  })

  it('a project-scoped restriction refuses the bot on that project only', () => {
    grantBotWorkspace(DEV, A, 'admin')
    setAssignment({ resourceType: 'agent', resourceId: 'cto', scope: { scopeType: 'project', workspace: A, project: 'locked-repo', userId: null }, actorUserId: ADMIN })
    expect(checkAgentInWorkspacePool(A, DEV, 'locked-repo')).toMatch(/is not assigned to project 'locked-repo'/)
    expect(checkAgentInWorkspacePool(A, DEV, 'other-repo')).toBeNull()
    expect(checkAgentInWorkspacePool(A, DEV)).toBeNull()
  })
})

// ── 4. name clashes ──────────────────────────────────────────────────────────

describe('4a. a chat bot named like a worker persona gets no pool exception', () => {
  it("bot `cfo` granted a workspace whose pool leaves the cfo persona out: nobody can assign 'cfo' there", async () => {
    grantBotWorkspace('cfo', NOCFO, 'admin')
    expect(checkAgentInWorkspacePool(NOCFO, 'cfo')).toMatch(/not in workspace 'no-cfo-co' pool/)
    const create = await call('POST', '/api/objectives', { title: 'Persona via bot grant', workspace: NOCFO, agent_context: 'cfo' })
    expect(create.status).toBe(400)
    const internal = await call('POST', '/api/internal/objectives', [{ title: 'Persona via bot grant (internal)', workspace: NOCFO, agent_context: 'cfo', type: 'task' }])
    expect(internal.status).toBe(400)
    const made = await call('POST', '/api/objectives', { title: 'Card to hand to cfo', workspace: NOCFO })
    const update = await call('PUT', `/api/objectives/${made.json.id}`, { agent_context: 'cfo' })
    expect(update.status).toBe(400)
    // The chat bot's own cards go to the workspace default, unowned — never to the persona.
    expect(chatCardAgent({ slug: 'cfo' }, NOCFO)).toEqual({ agentContext: 'general', ownedByBot: false })
    // Where the persona IS in the pool it stays a persona card, not a bot-owned one.
    grantBotWorkspace('cfo', A, 'admin')
    expect(chatCardAgent({ slug: 'cfo' }, A).ownedByBot).toBe(false)
    // A bot with a name of its own is unaffected.
    grantBotWorkspace(DEV, NOCFO, 'admin')
    expect(checkAgentInWorkspacePool(NOCFO, DEV)).toBeNull()
  })
})

describe("4b. a registered bot sharing a chat bot's display name cannot close its cards", () => {
  const reviewed = (id: number) => {
    getDb().prepare(`UPDATE objectives SET status = 'review', session_id = NULL, ai_review_verdict = 'pass' WHERE id = ?`).run(id)
    return row(id)
  }
  const ask = (card: Loose, declaredBot: string) => botApprovalEligibility(getDb(), { card, declaredBot, keyOwnerUserId: ADMIN, keyWorkspaces: null })

  it('the chat bot never writes an owner_bot the registry resolves to another bot, and the name-twin is refused', () => {
    const db = getDb()
    // A registered bot that happens to be called "Helper Bot". It has no chat slug.
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(BOT_REGISTRY_ADDITIONS_SETTING, JSON.stringify([{ id: 'grok-helper', name: 'Helper Bot' }]))
    grantBotWorkspace('ops-helper', A, 'admin')
    const helper = { ...builtinDev(), slug: 'ops-helper', name: 'Helper Bot' }
    expect(chatOwnerBotName(helper, db)).toBe('ops-helper')

    const out = runTool(ctxFor(ADMIN, helper, os.tmpdir()), 'create_objective', { title: 'Helper work', description: 'x' })
    const card = reviewed(out.objective_id!)
    expect(card.agent_context).toBe('ops-helper')
    expect(card.owner_bot).toBe('ops-helper')
    const r = ask(card, 'Helper Bot')
    expect(r.eligible).toBe(false)
    expect(r.refusal).toBe('not_bot_owned')

    // Even if the display name IS on the card (filed before the twin was
    // registered, or written by hand), the twin does not own a chat bot's card.
    db.prepare(`UPDATE objectives SET owner_bot = 'Helper Bot' WHERE id = ?`).run(card.id)
    const forced = ask(row(card.id), 'Helper Bot')
    expect(forced.eligible).toBe(false)
    expect(forced.refusal).toBe('not_bot_owned')
  })

  it("unchanged: the twin still closes its OWN reviewed card, and a chat slug's registered bot closes the chat bot's card", () => {
    const db = getDb()
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      BOT_REGISTRY_ADDITIONS_SETTING,
      JSON.stringify([{ id: 'grok-helper', name: 'Helper Bot' }, { id: 'grok-ops', name: 'Ops Bot', agent_slugs: ['ops-two'] }]),
    )
    const own = db.prepare(`INSERT INTO objectives (title, agent_context, workspace, type, status, owner_bot, model) VALUES ('Twin own card', 'general', ?, 'task', 'queue', 'Helper Bot', 'm')`).run(A)
    expect(ask(reviewed(Number(own.lastInsertRowid)), 'Helper Bot').eligible).toBe(true)

    grantBotWorkspace('ops-two', A, 'admin')
    const two = { ...builtinDev(), slug: 'ops-two', name: 'Ops Two' }
    const out = runTool(ctxFor(ADMIN, two, os.tmpdir()), 'create_objective', { title: 'Registered chat bot work', description: 'x' })
    const card = reviewed(out.objective_id!)
    expect(card.agent_context).toBe('ops-two')
    expect(ask(card, 'grok-ops').eligible).toBe(true)
    expect(ask(card, 'Helper Bot').eligible).toBe(false)
  })
})
