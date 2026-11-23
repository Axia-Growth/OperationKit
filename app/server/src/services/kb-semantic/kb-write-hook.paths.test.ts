/**
 * Every knowledge-base write path fires BOTH re-index hooks (obj 900965).
 *
 * The two halves are spied at their real seams, not at noteKbChanged, so a
 * path that called only one half (the bug this card fixes) fails here:
 *   - semantic: the WriteQueue that noteKbWrite enqueues into
 *   - graph:    noteKbFileWritten in kb-wiki/graph-sync
 * Each test drives the real write path against a temp knowledge base and
 * checks both spies got the file that was written.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const spies = vi.hoisted(() => ({ semantic: vi.fn(), graph: vi.fn() }))

vi.mock('./indexer.js', async importOriginal => {
  const real = await importOriginal<typeof import('./indexer.js')>()
  class SpyQueue {
    enqueue(file: string): void { spies.semantic(file) }
    async idle(): Promise<void> { /* nothing queued */ }
    get size(): number { return 0 }
  }
  return { ...real, WriteQueue: SpyQueue }
})
vi.mock('../kb-wiki/graph-sync.js', async importOriginal => {
  const real = await importOriginal<typeof import('../kb-wiki/graph-sync.js')>()
  return { ...real, noteKbFileWritten: (abs: string) => { spies.graph(abs); return null } }
})

// One knowledge base for every module: they all resolve it through knowledgeBaseRoot().
const KB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kb-hook-paths-')))
const TMP_DB = path.join(os.tmpdir(), `cc-kb-hook-paths-${process.pid}-${Date.now()}.db`)
for (const name of ['SECOND_BRAIN_ROOT', 'SECOND_BRAIN_DIR', 'KNOWLEDGE_BASE_DIR']) delete process.env[name]
process.env.VAULT_PATH = KB
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-kb-hook-paths-xxxx'

const { initDb, getDb } = await import('../../db/index.js')
const { noteKbChanged, setProviderOverride } = await import('./service.js')
const contacts = await import('../contacts.js')
const loops = await import('../loops.js')
const granola = await import('../granola-content.js')
const { runTool } = await import('../agent-chat/tools.js')
const { seedExistingBotsOnce } = await import('../agent-chat/bot-workspaces.js')
const { default: internalVaultRouter } = await import('../../routes/internal-vault.js')
type Agent = import('../agent-chat/agent-defs.js').ChatAgent
type ContentOwner = import('../content-owners.js').ContentOwner

let server: http.Server
let baseUrl: string

/** Let the graph half (queued with setImmediate) run. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

/** Both hooks were told about `abs`. */
async function expectBothHooks(abs: string): Promise<void> {
  await settle()
  expect(spies.semantic.mock.calls.map(c => c[0]), 'semantic hook (noteKbWrite)').toContain(abs)
  expect(spies.graph.mock.calls.map(c => c[0]), 'graph hook (noteKbFileWritten)').toContain(abs)
}

async function post(route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/internal${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

const CONTACT_REL = 'personal/contacts/alice.md'
const CONTACT_ABS = path.join(KB, CONTACT_REL)

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  // Without an override noteKbWrite is a no-op under vitest. null = "semantic off",
  // which still reaches the queue (the spy).
  setProviderOverride(null)

  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalVaultRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  setProviderOverride(undefined)
  await new Promise<void>(resolve => server.close(() => resolve()))
  await settle()
  try { getDb().close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${TMP_DB}${suffix}`) } catch { /* not there */ } }
  fs.rmSync(KB, { recursive: true, force: true })
})

beforeEach(async () => {
  await settle()
  spies.semantic.mockClear()
  spies.graph.mockClear()
  fs.mkdirSync(path.dirname(CONTACT_ABS), { recursive: true })
  fs.writeFileSync(CONTACT_ABS, '---\ntype: contact\nname: Alice\nemail: alice@example.com\n---\n# Alice\n')
})

describe('noteKbChanged', () => {
  it('calls the semantic hook now and the graph hook after the current tick, for every path', async () => {
    noteKbChanged('/kb/a.md', null, '', undefined, '/kb/b.md')
    expect(spies.semantic.mock.calls.map(c => c[0])).toEqual(['/kb/a.md', '/kb/b.md'])
    expect(spies.graph).not.toHaveBeenCalled() // never on the write's own tick
    await settle()
    expect(spies.graph.mock.calls.map(c => c[0])).toEqual(['/kb/a.md', '/kb/b.md'])
  })

  it('does nothing for no path', async () => {
    noteKbChanged(null, undefined, '')
    await settle()
    expect(spies.semantic).not.toHaveBeenCalled()
    expect(spies.graph).not.toHaveBeenCalled()
  })
})

describe('internal vault routes (routes/internal-vault.ts)', () => {
  it('append-note', async () => {
    const r = await post('/vault/append-note', { path: CONTACT_REL, text: 'Met at the conference' })
    expect(r.status).toBe(200)
    expect(fs.readFileSync(CONTACT_ABS, 'utf8')).toContain('Met at the conference')
    await expectBothHooks(CONTACT_ABS)
  })

  it('append-touchpoint', async () => {
    const r = await post('/vault/append-touchpoint', { path: CONTACT_REL, date: '2026-11-01', summary: 'Call about pricing', channel: 'phone' })
    expect(r.status).toBe(200)
    expect(fs.readFileSync(CONTACT_ABS, 'utf8')).toContain('Call about pricing')
    await expectBothHooks(CONTACT_ABS)
  })

  it('update-field', async () => {
    const r = await post('/vault/update-field', { path: CONTACT_REL, field: 'company', value: 'Acme' })
    expect(r.status).toBe(200)
    expect(fs.readFileSync(CONTACT_ABS, 'utf8')).toContain('Acme')
    await expectBothHooks(CONTACT_ABS)
  })

  it('create-contact', async () => {
    const r = await post('/vault/create-contact', { name: 'Bob Builder', email: 'bob@example.com' })
    expect(r.status).toBe(200)
    const abs = path.join(KB, String(r.json.path))
    expect(fs.existsSync(abs)).toBe(true)
    await expectBothHooks(abs)
  })
})

describe('contacts (services/contacts.ts)', () => {
  it('createContact', async () => {
    const made = contacts.createContact(getDb(), KB, { name: 'Carol Jones', workspace: 'personal' })
    expect(fs.existsSync(made.absolute_path)).toBe(true)
    await expectBothHooks(made.absolute_path)
  })

  it('patchContact', async () => {
    contacts.patchContact(getDb(), KB, CONTACT_REL, { company: 'Initech' })
    expect(fs.readFileSync(CONTACT_ABS, 'utf8')).toContain('Initech')
    await expectBothHooks(CONTACT_ABS)
  })
})

describe('loops (services/loops.ts)', () => {
  const loopsDir = () => path.join(KB, 'workspaces', loops.LOOPS_WORKSPACE, 'loops')
  const loopAbs = (slug: string) => path.join(loopsDir(), `${slug}.md`)

  async function newLoop(title: string): Promise<string> {
    const r = loops.createLoop({ party: 'Dana', title })
    expect(r.ok).toBe(true)
    const slug = r.loop!.slug
    await settle()
    spies.semantic.mockClear()
    spies.graph.mockClear()
    return slug
  }

  it('createLoop', async () => {
    const r = loops.createLoop({ party: 'Dana', title: 'Send the proposal' })
    expect(r.ok).toBe(true)
    await expectBothHooks(loopAbs(r.loop!.slug))
  })

  it('patchLoopBody', async () => {
    const slug = await newLoop('Body loop')
    expect(loops.patchLoopBody(slug, 'New body text').ok).toBe(true)
    await expectBothHooks(loopAbs(slug))
  })

  it('patchLoopStatus', async () => {
    const slug = await newLoop('Status loop')
    expect(loops.patchLoopStatus(slug, 'done').ok).toBe(true)
    await expectBothHooks(loopAbs(slug))
  })

  it('patchLoopMeta', async () => {
    const slug = await newLoop('Meta loop')
    expect(loops.patchLoopMeta(slug, { party: 'Erin', due: '2026-12-01' }).ok).toBe(true)
    await expectBothHooks(loopAbs(slug))
  })

  it('migrateLoopFiles (a rewrite of an old-format file)', async () => {
    fs.mkdirSync(loopsDir(), { recursive: true })
    const abs = loopAbs('old-format-loop')
    fs.writeFileSync(abs, '---\ntitle: Old format\nstatus: open\n---\nbody\n')
    const r = loops.migrateLoopFiles()
    expect(r.rewritten).toBeGreaterThan(0)
    await expectBothHooks(abs)
  })

  it('archiveLoop (a move): both the old and the new path', async () => {
    const slug = await newLoop('Archive loop')
    expect(loops.archiveLoop(slug).ok).toBe(true)
    const from = loopAbs(slug)
    const to = path.join(KB, 'workspaces', loops.LOOPS_WORKSPACE, 'loops-archive', `${slug}.md`)
    expect(fs.existsSync(from)).toBe(false)
    expect(fs.existsSync(to)).toBe(true)
    await expectBothHooks(from)
    await expectBothHooks(to)
  })
})

describe('content drafts and hooks (services/granola-content.ts)', () => {
  const owner: ContentOwner = {
    user_id: 1, vault_workspace: 'content-ws', founder_slug: 'founder', display_name: 'Founder',
    routine_name: 'content:founder', enabled: 1, created_at: '2026-11-01T00:00:00Z',
  }
  const draftAbs = path.join(KB, 'workspaces', 'content-ws', 'content', 'drafts', 'post.md')
  const hookAbs = path.join(KB, 'workspaces', 'content-ws', 'content', 'hooks', 'hook.md')

  beforeEach(() => {
    fs.mkdirSync(path.dirname(draftAbs), { recursive: true })
    fs.mkdirSync(path.dirname(hookAbs), { recursive: true })
    fs.writeFileSync(draftAbs, '---\ntitle: Post\nstatus: draft\n---\nFirst version\n')
    fs.writeFileSync(hookAbs, '---\ntitle: Hook\n---\nHook body\n')
  })

  it('patchDraftStatus', async () => {
    expect(granola.patchDraftStatus(owner, 'post.md', 'ready').ok).toBe(true)
    expect(fs.readFileSync(draftAbs, 'utf8')).toContain('status: ready')
    await expectBothHooks(draftAbs)
  })

  it('patchDraftBody', async () => {
    expect(granola.patchDraftBody(owner, 'post.md', 'Second version').ok).toBe(true)
    expect(fs.readFileSync(draftAbs, 'utf8')).toContain('Second version')
    await expectBothHooks(draftAbs)
  })

  it('addHookVideo / removeHookVideo', async () => {
    const meta = { path: 'content-ws/hook/1-take.mp4' } as Parameters<typeof granola.addHookVideo>[2]
    expect(granola.addHookVideo(owner, 'hook.md', meta).ok).toBe(true)
    expect(fs.readFileSync(hookAbs, 'utf8')).toContain('1-take.mp4')
    await expectBothHooks(hookAbs)

    spies.semantic.mockClear()
    spies.graph.mockClear()
    expect(granola.removeHookVideo(owner, 'hook.md', 'content-ws/hook/1-take.mp4').ok).toBe(true)
    expect(fs.readFileSync(hookAbs, 'utf8')).not.toContain('1-take.mp4')
    await expectBothHooks(hookAbs)
  })
})

describe('chat write_doc (services/agent-chat/tools.ts)', () => {
  const agent: Agent = {
    slug: 'kb-hook-writer', name: 'Writer', description: '', avatar: '', colour: 'blue',
    system_prompt: 'You write notes.', knowledge_folders: ['notes'], tools: ['write_doc'],
    model: null, provider: null, schedules: [], version: null, author: null,
    how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
  }

  it('write_doc', async () => {
    const db = getDb()
    db.prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`).run()
    seedExistingBotsOnce([agent.slug]) // a bot from before per-bot workspace lists: unrestricted
    fs.mkdirSync(path.join(KB, 'notes'), { recursive: true }) // the bot's folder exists at the knowledge-base root
    const ctx = { userId: 1, username: 'admin', workspace: '', agent, kbRoot: KB, connectors: { mail: null, calendar: null } }
    const out = runTool(ctx, 'write_doc', { path: 'notes/meeting.md', content: '# Meeting\n' })
    expect(out.result).toMatchObject({ saved: 'notes/meeting.md' })
    const abs = path.join(KB, 'notes', 'meeting.md')
    expect(fs.readFileSync(abs, 'utf8')).toBe('# Meeting\n')
    await expectBothHooks(abs)
  })
})
