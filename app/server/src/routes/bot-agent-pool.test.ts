/**
 * obj 900948 — High Agency bots blocked by the workspace agent pool, chat-filed
 * cards landing unowned, and built-in bots' knowledge folders on a
 * workspaces/<ws>/ knowledge base.
 *
 * Real DB, real objectives + internal routers. Fixtures only (temp DB + temp KB).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-bot-agent-pool-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-bot-agent-pool-xxxx'

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: internalRouter } = await import('./internal.js')
const { checkAgentInWorkspacePool } = await import('./objectives-helpers.js')
const { grantBotWorkspace, setBotWorkspaces, seedExistingBotsOnce, SEED_MARKER } = await import('../services/agent-chat/bot-workspaces.js')
const { runTool, runChatTool, kbWorkspacesForChat } = await import('../services/agent-chat/tools.js')
const { workspaceFor, systemPromptFor } = await import('../services/agent-chat/engine.js')
const { parseAgentText, BUILTIN_DIR } = await import('../services/agent-chat/agent-defs.js')
const { resolveKnowledgeFolders, withResolvedKnowledgeFolders } = await import('../services/agent-chat/knowledge-folders.js')
type Agent = import('../services/agent-chat/agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const OK = 'operationkit'
const EXAMPLE = 'your-org'
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

const row = (id: number) => getDb().prepare('SELECT agent_context, owner_bot, workspace FROM objectives WHERE id = ?').get(id) as Loose

/** The built-in Operation Kit Dev bot exactly as shipped. */
function builtinDev(): Agent {
  const file = path.join(BUILTIN_DIR, DEV, 'agent.md')
  const parsed = parseAgentText(fs.readFileSync(file, 'utf8'), file, DEV, 'builtin')
  if (!parsed.agent) throw new Error(`built-in ${DEV} did not parse: ${parsed.errors.join('; ')}`)
  return parsed.agent
}

function chatCtx(a: Agent, kbRoot: string) {
  return { userId: ADMIN, username: 'admin', workspace: workspaceFor(ADMIN, a.slug), agent: a, kbRoot, connectors: { mail: null, calendar: null } }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO settings (key, value) VALUES ('duplicate_guard_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`).run()
  // The live shape (OVH, Nov 15): both workspaces have the five-persona pool.
  createWorkspace({ slug: OK, name: 'Operation Kit', default_agent_pool: POOL })
  createWorkspace({ slug: EXAMPLE, name: 'Example Growth', default_agent_pool: POOL })
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
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM agent_chat_bot_access').run()
  db.prepare('DELETE FROM agent_chat_bot_workspaces').run()
  db.prepare('DELETE FROM settings WHERE key = ?').run(SEED_MARKER)
})

// ── 1. the agent-pool gate ────────────────────────────────────────────────────

describe('agent-pool gate: a bot granted the workspace passes, nothing else changes', () => {
  it('checkAgentInWorkspacePool: granted bot passes; ungranted workspace, unrestricted bot and unknown agents refuse; personas unchanged', () => {
    // No access row at all (a bot added after the migration) — refused, as before.
    expect(checkAgentInWorkspacePool(OK, DEV)).toMatch(/not in workspace 'operationkit' pool/)
    grantBotWorkspace(DEV, OK, 'admin')
    expect(checkAgentInWorkspacePool(OK, DEV)).toBeNull()
    // Granted operationkit only: your-org is still refused.
    expect(checkAgentInWorkspacePool(EXAMPLE, DEV)).toMatch(/not in workspace 'your-org' pool/)
    // Worker personas: pool members pass, non-members refuse, exactly as before.
    expect(checkAgentInWorkspacePool(OK, 'cto')).toBeNull()
    expect(checkAgentInWorkspacePool(OK, 'cmo')).toMatch(/not in workspace 'operationkit' pool/)
    // An unrestricted bot (predates access lists, nothing granted) is NOT a grant.
    seedExistingBotsOnce(['legacy-bot'])
    expect(checkAgentInWorkspacePool(OK, 'legacy-bot')).toMatch(/not in workspace/)
  })

  it('POST /api/objectives: granted bot slug is accepted, ungranted is refused', async () => {
    grantBotWorkspace(DEV, OK, 'admin')
    const ok = await call('POST', '/api/objectives', { title: 'Dev audit (granted)', workspace: OK, agent_context: DEV })
    expect(ok.status, JSON.stringify(ok.json)).toBe(201)
    expect(row(ok.json.id).agent_context).toBe(DEV)
    const no = await call('POST', '/api/objectives', { title: 'Dev audit (ungranted)', workspace: EXAMPLE, agent_context: DEV })
    expect(no.status).toBe(400)
    expect(no.json.error).toMatch(/Agent 'operation-kit-dev' is not in workspace 'your-org' pool/)
    const persona = await call('POST', '/api/objectives', { title: 'Persona not in pool', workspace: OK, agent_context: 'cmo' })
    expect(persona.status).toBe(400)
  })

  it('PUT /api/objectives/:id: re-assigning to the granted bot works (the #900940 case); ungranted refuses', async () => {
    const made = await call('POST', '/api/objectives', { title: 'Card to hand over', workspace: OK })
    expect(made.status).toBe(201)
    const id = made.json.id
    // Before the grant: the exact live error.
    const before = await call('PUT', `/api/objectives/${id}`, { agent_context: DEV })
    expect(before.status).toBe(400)
    expect(before.json.error).toMatch(/Agent 'operation-kit-dev' is not in workspace 'operationkit' pool/)
    grantBotWorkspace(DEV, OK, 'admin')
    const after = await call('PUT', `/api/objectives/${id}`, { agent_context: DEV })
    expect(after.status, JSON.stringify(after.json)).toBe(200)
    expect(row(id).agent_context).toBe(DEV)
    // Moving the bot's card to a workspace it is not granted is refused.
    const move = await call('PUT', `/api/objectives/${id}`, { workspace: EXAMPLE })
    expect(move.status).toBe(400)
    expect(row(id).workspace).toBe(OK)
  })

  it('POST /api/internal/objectives (the High Agency wake path): granted bot files its own card; ungranted refuses', async () => {
    grantBotWorkspace(DEV, OK, 'admin')
    const ok = await call('POST', '/api/internal/objectives', [{ title: 'Wake-filed project', workspace: OK, agent_context: DEV, type: 'task' }])
    expect(ok.status, JSON.stringify(ok.json)).toBe(201)
    expect(row(ok.json.objectives[0].id).agent_context).toBe(DEV)
    const no = await call('POST', '/api/internal/objectives', [{ title: 'Wake-filed elsewhere', workspace: EXAMPLE, agent_context: DEV, type: 'task' }])
    expect(no.status).toBe(400)
    expect(no.json.error).toMatch(/agent 'operation-kit-dev' not in workspace 'your-org' pool/)
    const persona = await call('POST', '/api/internal/objectives', [{ title: 'Persona not in pool', workspace: OK, agent_context: 'cmo', type: 'task' }])
    expect(persona.status).toBe(400)
    const revoked = (setBotWorkspaces(DEV, [], 'admin'), await call('POST', '/api/internal/objectives', [{ title: 'After revoke', workspace: OK, agent_context: DEV, type: 'task' }]))
    expect(revoked.status).toBe(400)
  })
})

// ── 2. chat create_objective ──────────────────────────────────────────────────

describe('chat create_objective: the filing bot owns the card', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-pool-kb-'))
  afterAll(() => fs.rmSync(kb, { recursive: true, force: true }))

  it('an unregistered bot (Operation Kit Dev) granted the workspace: agent_context = its slug, owner_bot = its name', () => {
    grantBotWorkspace(DEV, OK, 'admin')
    const dev = builtinDev()
    const out = runTool(chatCtx(dev, kb), 'create_objective', { title: 'Audit the integrations', description: 'x' })
    const r = row(out.objective_id!)
    expect(r.workspace).toBe(OK)
    expect(r.agent_context).toBe(DEV)
    expect(r.owner_bot).toBe('Operation Kit Dev')
  })

  it('a registered bot keeps its canonical registry owner_bot and now works the card under its own slug', () => {
    grantBotWorkspace('your-org-cfo', OK, 'admin')
    const cfo = { ...builtinDev(), slug: 'your-org-cfo', name: 'CFO' }
    const out = runTool(chatCtx(cfo, kb), 'create_objective', { title: 'Close the books', description: 'x' })
    const r = row(out.objective_id!)
    expect(r.agent_context).toBe('your-org-cfo')
    expect(r.owner_bot).toBe('Grok: CFO')
  })

  it('a bot whose slug the pool would refuse (unrestricted, never granted) falls back to the workspace default agent, unowned', () => {
    seedExistingBotsOnce(['legacy-bot'])
    const legacy = { ...builtinDev(), slug: 'legacy-bot', name: 'Legacy' }
    const out = runTool({ ...chatCtx(legacy, kb), workspace: OK }, 'create_objective', { title: 'Legacy filing', description: 'x' })
    const r = row(out.objective_id!)
    expect(r.agent_context).toBe('general')
    expect(r.owner_bot).toBeNull()
  })
})

// ── 3. built-in knowledge folders on both KB layouts ─────────────────────────

describe('built-in bot knowledge folders: workspaces/<ws>/ layout and legacy layout', () => {
  const wsKb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-pool-wskb-'))
  const legacyKb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-pool-legacykb-'))
  beforeAll(() => {
    for (const [root, rel, text] of [
      [wsKb, 'workspaces/operationkit/business/profile.md', 'Operation Kit profile: we sell zebrafish automation'],
      [wsKb, 'workspaces/operationkit/products/kit.md', 'The kit product'],
      [wsKb, 'workspaces/your-org/business/profile.md', 'Example profile: SECRET zebrafish numbers'],
      [legacyKb, 'business/profile.md', 'Legacy profile: we sell zebrafish automation'],
      [legacyKb, 'topics/ideas.md', 'ideas'],
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), text)
    }
  })
  afterAll(() => {
    fs.rmSync(wsKb, { recursive: true, force: true })
    fs.rmSync(legacyKb, { recursive: true, force: true })
  })

  it('workspaces/<ws>/ KB: folders resolve to the granted workspace; list_folders, read_file and search find content', async () => {
    grantBotWorkspace(DEV, OK, 'admin')
    const dev = builtinDev()
    expect(dev.knowledge_folders).toEqual(['business', 'organizations', 'products', 'projects', 'topics'])
    const c = chatCtx(dev, wsKb)

    const listed = (runTool(c, 'list_folders', {}).result as Loose).folders
    expect(listed).toEqual(['business', 'organizations', 'products', 'projects', 'topics'].map(f => `workspaces/${OK}/${f}`))
    const inside = (runTool(c, 'list_folders', { path: `workspaces/${OK}/business` }).result as Loose).items.map((i: Loose) => i.name)
    expect(inside).toEqual(['profile.md'])

    const read = runTool(c, 'read_file', { path: `workspaces/${OK}/business/profile.md` }).result as Loose
    expect(read.content).toMatch(/Operation Kit profile/)
    // The ungranted workspace stays walled off.
    expect(() => runTool(c, 'read_file', { path: `workspaces/${EXAMPLE}/business/profile.md` })).toThrow()

    const hits = (runTool(c, 'search', { q: 'zebrafish' }).result as Loose).results.map((h: Loose) => h.path)
    expect(hits).toEqual([`workspaces/${OK}/business/profile.md`])
    // The async entry point the engine uses (hybrid → keyword fallback) agrees.
    const viaEngine = (await runChatTool(c, 'search', { q: 'zebrafish', mode: 'keyword' })).result as Loose
    expect(viaEngine.results.map((h: Loose) => h.path)).toEqual([`workspaces/${OK}/business/profile.md`])

    // The bot's own instructions say `business/profile.md`: that short form
    // resolves inside the chat's workspace folder (read and write).
    expect(c.workspace).toBe(OK)
    expect((runTool(c, 'read_file', { path: 'business/profile.md' }).result as Loose).content).toMatch(/Operation Kit profile/)
    runTool(c, 'write_doc', { path: 'business/automation-ideas.md', content: '# Ideas\n' })
    expect(fs.existsSync(path.join(wsKb, `workspaces/${OK}/business/automation-ideas.md`))).toBe(true)
    expect(fs.existsSync(path.join(wsKb, 'business/automation-ideas.md'))).toBe(false)
    // The short form never reaches outside the knowledge folders.
    expect(() => runTool(c, 'read_file', { path: '../etc/passwd' })).toThrow()

    // The prompt names the same folders the tools accept, and explains the short form.
    const prompt = systemPromptFor(withResolvedKnowledgeFolders(dev, wsKb, kbWorkspacesForChat(ADMIN, DEV)), { username: 'admin', now: new Date(), connectors: [], workspace: OK, userId: ADMIN })
    expect(prompt).toContain(`workspaces/${OK}/business`)
    expect(prompt).not.toMatch(/paths are relative\): business,/)
    expect(prompt).toContain(`a path like business/profile.md in your instructions means workspaces/${OK}/business/profile.md`)
  })

  it('legacy KB (folders at the root): unchanged — list_folders, read_file and search work as before', () => {
    grantBotWorkspace(DEV, OK, 'admin')
    const dev = builtinDev()
    const c = chatCtx(dev, legacyKb)
    expect((runTool(c, 'list_folders', {}).result as Loose).folders).toEqual(['business', 'organizations', 'products', 'projects', 'topics'])
    expect((runTool(c, 'read_file', { path: 'business/profile.md' }).result as Loose).content).toMatch(/Legacy profile/)
    const hits = (runTool(c, 'search', { q: 'zebrafish' }).result as Loose).results.map((h: Loose) => h.path)
    expect(hits).toEqual(['business/profile.md'])
    const prompt = systemPromptFor(withResolvedKnowledgeFolders(dev, legacyKb, kbWorkspacesForChat(ADMIN, DEV)), { username: 'admin', now: new Date(), connectors: [] })
    expect(prompt).toContain('paths are relative): business, organizations, products, projects, topics.')
  })

  it('resolveKnowledgeFolders: root folder wins, workspaces/ paths are kept, idempotent, only the workspaces it is handed', () => {
    const a = { slug: 'x', knowledge_folders: ['business', 'workspaces/operationkit/notes', 'nope'] }
    const once = resolveKnowledgeFolders(a, wsKb, [OK])
    expect(once).toEqual([`workspaces/${OK}/business`, 'workspaces/operationkit/notes', `workspaces/${OK}/nope`])
    expect(resolveKnowledgeFolders({ slug: 'x', knowledge_folders: once }, wsKb, [OK])).toEqual(once)
    expect([...resolveKnowledgeFolders({ slug: 'x', knowledge_folders: ['business'] }, wsKb, [EXAMPLE, OK])].sort()).toEqual([`workspaces/${EXAMPLE}/business`, `workspaces/${OK}/business`].sort())
    // No workspace granted → no folder (the workspace wall would refuse them all anyway).
    expect(resolveKnowledgeFolders({ slug: 'x', knowledge_folders: ['business'] }, wsKb, [])).toEqual([])
    // Legacy: a folder at the root is kept even when workspaces/ also exists.
    fs.mkdirSync(path.join(wsKb, 'topics'), { recursive: true })
    expect(resolveKnowledgeFolders({ slug: 'x', knowledge_folders: ['topics'] }, wsKb, [OK])).toEqual(['topics'])
    expect(resolveKnowledgeFolders({ slug: 'x', knowledge_folders: ['business'] }, legacyKb, [OK])).toEqual(['business'])
  })
})
