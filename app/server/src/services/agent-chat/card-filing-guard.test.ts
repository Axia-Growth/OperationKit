// Chat bots never file the same card twice (obj 901498).
//
// Through the real chat tools (runChatTool) and a real (temp) SQLite DB, for
// both tools that file a card, create_objective and repo_session_start:
//   1. RETRY: the same request again (same key, or the same words with no key)
//      returns the card already filed. One card on the board, one start.
//   2. NEAR-DUPLICATE: an open card with a near-identical title comes back as
//      "possible duplicate #N" and nothing is filed, with a stated way through
//      (file_anyway). Different work is not caught.
//   3. FAILED START: a card that was created but did not start is reported as
//      "exists, not started"; a retry returns that card and never a new one.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-card-filing-guard-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-card-filing-guard-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-filing-guard-kb-'))
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-filing-guard-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
fs.mkdirSync(path.join(TMP_AGENTS, 'dev'), { recursive: true })
fs.writeFileSync(path.join(TMP_AGENTS, 'dev', 'agent.yaml'), 'name: Operation Kit Dev\ndescription: Builds things\ntools: [create_objective]\nknowledge_folders: [shared]\nsystem_prompt: You help.\n')

const { initDb, getDb } = await import('../../db/index.js')
const { runChatTool, ToolUseError } = await import('./tools.js')
const { grantBotWorkspace } = await import('./bot-workspaces.js')
const { setFullAccess } = await import('./bot-full-access.js')
const { createWorkspace } = await import('../workspaces.js')
const { titleSimilarity, findPossibleDuplicate, NEAR_DUPLICATE_THRESHOLD } = await import('./card-filing-guard.js')
type Agent = import('./agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const ALICE = 2 // a member who sees only her own cards
const WS = 'growth'
const NOW = new Date('2026-11-19T12:00:00Z')

function bot(): Agent {
  return {
    slug: 'dev', name: 'Operation Kit Dev', description: 'Builds things', avatar: '', colour: 'blue', system_prompt: 'You help.',
    knowledge_folders: ['shared'], tools: ['create_objective', 'get_objective', 'list_objectives'], model: null, provider: null, schedules: [],
    version: null, author: null, how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
  }
}

/** The start route, stubbed: flips the card to working, or refuses like a full session pool does. */
let startFails: string | null = null
const starts: number[] = []
const host = {
  async startCard(id: number) {
    starts.push(id)
    if (startFails) return { ok: false, reason: startFails }
    getDb().prepare("UPDATE objectives SET status = 'working' WHERE id = ?").run(id)
    return { ok: true, status: 'working' }
  },
  async messageCard() { return { ok: true, status: 'working' } },
}

function ctx(userId = ADMIN) {
  return { userId, username: userId === ADMIN ? 'jordan' : 'alice', workspace: WS, agent: bot(), kbRoot: TMP_KB, connectors: { mail: null, calendar: null }, now: () => NOW, fullAccessHost: host }
}

const cards = () => getDb().prepare("SELECT id, title, status FROM objectives WHERE title != 'seed repo card' ORDER BY id").all() as { id: number; title: string; status: string }[]
const create = (args: Loose, userId = ADMIN) => runChatTool(ctx(userId), 'create_objective', args).then(r => r as Loose)
const repo = (args: Loose) => runChatTool(ctx(), 'repo_session_start', { project: 'growth-site', ...args }).then(r => r as Loose)

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'jordan', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice', 'x', 'member')`).run(ALICE)
  createWorkspace({ slug: WS, name: 'Growth', default_agent_pool: ['general'] })
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, ?, 'member', 'own')`).run(ALICE, WS)
  // repo_session_start only works on a project the workspace already uses.
  db.prepare(
    `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, agent_context, project)
     VALUES ('seed repo card', 'x', ?, 'done', 'task', 'general', ?, ?, 'general', 'growth-site')`,
  ).run(WS, ADMIN, ADMIN)
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  for (const t of ['agent_chat_cards', 'bot_job_origins', 'idempotency_keys', 'agent_chat_bot_access', 'agent_chat_bot_workspaces', 'agent_chat_bot_full_access', 'agent_chat_bot_full_access_audit']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  db.prepare("DELETE FROM objectives WHERE title != 'seed repo card'").run()
  db.prepare("DELETE FROM settings WHERE key IN ('duplicate_guard_enabled', 'job_wallclock_ceiling_ms', 'job_cost_ceiling_usd')").run()
  starts.length = 0
  startFails = null
  // The admin's two clicks: grant the workspace, switch Full access on.
  grantBotWorkspace('dev', WS, 'jordan')
  setFullAccess('dev', WS, { enabled: true }, { id: ADMIN, username: 'jordan' }, NOW)
})

describe('1. retry — the same request returns the card already filed', () => {
  it('create_objective: the same key gives one card, even when the retry rewords the description', async () => {
    const first = await create({ title: 'Audit the signup funnel', description: 'Find where people drop off.', idempotency_key: 'turn-41-card-1' })
    expect(first.result).toMatchObject({ filed: true, reused: false })
    const again = await create({ title: 'Audit the signup funnel', description: 'Find where people drop off, and say why.', idempotency_key: 'turn-41-card-1' })
    expect(again.result).toMatchObject({ filed: true, reused: true, id: first.result.id, will_start: false })
    expect(again.result.note).toMatch(/already filed.*NOTHING new was filed/)
    expect(again.objective_id).toBe(first.result.id)
    expect(cards()).toHaveLength(1)
  })

  it('create_objective: the same words with no key give one card (the derived key)', async () => {
    const first = await create({ title: 'Audit the signup funnel', description: 'Find where people drop off.' })
    const again = await create({ title: 'Audit the signup funnel', description: 'Find where people drop off.' })
    expect(again.result).toMatchObject({ reused: true, id: first.result.id })
    // A retry that drops the key it sent the first time still lands on the same card.
    const keyed = await create({ title: 'Clean up old drafts', description: 'Remove drafts older than a year.', idempotency_key: 'k-drafts' })
    const dropped = await create({ title: 'Clean up old drafts', description: 'Remove drafts older than a year.' })
    expect(dropped.result).toMatchObject({ filed: false, possible_duplicate: { id: keyed.result.id } })
    // …and one that ADDS a key on the retry does too.
    const added = await create({ title: 'Audit the signup funnel', description: 'Find where people drop off.', idempotency_key: 'k-late' })
    expect(added.result).toMatchObject({ reused: true, id: first.result.id })
    expect(cards()).toHaveLength(2)
  })

  it('create_objective: a key names ONE card. Reusing it for different work is refused, not answered with the old card', async () => {
    const first = await create({ title: 'Audit the signup funnel', description: 'd', idempotency_key: 'k1' })
    await expect(create({ title: 'Rewrite the pricing page', description: 'd', idempotency_key: 'k1' })).rejects.toThrow(new RegExp(`already belongs to card #${first.result.id}.*NOT filed`))
    await expect(create({ title: 'x', description: 'd', idempotency_key: 'has a space' })).rejects.toBeInstanceOf(ToolUseError)
    expect(cards()).toHaveLength(1)
  })

  it('repo_session_start: a repeated call from the same chat turn yields one card and one start', async () => {
    const args = { title: 'Fix the footer links', description: 'Footer links 404.', idempotency_key: 'turn-7-repo-1' }
    const first = await repo(args)
    expect(first.result).toMatchObject({ filed: true, reused: false, started: true, status: 'working' })
    const again = await repo(args)
    expect(again.result).toMatchObject({ filed: true, reused: true, id: first.result.id, started: true, status: 'working' })
    expect(again.result.note).toMatch(/already filed.*NOTHING new was filed/)
    // No key at all: the same words still land on the same card.
    const bare = await repo({ title: 'Fix the footer links', description: 'Footer links 404.' })
    expect(bare.result).toMatchObject({ reused: true, id: first.result.id })
    expect(cards()).toHaveLength(1)
    expect(starts).toEqual([first.result.id])
  })

  it('repo_session_start: a key is per person and bot, and is refused for different work', async () => {
    const first = await repo({ title: 'Fix the footer links', description: 'd', idempotency_key: 'k1' })
    await expect(repo({ title: 'Add a sitemap', description: 'd', idempotency_key: 'k1' })).rejects.toThrow(new RegExp(`already belongs to card #${first.result.id}`))
    expect(cards()).toHaveLength(1)
    // A card that was deleted frees its key: the next call files.
    getDb().prepare("UPDATE objectives SET deleted_at = datetime('now') WHERE id = ?").run(first.result.id)
    const fresh = await repo({ title: 'Fix the footer links', description: 'd', idempotency_key: 'k1' })
    expect(fresh.result).toMatchObject({ reused: false })
    expect(fresh.result.id).not.toBe(first.result.id)
  })
})

describe('2. near-duplicate — an open card with a near-identical title is handed back, nothing is filed', () => {
  it('scores titles the way the guard promises', () => {
    const near = (a: string, b: string) => titleSimilarity(a, b) >= NEAR_DUPLICATE_THRESHOLD
    expect(near('Fix the footer links', 'fix footer link!')).toBe(true)
    expect(near('Chat bots: never file the same card twice', 'Chat bots never file same card twice (retry)')).toBe(true)
    expect(near('Audit the signup funnel', 'Audit the signup funnel (2)')).toBe(true)
    expect(near('Weekly report Q3', 'Weekly report Q4')).toBe(false)
    expect(near('Phase 2 rollout of billing', 'Phase 3 rollout of billing')).toBe(false)
    expect(near('Fix the footer links', 'Fix the header links')).toBe(false)
    expect(near('Deploy', 'Deploy docs')).toBe(false)
  })

  it('create_objective: says "possible duplicate #N", files nothing, and file_anyway is the stated way through', async () => {
    const first = await create({ title: 'Fix the footer links', description: 'Footer links 404.' })
    const dup = await create({ title: 'Fix footer link', description: 'The links in the footer are broken on mobile.' })
    expect(dup.result).toMatchObject({ filed: false, possible_duplicate: { id: first.result.id, title: 'Fix the footer links', status: 'queue' } })
    expect(dup.result.note).toMatch(new RegExp(`Possible duplicate #${first.result.id}.*NOTHING was filed.*card_comment.*card_take_over.*file_anyway: true`))
    expect(dup.summary).toMatch(/Possible duplicate of card #\d+: nothing new was filed/)
    expect(dup.objective_id).toBeUndefined()
    expect(cards()).toHaveLength(1)
    // The bot checked and it IS different work.
    const forced = await create({ title: 'Fix footer link', description: 'The links in the footer are broken on mobile.', file_anyway: true })
    expect(forced.result).toMatchObject({ filed: true, reused: false })
    expect(cards()).toHaveLength(2)
    // The refusal was counted, like every other duplicate refusal on the board.
    const logged = getDb().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE json_extract(metadata, '$.kind') = 'duplicate_refused' AND objective_id = ?").get(first.result.id) as { n: number }
    expect(logged.n).toBe(1)
  })

  it('create_objective: a finished card and different work are not duplicates; the kill switch turns the search off', async () => {
    const first = await create({ title: 'Fix the footer links', description: 'd1' })
    expect((await create({ title: 'Fix the header links', description: 'd2' })).result).toMatchObject({ filed: true, reused: false })
    getDb().prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(first.result.id)
    expect((await create({ title: 'Fix footer links', description: 'again, it regressed' })).result).toMatchObject({ filed: true, reused: false })
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('duplicate_guard_enabled', '0')").run()
    expect((await create({ title: 'Fix the footer link', description: 'd4' })).result).toMatchObject({ filed: true, reused: false })
  })

  it('create_objective: never names a card the person cannot see on their board', async () => {
    const mine = await create({ title: 'Plan the Q1 offsite', description: 'admin only' })
    // Alice sees only her own cards. The search does not show her the admin's card by title…
    expect(findPossibleDuplicate(getDb(), { title: 'Plan the Q1 offsite agenda', workspace: WS, visible: () => false })).toBeNull()
    const hers = await create({ title: 'Plan Q1 offsite', description: 'alice' }, ALICE)
    expect(hers.result).toMatchObject({ filed: true, reused: false })
    // …and an exact same-title twin is still held back (the board's own guard), by number only.
    const hidden = await create({ title: 'Rotate the API keys', description: 'admin only' })
    expect(hidden.result.id).toBeGreaterThan(mine.result.id)
    const twin = await create({ title: 'Rotate the API keys', description: 'alice' }, ALICE)
    expect(twin.result).toMatchObject({ filed: false, possible_duplicate: { id: hidden.result.id, title: 'Rotate the API keys' } })
  })

  it('repo_session_start: a reworded title is a possible duplicate, with no second card and no second start', async () => {
    const first = await repo({ title: 'Fix the footer links', description: 'Footer links 404.' })
    const dup = await repo({ title: 'Fix footer links', description: 'The footer 404s.' })
    expect(dup.result).toMatchObject({ filed: false, possible_duplicate: { id: first.result.id, status: 'working' } })
    expect(dup.result.note).toMatch(/NOTHING was filed.*card_comment.*file_anyway: true/)
    expect(cards()).toHaveLength(1)
    expect(starts).toEqual([first.result.id])
    const forced = await repo({ title: 'Fix footer links', description: 'The footer 404s.', file_anyway: true })
    expect(forced.result).toMatchObject({ filed: true, reused: false, started: true })
    expect(cards()).toHaveLength(2)
  })
})

describe('3. failed start — the card exists and was not started; it is never re-created', () => {
  it('repo_session_start: a session cap leaves ONE card in queue, and the retry returns it', async () => {
    startFails = '409 {"error":"session_cap: 25 sessions are running"}'
    const args = { title: 'Fix the footer links', description: 'Footer links 404.' }
    const first = await repo(args)
    expect(first.result).toMatchObject({ filed: true, reused: false, started: false, status: 'queue' })
    expect(first.result.note).toMatch(new RegExp(`Card #${first.result.id} EXISTS on the board and has NOT started: .*session_cap.*Do not file it again.*card_restart ${first.result.id}`))
    expect(first.summary).toMatch(/has not started yet/)
    // The bot (or a re-sent turn) asks again: same card, still not started, told to start THAT card.
    const again = await repo(args)
    expect(again.result).toMatchObject({ filed: true, reused: true, id: first.result.id, started: false, status: 'queue' })
    expect(again.result.note).toMatch(new RegExp(`EXISTS and has NOT started.*card_restart ${first.result.id}; never file it again`))
    // Reworded, it is the possible duplicate instead. Either way: one card.
    expect((await repo({ title: 'Fix footer link', description: 'x' })).result).toMatchObject({ filed: false, possible_duplicate: { id: first.result.id } })
    expect(cards()).toEqual([{ id: first.result.id, title: 'Fix the footer links', status: 'queue' }])
    // The retry did not try a second start by itself.
    expect(starts).toEqual([first.result.id])
    // Starting it later is card_restart on the SAME card.
    startFails = null
    const restarted = (await runChatTool(ctx(), 'card_restart', { id: first.result.id })) as Loose
    expect(restarted.result).toMatchObject({ id: first.result.id, restarted: true })
    expect(cards()).toHaveLength(1)
  })

  it('create_objective: a card that will not start by itself says so, and the retry returns that card', async () => {
    // No time or cost limit is set for the workspace, so the card is filed and left in queue.
    const first = await create({ title: 'Audit the signup funnel', description: 'Find where people drop off.', idempotency_key: 'k-audit' })
    expect(first.result).toMatchObject({ filed: true, reused: false, will_start: false, status: 'queue' })
    expect(first.result.note).toMatch(new RegExp(`Card #${first.result.id} EXISTS on the board\\. It will NOT start by itself: .*Do not file it again`))
    const again = await create({ title: 'Audit the signup funnel', description: 'Find where people drop off.', idempotency_key: 'k-audit' })
    expect(again.result).toMatchObject({ reused: true, id: first.result.id, status: 'queue' })
    expect(cards()).toHaveLength(1)
  })
})
