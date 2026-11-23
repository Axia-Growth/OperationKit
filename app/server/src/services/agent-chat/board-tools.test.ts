// Chat board tools read the REAL board, scoped exactly like the board UI (obj 900623).
//
// The bug: list_objectives / get_objective only read agent_chat_cards (cards the
// chat itself filed), so a General asked "what is waiting on me?" got zero
// rows and reported an empty board while the workspace had cards in review.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-board-tools-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-chat-board-tools-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-board-kb-'))

// obj 900951: lets one test make the search index throw. Every other call goes to the real search.
const searchIndex = vi.hoisted(() => ({ fail: null as Error | null }))
vi.mock('../kb-semantic/search.js', async importOriginal => {
  const real = await importOriginal<typeof import('../kb-semantic/search.js')>()
  return {
    ...real,
    searchKnowledgeBase: (...a: Parameters<typeof real.searchKnowledgeBase>) => {
      if (searchIndex.fail) return Promise.reject(searchIndex.fail)
      return real.searchKnowledgeBase(...a)
    },
  }
})

const { initDb, getDb } = await import('../../db/index.js')
const { runTool, runChatTool, toolSpecsFor, ToolUseError, chatCardAgent, chatOwnerBotName } = await import('./tools.js')
const { seedExistingBotsOnce } = await import('./bot-workspaces.js')
type Agent = import('./agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const ALICE = 2 // member of growth + quiet-co; owns the growth cards (the trial General's person)
const BOB = 3 // member of other-co only
const CAROL = 4 // member of growth too, but owns only one card there
const NOBODY = 5 // no memberships at all
const GROWTH = 'growth'
const OTHER = 'other-co'
const EMPTY_WS = 'quiet-co'

const agent: Agent = {
  slug: 'growth-general',
  name: 'General',
  description: '',
  avatar: '',
  colour: 'blue',
  system_prompt: 'You keep the person on top of their board.',
  knowledge_folders: [],
  tools: ['get_objective', 'list_objectives'],
  model: null,
  provider: null,
  schedules: [],
  version: null,
  author: null,
  how_to_use: '',
  example_prompts: [],
  source: 'file',
  file: '/dev/null',
}

function ctx(userId: number, a: Agent = agent) {
  return { userId, username: `user${userId}`, workspace: GROWTH, agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } }
}

const ids: Record<string, number> = {}
function card(key: string, workspace: string, status: string, extra: { created_by?: number; has_blockers?: number; ai_review_verdict?: string; deleted?: boolean } = {}) {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, has_blockers, ai_review_verdict, deleted_at, updated_at)
       VALUES (?, '', ?, ?, 'task', 'general', ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(key, workspace, status, extra.created_by ?? ADMIN, extra.created_by ?? ADMIN, extra.has_blockers ?? 0, extra.ai_review_verdict ?? null, extra.deleted ? new Date().toISOString() : null)
  ids[key] = Number(r.lastInsertRowid)
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const users: [number, string][] = [[ADMIN, 'admin'], [ALICE, 'member'], [BOB, 'member'], [CAROL, 'member'], [NOBODY, 'member']]
  for (const [id, role] of users) db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`).run(id, `user${id}`, role)
  // obj 900797: these bots stand for bots that existed before per-bot workspace
  // access lists, so the one-time boot seed keeps them unrestricted (today's
  // behaviour). The restricted path is covered in bot-workspaces.test.ts.
  seedExistingBotsOnce(['growth-general', 'librarian', 'operation-kit-dev', 'notes-only'])
  for (const ws of [GROWTH, OTHER, EMPTY_WS]) db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(ws, ws)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(ALICE, GROWTH)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(ALICE, EMPTY_WS)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(BOB, OTHER)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(CAROL, GROWTH)

  // The growth board as the trial found it: several cards in review, none filed from chat.
  card('growth-review-1', GROWTH, 'review', { created_by: ALICE })
  card('growth-review-2', GROWTH, 'review', { created_by: ALICE, ai_review_verdict: 'fail' })
  card('growth-queue', GROWTH, 'queue', { created_by: ALICE })
  card('growth-working-blocked', GROWTH, 'working', { created_by: ALICE, has_blockers: 1 })
  card('growth-done', GROWTH, 'done', { created_by: ALICE })
  card('growth-deleted', GROWTH, 'review', { created_by: ALICE, deleted: true })
  card('growth-carols', GROWTH, 'queue', { created_by: CAROL })
  // Another tenant's board.
  card('other-review-SECRET', OTHER, 'review', { created_by: BOB })
  card('other-working-SECRET', OTHER, 'working', { created_by: BOB })
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

const titles = (r: Loose) => (r.cards as Loose[]).map(c => c.title).sort()

describe('chat list_objectives reads the real board', () => {
  it('a workspace member sees their workspace cards (review, queue, working, blocked) — not just chat-filed ones', () => {
    const r = runTool(ctx(ALICE), 'list_objectives', {}).result as Loose
    expect(titles(r)).toEqual(['growth-queue', 'growth-review-1', 'growth-review-2', 'growth-working-blocked'])
    expect(r.counts).toEqual({ review: 2, queue: 1, working: 1, blocked: 1 })
    expect(r.total).toBe(4)
    expect(r.empty).toBe(false)
    expect(r.cards.every((c: Loose) => c.from_this_chat === false)).toBe(true)
    expect(r.cards.find((c: Loose) => c.title === 'growth-working-blocked').has_blockers).toBe(true)
  })

  it('still marks the cards this chat filed', () => {
    getDb().prepare('INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, ?)').run(ids['growth-queue'], ALICE, agent.slug)
    const r = runTool(ctx(ALICE), 'list_objectives', {}).result as Loose
    expect(r.cards.filter((c: Loose) => c.from_this_chat).map((c: Loose) => c.title)).toEqual(['growth-queue'])
    getDb().prepare('DELETE FROM agent_chat_cards WHERE objective_id = ?').run(ids['growth-queue'])
  })

  it('filters one column, including the blocked flag', () => {
    expect(titles(runTool(ctx(ALICE), 'list_objectives', { status: 'review' }).result)).toEqual(['growth-review-1', 'growth-review-2'])
    expect(titles(runTool(ctx(ALICE), 'list_objectives', { status: 'blocked' }).result)).toEqual(['growth-working-blocked'])
    expect(titles(runTool(ctx(ALICE), 'list_objectives', { status: 'done' }).result)).toEqual(['growth-done'])
    expect(() => runTool(ctx(ALICE), 'list_objectives', { status: 'bogus' })).toThrow(/status must be one of/)
  })

  it('never shows another workspace\'s cards, and refuses to read a board the person is not on', () => {
    const r = runTool(ctx(ALICE), 'list_objectives', {}).result as Loose
    expect(JSON.stringify(r)).not.toMatch(/SECRET/)
    expect(r.workspaces).not.toContain(OTHER)
    expect(() => runTool(ctx(ALICE), 'list_objectives', { workspace: OTHER })).toThrow(ToolUseError)
    expect(() => runTool(ctx(ALICE), 'list_objectives', { workspace: OTHER })).toThrow(/can't see the "other-co" board/)
    // A workspace that does not exist reads the same as one that does: no existence oracle.
    expect(() => runTool(ctx(ALICE), 'list_objectives', { workspace: 'no-such-ws' })).toThrow(/can't see the "no-such-ws" board/)

    const bob = runTool(ctx(BOB), 'list_objectives', {}).result as Loose
    expect(titles(bob)).toEqual(['other-review-SECRET', 'other-working-SECRET'])
    expect(JSON.stringify(bob)).not.toMatch(/growth-/)
  })

  it('honours own-only visibility inside a workspace (never wider than the board UI)', () => {
    // Same workspace, but Carol neither created nor is assigned Alice's cards: the
    // board UI hides them from her, so the chat does too.
    const r = runTool(ctx(CAROL), 'list_objectives', {}).result as Loose
    expect(titles(r)).toEqual(['growth-carols'])
    // Being added as an assignee is what puts a card on her board.
    getDb().prepare('INSERT INTO objective_assignees (objective_id, user_id) VALUES (?, ?)').run(ids['growth-review-1'], CAROL)
    expect(titles(runTool(ctx(CAROL), 'list_objectives', {}).result)).toEqual(['growth-carols', 'growth-review-1'])
    getDb().prepare('DELETE FROM objective_assignees WHERE objective_id = ? AND user_id = ?').run(ids['growth-review-1'], CAROL)
  })

  it('admins see every workspace, and can narrow to one', () => {
    const all = runTool(ctx(ADMIN), 'list_objectives', {}).result as Loose
    expect(all.total).toBe(7)
    const other = runTool(ctx(ADMIN), 'list_objectives', { workspace: OTHER }).result as Loose
    expect(titles(other)).toEqual(['other-review-SECRET', 'other-working-SECRET'])
  })

  it('reports empty ONLY when the board truly has nothing open', () => {
    const quiet = runTool(ctx(ALICE), 'list_objectives', { workspace: EMPTY_WS }).result as Loose
    expect(quiet).toMatchObject({ empty: true, total: 0, cards: [] })
    expect(quiet.note).toMatch(/real board/)

    const busy = runTool(ctx(ALICE), 'list_objectives', { workspace: GROWTH }).result as Loose
    expect(busy.empty).toBe(false)

    // Truncation is not emptiness: a small page still says how many there are.
    const page = runTool(ctx(ALICE), 'list_objectives', { limit: 1 }).result as Loose
    expect(page).toMatchObject({ empty: false, total: 4, truncated: true })
    expect(page.cards).toHaveLength(1)

    const lonely = runTool(ctx(NOBODY), 'list_objectives', {}).result as Loose
    expect(lonely).toMatchObject({ empty: true, total: 0, cards: [] })
  })

  it('a deleted card is not on the board', () => {
    const r = runTool(ctx(ADMIN), 'list_objectives', { status: 'review', workspace: GROWTH }).result as Loose
    expect(titles(r)).not.toContain('growth-deleted')
  })

  it('a membership removed mid-conversation takes effect on the next call', () => {
    getDb().prepare('INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, \'member\')').run(BOB, GROWTH)
    getDb().prepare('INSERT INTO objective_assignees (objective_id, user_id) VALUES (?, ?)').run(ids['growth-review-1'], BOB)
    expect(titles(runTool(ctx(BOB), 'list_objectives', { workspace: GROWTH }).result)).toEqual(['growth-review-1'])
    getDb().prepare('DELETE FROM user_workspaces WHERE user_id = ? AND workspace = ?').run(BOB, GROWTH)
    expect(() => runTool(ctx(BOB), 'list_objectives', { workspace: GROWTH })).toThrow(/can't see/)
  })
})

describe('chat get_objective reads any card the person can see', () => {
  it('opens a board card the chat did not file', () => {
    const r = runTool(ctx(ALICE), 'get_objective', { id: ids['growth-review-2'] })
    expect(r.result).toMatchObject({ id: ids['growth-review-2'], status: 'review', workspace: GROWTH, ai_review_verdict: 'fail' })
    expect(r.objective_id).toBe(ids['growth-review-2'])
  })

  it('refuses another workspace\'s card with the same words as a missing one', () => {
    expect(() => runTool(ctx(ALICE), 'get_objective', { id: ids['other-review-SECRET'] })).toThrow(/is not on a board you can see/)
    expect(() => runTool(ctx(ALICE), 'get_objective', { id: 99_999_999 })).toThrow(/is not on a board you can see/)
    expect(() => runTool(ctx(CAROL), 'get_objective', { id: ids['growth-review-1'] })).toThrow(/is not on a board you can see/)
    expect(() => runTool(ctx(ALICE), 'get_objective', { id: ids['growth-deleted'] })).toThrow(/is not on a board you can see/)
  })
})

describe('chat board_briefing: what is waiting on me', () => {
  it('is available to any agent that already lists a board read, and to nobody else', () => {
    expect(toolSpecsFor(agent).map(s => s.function.name)).toContain('board_briefing')
    const noBoard: Agent = { ...agent, slug: 'librarian', tools: ['search'] }
    expect(toolSpecsFor(noBoard).map(s => s.function.name)).not.toContain('board_briefing')
    expect(() => runTool(ctx(ALICE, noBoard), 'board_briefing', {})).toThrow(/not allowed/)
    // Implying a read never implies a write.
    expect(toolSpecsFor(agent).map(s => s.function.name)).not.toContain('create_objective')
  })

  it('lists the cards waiting on the person in their workspace, failed review first', () => {
    const r = runTool(ctx(ALICE), 'board_briefing', {}).result as Loose
    expect(r.empty).toBe(false)
    expect(r.open_total).toBe(4)
    expect(r.columns).toEqual({ review: 2, queue: 1, working: 1, blocked: 1 })
    const waiting = r.waiting_on_you as Loose[]
    expect(waiting.map(i => i.kind)).toEqual(['failed_review', 'blocked', 'review'])
    expect(waiting.map(i => i.id).sort()).toEqual([ids['growth-review-1'], ids['growth-review-2'], ids['growth-working-blocked']].sort())
    expect(waiting[0].url).toMatch(new RegExp(`^https?://[^/]+/o/${ids['growth-review-2']}$`))
    expect(JSON.stringify(r)).not.toMatch(/SECRET/)
  })

  it('stays inside the person\'s workspaces', () => {
    const bob = runTool(ctx(BOB), 'board_briefing', {}).result as Loose
    expect((bob.waiting_on_you as Loose[]).map(i => i.id)).toEqual([ids['other-review-SECRET']])
    expect(JSON.stringify(bob)).not.toMatch(/growth-/)
    expect(() => runTool(ctx(BOB), 'board_briefing', { workspace: GROWTH })).toThrow(/can't see/)
  })

  it('says empty only when the board is empty, and "nothing waiting" when it is not', () => {
    const quiet = runTool(ctx(ALICE), 'board_briefing', { workspace: EMPTY_WS }).result as Loose
    expect(quiet).toMatchObject({ empty: true, open_total: 0, waiting_on_you: [] })

    const carol = runTool(ctx(CAROL), 'board_briefing', {}).result as Loose
    expect(carol).toMatchObject({ empty: false, open_total: 1, waiting_on_you: [] })
    expect(carol.note).toMatch(/Nothing needs a decision right now, but 1 open card/)
  })
})

// obj 900745: Operation Kit Dev stalled on a fresh install — business/profile.md
// did not exist, read_file said only "does not exist", and the model answered
// "I don't have a profile for your business yet" instead of using the board.
describe('missing knowledge file → fallback to folders and board (obj 900745)', () => {
  const okDev: Agent = {
    ...agent,
    slug: 'operation-kit-dev',
    name: 'Operation Kit Dev',
    knowledge_folders: ['business', 'projects'],
    tools: ['search', 'list_folders', 'read_file', 'write_doc', 'create_objective', 'get_objective', 'list_objectives', 'board_briefing'],
  }

  it('the missing-profile error tells the bot how to fall back, naming only tools it has', () => {
    fs.mkdirSync(path.join(TMP_KB, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(TMP_KB, 'projects', 'launch.md'), '# Spring launch\n')
    let msg = ''
    try {
      runTool(ctx(ALICE, okDev), 'read_file', { path: 'business/profile.md' })
    } catch (e) {
      expect(e).toBeInstanceOf(ToolUseError)
      msg = (e as Error).message
    }
    expect(msg).toMatch(/^File "business\/profile\.md" does not exist\./)
    expect(msg).toMatch(/do not stop/)
    expect(msg).toMatch(/list_folders/)
    expect(msg).toMatch(/search the knowledge folders/)
    expect(msg).toMatch(/board_briefing or list_objectives/)

    // …and the fallback it points at actually works in the same state.
    const folders = runTool(ctx(ALICE, okDev), 'list_folders', {}).result as Loose
    // obj 900951: `business` is declared but not on disk, so it is named under `missing`, not listed.
    expect(folders.folders).toEqual(['projects'])
    expect(folders.missing).toEqual(['business'])
    const projects = runTool(ctx(ALICE, okDev), 'list_folders', { path: 'projects' }).result as Loose
    expect(projects.items).toEqual([{ name: 'launch.md', type: 'file' }])
    const brief = runTool(ctx(ALICE, okDev), 'board_briefing', {}).result as Loose
    expect(brief.empty).toBe(false)
    expect(brief.open_total).toBeGreaterThan(0)
  })

  it('a missing folder gets the same hint; a bot without board tools is not told to use them', () => {
    const notesOnly: Agent = { ...okDev, slug: 'notes-only', tools: ['read_file', 'list_folders'] }
    expect(() => runTool(ctx(ALICE, okDev), 'list_folders', { path: 'business' })).toThrow(/Folder "business" does not exist\. .*list_folders/)
    let msg = ''
    try { runTool(ctx(ALICE, notesOnly), 'read_file', { path: 'business/profile.md' }) } catch (e) { msg = (e as Error).message }
    expect(msg).toMatch(/list_folders/)
    expect(msg).not.toMatch(/board_briefing|list_objectives|search the knowledge/)
  })
})

// obj 900951: the built-in bot listed five folders and each then answered "does
// not exist"; a broken search index answered exactly like "nothing found".
describe('knowledge tools tell a broken setup from an empty knowledge base (obj 900951)', () => {
  const okDev: Agent = {
    ...agent,
    slug: 'operation-kit-dev',
    name: 'Operation Kit Dev',
    knowledge_folders: ['business', 'organizations', 'projects'],
    tools: ['search', 'list_folders', 'read_file', 'write_doc'],
  }

  it('list_folders (no path) lists only declared folders on disk and names the rest under missing', () => {
    fs.mkdirSync(path.join(TMP_KB, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(TMP_KB, 'organizations'), 'a file, not a folder')
    try {
      const r = runTool(ctx(ALICE, okDev), 'list_folders', {}).result as Loose
      expect(r.folders).toEqual(['projects'])
      expect(r.missing).toEqual(['business', 'organizations'])
      expect(r.note).toMatch(/do not exist in the knowledge base yet/)
      expect(r.note).toMatch(/write_doc creates a folder/)
      // Every folder it lists really opens.
      for (const f of r.folders) expect(() => runTool(ctx(ALICE, okDev), 'list_folders', { path: f })).not.toThrow()

      const readOnly: Agent = { ...okDev, slug: 'notes-only', tools: ['read_file', 'list_folders'] }
      expect((runTool(ctx(ALICE, readOnly), 'list_folders', {}).result as Loose).note).not.toMatch(/write_doc/)
    } finally {
      fs.rmSync(path.join(TMP_KB, 'organizations'), { force: true })
    }
  })

  it('nothing missing → an empty missing list and no note', () => {
    fs.mkdirSync(path.join(TMP_KB, 'projects'), { recursive: true })
    const r = runTool(ctx(ALICE, { ...okDev, knowledge_folders: ['projects'] }), 'list_folders', {}).result as Loose
    expect(r).toEqual({ folders: ['projects'], missing: [] })
  })

  it('a thrown index error reaches the model as "search index unavailable: <reason>", not {results: []}', async () => {
    fs.mkdirSync(path.join(TMP_KB, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(TMP_KB, 'projects', 'launch.md'), '# Spring launch\n')
    searchIndex.fail = new Error('no such table: kb_vec')
    try {
      // Nothing matches: the model must still learn the index is down.
      const none = await runChatTool(ctx(ALICE, okDev), 'search', { q: 'zebra-quartz-nomatch' })
      const r = none.result as Loose
      expect(r).not.toEqual({ results: [] })
      expect(r.results).toEqual([])
      expect(r.warning).toMatch(/^search index unavailable: no such table: kb_vec\./)
      expect(r.warning).toMatch(/does NOT mean the knowledge base is empty/)
      expect(none.summary).toMatch(/search index unavailable/)

      // Something matches by plain words: the hits come back, with the same warning.
      const some = (await runChatTool(ctx(ALICE, okDev), 'search', { q: 'spring launch' })).result as Loose
      expect(some.results.map((h: Loose) => h.path)).toEqual(['projects/launch.md'])
      expect(some.warning).toMatch(/^search index unavailable: no such table: kb_vec\./)
    } finally {
      searchIndex.fail = null
    }
    // A working index that finds nothing carries no warning.
    const ok = (await runChatTool(ctx(ALICE, okDev), 'search', { q: 'zebra-quartz-nomatch' })).result as Loose
    expect(ok.warning).toBeUndefined()
  })
})

// obj 900958: a bot told to file work under a card used to write "Parent: #N"
// in the text and the link was lost. create_objective now takes parent_id.
describe('chat create_objective files a card under a parent (obj 900958)', () => {
  const filer: Agent = { ...agent, slug: 'operation-kit-dev', name: 'Operation Kit Dev', tools: ['create_objective', 'get_objective', 'list_objectives'] }
  // A bot in the bot registry: its cards are owned by that registry bot.
  const registered: Agent = { ...filer, slug: 'general', name: 'General' }
  // A bot added after per-bot workspace lists shipped: granted growth only.
  const scoped: Agent = { ...filer, slug: 'scoped-filer', name: 'Scoped Filer' }
  const row = (id: number) => getDb().prepare('SELECT parent_id, depth, workspace, origin FROM objectives WHERE id = ?').get(id) as Loose
  const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as Loose).n as number
  const refused = (fn: () => unknown, re: RegExp) => {
    const before = count()
    let err: unknown
    try { fn() } catch (e) { err = e }
    expect(err).toBeInstanceOf(ToolUseError)
    expect((err as Error).message).toMatch(re)
    expect(count()).toBe(before) // nothing was filed
  }

  beforeAll(async () => {
    const { grantBotWorkspace } = await import('./bot-workspaces.js')
    seedExistingBotsOnce(['general']) // the seed already ran: a no-op, so grant it explicitly too
    grantBotWorkspace('general', GROWTH, 'test')
    grantBotWorkspace('scoped-filer', GROWTH, 'test')
  })

  it('the tool spec offers parent_id, and it is optional', () => {
    const spec = toolSpecsFor(filer).find(s => s.function.name === 'create_objective') as Loose
    expect(spec.function.parameters.properties.parent_id).toMatchObject({ type: 'integer' })
    expect(spec.function.parameters.required).toEqual(['title', 'description'])
  })

  // obj 901496 — done_when and stop_conditions on a card filed from chat.
  it('the tool spec offers done_when and stop_conditions, both optional, and tells the bot to fill them', () => {
    const spec = toolSpecsFor(filer).find(s => s.function.name === 'create_objective') as Loose
    expect(spec.function.parameters.properties.done_when).toMatchObject({ type: 'string' })
    expect(spec.function.parameters.properties.stop_conditions).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(spec.function.parameters.required).toEqual(['title', 'description'])
    expect(spec.function.description).toMatch(/done_when/)
    expect(spec.function.description).toMatch(/stop_conditions/)
  })

  it('done_when lands in completion_goal and stop_conditions as one section of the card text, for both kinds of bot', () => {
    const brief = (card: Loose) => getDb().prepare('SELECT description, completion_goal FROM objectives WHERE id = ?').get(card.id) as Loose
    for (const [who, title] of [[filer, 'p1496 brief legacy'], [registered, 'p1496 brief bot job']] as const) {
      const r = runTool(ctx(ALICE, who), 'create_objective', {
        title, description: 'Add the export button.', done_when: 'One open PR, CI green.', stop_conditions: ['it needs a database migration', ' ', 'the button already exists'],
      }).result as Loose
      const got = brief(r)
      expect(got.completion_goal).toBe('One open PR, CI green.')
      expect(got.description).toContain('Add the export button.\n\n## Stop and report if\n- it needs a database migration\n- the button already exists\n\n— ')
    }
  })

  it('neither field = unchanged: no completion goal and no section', () => {
    const r = runTool(ctx(ALICE, filer), 'create_objective', { title: 'p1496 plain card', description: 'd' }).result as Loose
    const got = getDb().prepare('SELECT description, completion_goal FROM objectives WHERE id = ?').get(r.id) as Loose
    expect(got.completion_goal).toBeNull()
    expect(got.description).not.toContain('Stop and report if')
  })

  it('the same ask with a different done_when is a different card, and an exact repeat is the same one', () => {
    const args = { title: 'p1496 replay', description: 'd', done_when: 'A', stop_conditions: ['x'] }
    const a = runTool(ctx(ALICE, filer), 'create_objective', args).result as Loose
    expect((runTool(ctx(ALICE, filer), 'create_objective', args).result as Loose).id).toBe(a.id)
  })

  it('no parent_id = unchanged: a top-level card at depth 0, and no parent_id in the result', () => {
    const r = runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 top-level legacy', description: 'd' }).result as Loose
    expect(row(r.id)).toMatchObject({ parent_id: null, depth: 0, workspace: GROWTH, origin: 'agent_chat' })
    expect(r).not.toHaveProperty('parent_id')
    const b = runTool(ctx(ALICE, registered), 'create_objective', { title: 'p958 top-level bot job', description: 'd' }).result as Loose
    expect(row(b.id)).toMatchObject({ parent_id: null, depth: 0, workspace: GROWTH, origin: 'agent_chat' })
    expect(b).not.toHaveProperty('parent_id')
  })

  it('parent_id is stored and depth derived from the parent (bot outside the registry)', () => {
    const r = runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 child legacy', description: 'd', parent_id: ids['growth-queue'] }).result as Loose
    expect(r.parent_id).toBe(ids['growth-queue'])
    expect(row(r.id)).toMatchObject({ parent_id: ids['growth-queue'], depth: 1, workspace: GROWTH })
  })

  it('parent_id is stored and depth derived from the parent (registered bot, createBotJob)', () => {
    const r = runTool(ctx(ALICE, registered), 'create_objective', { title: 'p958 child bot job', description: 'd', parent_id: ids['growth-queue'] }).result as Loose
    expect(r.parent_id).toBe(ids['growth-queue'])
    expect(row(r.id)).toMatchObject({ parent_id: ids['growth-queue'], depth: 1, workspace: GROWTH })
    // An exact retry (same parent) is still a quiet replay of the same card.
    const retry = runTool(ctx(ALICE, registered), 'create_objective', { title: 'p958 child bot job', description: 'd', parent_id: ids['growth-queue'] }).result as Loose
    expect(retry.id).toBe(r.id)
    // The same request under ANOTHER parent is never answered with the first card
    // (which sits under the wrong parent): the board's duplicate guard says so.
    // obj 901498: it comes back as a possible duplicate, with nothing filed.
    const other = runTool(ctx(ALICE, registered), 'create_objective', { title: 'p958 child bot job', description: 'd', parent_id: ids['growth-review-1'] }).result as Loose
    expect(other).toMatchObject({ filed: false, possible_duplicate: { id: r.id } })
    expect(row(r.id).parent_id).toBe(ids['growth-queue'])
  })

  it('a parent in a workspace the bot is not granted is refused as "not found", in the same words as a missing card', () => {
    // The admin can see other-co; the bot cannot, so the chat cannot either.
    refused(() => runTool(ctx(ADMIN, scoped), 'create_objective', { title: 'p958 x-ws', description: 'd', parent_id: ids['other-review-SECRET'] }), /^Parent card #\d+ was not found on a board you can see/)
    refused(() => runTool(ctx(ADMIN, scoped), 'create_objective', { title: 'p958 missing', description: 'd', parent_id: 99999999 }), /^Parent card #\d+ was not found on a board you can see/)
    // A person outside the parent's workspace gets the same answer, whatever the bot may do.
    refused(() => runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 x-person', description: 'd', parent_id: ids['other-review-SECRET'] }), /was not found on a board you can see/)
    refused(() => runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 deleted', description: 'd', parent_id: ids['growth-deleted'] }), /was not found on a board you can see/)
    // The granted workspace still works for the same bot.
    const ok = runTool(ctx(ADMIN, scoped), 'create_objective', { title: 'p958 scoped ok', description: 'd', parent_id: ids['growth-queue'] }).result as Loose
    expect(row(ok.id)).toMatchObject({ parent_id: ids['growth-queue'], depth: 1, workspace: GROWTH })
  })

  it('a grandchild is refused: cards nest one level only', () => {
    const child = runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 nest child', description: 'd', parent_id: ids['growth-review-1'] }).result as Loose
    refused(() => runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 grandchild', description: 'd', parent_id: child.id }), /nest one level only/)
    refused(() => runTool(ctx(ALICE, registered), 'create_objective', { title: 'p958 grandchild job', description: 'd', parent_id: child.id }), /nest one level only/)
  })

  it('a workspace that is not the parent\'s, and a parent_id that is not a card number, are refused', () => {
    refused(() => runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 ws clash', description: 'd', parent_id: ids['growth-queue'], workspace: EMPTY_WS }), /lands in that card's workspace \(growth\)/)
    refused(() => runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 bad id', description: 'd', parent_id: 'the launch card' }), /parent_id must be a card number/)
    refused(() => runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 bad id 2', description: 'd', parent_id: -3 }), /parent_id must be a card number/)
  })

  it('the per-parent cap on open children holds', () => {
    const db = getDb()
    const parent = ids['growth-working-blocked']
    const ins = db.prepare(`INSERT INTO objectives (title, description, workspace, status, type, category, created_by, parent_id, depth) VALUES (?, '', ?, ?, 'task', 'general', ?, ?, 1)`)
    for (let i = 0; i < 19; i++) ins.run(`p958 cap filler ${i}`, GROWTH, 'queue', ALICE, parent)
    ins.run('p958 cap done', GROWTH, 'done', ALICE, parent) // terminal children do not count
    const last = runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 cap twentieth', description: 'd', parent_id: parent }).result as Loose
    expect(row(last.id).parent_id).toBe(parent)
    refused(() => runTool(ctx(ALICE, filer), 'create_objective', { title: 'p958 cap over', description: 'd', parent_id: parent }), /already has 20 open cards under it \(the limit is 20\)/)
  })
})

// obj 900960 (audit finding 6): a bot outside the bot registry used to file its
// card with a second, unguarded INSERT, so a retried tool call filed a duplicate.
// Every bot now goes through createBotJob.
describe('chat create_objective: one guarded path for every bot (obj 900960)', () => {
  const custom: Agent = { ...agent, slug: 'p960-custom-bot', name: 'Custom Helper', tools: ['create_objective', 'get_objective', 'list_objectives'] }
  const registered: Agent = { ...custom, slug: 'general', name: 'General' }
  const card960 = (id: number) => getDb().prepare('SELECT title, description, parent_id, depth, workspace, origin, category, owner_bot, agent_context, status, created_by, assigned_user_id FROM objectives WHERE id = ?').get(id) as Loose
  const origin = (id: number) => getDb().prepare('SELECT * FROM bot_job_origins WHERE objective_id = ?').get(id) as Loose
  const chatRows = (id: number) => getDb().prepare('SELECT user_id, agent_slug FROM agent_chat_cards WHERE objective_id = ?').all(id) as Loose[]
  const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as Loose).n as number
  const file = (a: Agent, args: Loose, user = ALICE) => runTool(ctx(user, a), 'create_objective', args).result as Loose

  beforeAll(async () => {
    const { grantBotWorkspace } = await import('./bot-workspaces.js')
    const { botForAgentSlug } = await import('../bots/bot-registry.js')
    grantBotWorkspace('p960-custom-bot', GROWTH, 'test')
    grantBotWorkspace('general', GROWTH, 'test')
    // The premise of every test below.
    expect(botForAgentSlug(custom.slug, getDb())).toBeFalsy()
    expect(botForAgentSlug(registered.slug, getDb())).toBeTruthy()
  })

  it('an unregistered bot calling twice with the same title and description gets ONE card; the second call returns the first card\'s number', () => {
    const before = count()
    const first = file(custom, { title: 'p960 retry me', description: 'same ask' })
    expect(first.note).toMatch(/^Card #\d+ EXISTS on the board/)
    const second = file(custom, { title: 'p960 retry me', description: 'same ask' })
    expect(second.id).toBe(first.id)
    expect(second.note).toMatch(/already filed for this request.*NOTHING new was filed/)
    expect(count()).toBe(before + 1)
    // Surrounding whitespace is not a different request.
    expect(file(custom, { title: '  p960 retry me ', description: 'same ask\n' }).id).toBe(first.id)
    expect(count()).toBe(before + 1)
    expect(chatRows(first.id)).toEqual([{ user_id: ALICE, agent_slug: custom.slug }])
  })

  it('the unregistered bot\'s card keeps what it always had: footer, origin, category, owner, worker, parent', () => {
    const r = file(custom, { title: 'p960 shape', description: 'the body', parent_id: ids['growth-queue'] })
    const worker = chatCardAgent(custom, GROWTH)
    const c = card960(r.id)
    expect(c).toMatchObject({
      title: 'p960 shape',
      description: 'the body\n\n— Requested in chat with "Custom Helper" by user2. They follow this card\'s status from that chat.',
      parent_id: ids['growth-queue'],
      depth: 1,
      workspace: GROWTH,
      origin: 'agent_chat',
      category: 'general',
      agent_context: worker.agentContext,
      owner_bot: worker.ownedByBot ? chatOwnerBotName(custom, getDb()) : null,
      created_by: ALICE,
      assigned_user_id: ALICE,
    })
    // Not a registered bot job: no read-only job-mode promise in the card text.
    expect(c.description).not.toMatch(/Job mode/)
    expect(r).toMatchObject({ status: c.status, workspace: GROWTH, parent_id: ids['growth-queue'] })
    expect(chatRows(r.id)).toEqual([{ user_id: ALICE, agent_slug: custom.slug }])
    // The replay key lives on the same origin row a registered bot's job has.
    expect(origin(r.id)).toMatchObject({ thread_user_id: ALICE, thread_agent_slug: custom.slug, owner_bot: c.owner_bot ?? '', workspace: GROWTH })
  })

  it('filing does not start the card: same initial status as before, for both kinds of bot', () => {
    const a = file(custom, { title: 'p960 status custom', description: 'd' })
    const b = file(registered, { title: 'p960 status registered', description: 'd' })
    expect(card960(a.id).status).toBe(card960(b.id).status)
    expect(a.status).toBe(card960(a.id).status)
    expect(['queue', 'backlog']).toContain(a.status)
  })

  it('same title with a different description is held back as a possible duplicate, naming the open card', () => {
    const first = file(custom, { title: 'p960 twin title', description: 'one' })
    const before = count()
    // obj 901498: said in the result ("possible duplicate #N"), not thrown, and nothing is filed.
    const second = file(custom, { title: 'p960 twin title', description: 'two' })
    expect(second).toMatchObject({ filed: false, possible_duplicate: { id: first.id } })
    expect(second.note).toMatch(new RegExp(`Possible duplicate #${first.id}.*NOTHING was filed`))
    expect(count()).toBe(before)
  })

  it('the same request under a parent is its own request: a retry replays it, and it is never answered with a card under another parent', () => {
    const child = file(custom, { title: 'p960 under parent', description: 'd', parent_id: ids['growth-queue'] })
    expect(file(custom, { title: 'p960 under parent', description: 'd', parent_id: ids['growth-queue'] }).id).toBe(child.id)
    // Same words under ANOTHER parent: not a replay of the first card (the key
    // carries the parent). Exactly as for a registered bot, the board's
    // duplicate search then holds the second open card with that title back.
    expect(file(custom, { title: 'p960 under parent', description: 'd', parent_id: ids['growth-review-1'] })).toMatchObject({ filed: false, possible_duplicate: { id: child.id } })
    expect(card960(child.id).parent_id).toBe(ids['growth-queue'])
  })

  it('two people asking the same unregistered bot the same thing get two cards (the key is per thread)', () => {
    const setSetting = (k: string, v: string) => getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)
    setSetting('duplicate_guard_enabled', '0') // isolate idempotency from the title guard
    try {
      const a = file(custom, { title: 'p960 per thread', description: 'd' }, ALICE)
      const c = file(custom, { title: 'p960 per thread', description: 'd' }, CAROL)
      expect(c.id).not.toBe(a.id)
      expect(file(custom, { title: 'p960 per thread', description: 'd' }, CAROL).id).toBe(c.id)
    } finally {
      setSetting('duplicate_guard_enabled', '1')
    }
  })

  it('a registered bot is unchanged: registry owner, its own footer, replay on retry, agent_chat_cards row', () => {
    const before = count()
    const r = file(registered, { title: 'p960 registered', description: 'the body' })
    const c = card960(r.id)
    expect(c.owner_bot).toBe(origin(r.id).owner_bot)
    expect(c.owner_bot).toBeTruthy()
    expect(c.description).toMatch(/^the body\n\n— Filed from the .+ conversation by user2\. Results go back to that same conversation\.\n— Job mode: read_only\./)
    expect(c).toMatchObject({ origin: 'agent_chat', category: 'general', workspace: GROWTH, parent_id: null, depth: 0 })
    const retry = file(registered, { title: 'p960 registered', description: 'the body' })
    expect(retry.id).toBe(r.id)
    expect(retry.note).toMatch(/already filed for this request.*NOTHING new was filed/)
    expect(count()).toBe(before + 1)
    expect(chatRows(r.id)).toEqual([{ user_id: ALICE, agent_slug: registered.slug }])
  })

  it('"no owner bot" is not a way round the registry: createBotJob refuses null for a thread a registered bot owns', async () => {
    const { createBotJob } = await import('../bots/bot-jobs.js')
    const before = count()
    const r = createBotJob(getDb(), { userId: ALICE, agentSlug: registered.slug, ownerBot: null, chatBot: { name: 'Impostor', ownerBot: null }, workspace: GROWTH, title: 'p960 bypass', description: 'd', idempotencyKey: 'p960-bypass' })
    expect(r).toMatchObject({ ok: false, code: 'bot_agent_mismatch' })
    // And an unregistered bot still cannot file where the person is not a member.
    const x = createBotJob(getDb(), { userId: ALICE, agentSlug: custom.slug, ownerBot: null, chatBot: { name: custom.name, ownerBot: null }, workspace: OTHER, title: 'p960 x-ws', description: 'd', idempotencyKey: 'p960-xws' })
    expect(x).toMatchObject({ ok: false, code: 'workspace_forbidden' })
    expect(count()).toBe(before)
  })
})
