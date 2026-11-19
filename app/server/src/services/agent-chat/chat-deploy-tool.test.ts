/**
 * obj 901393 — "deploy on your word": Operation Kit Dev hot-deploys from chat
 * only when the owner asks for it there, each time.
 *
 * Through the real chat tool entry point (`runChatTool` / `toolSpecsForContext`),
 * a real temp SQLite DB and the real gates in services/chat-deploy.ts. Every
 * host-touching dependency (drift check, git, the deploy script, the lock) is a
 * stub: the deploy script is NEVER run for real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-deploy-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-chat-deploy'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-deploy-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-deploy-kb-'))
const DEPLOY_DIR = path.join(TMP, 'deploys')

const { initDb, getDb } = await import('../../db/index.js')
const { runChatTool, toolSpecsForContext } = await import('./tools.js')
const { CHAT_DEPLOY_FN } = await import('./chat-deploy-tool.js')
const chatDeploy = await import('../chat-deploy.js')
const { reportChatDeploys } = await import('./chat-deploy-report.js')
const { FULL_ACCESS_FNS } = await import('./full-access-tools.js')
const { createWorkspace } = await import('../workspaces.js')
const { createThread } = await import('./threads.js')
const engine = await import('./engine.js')

type Agent = import('./agent-defs.js').ChatAgent
type Ctx = import('./tools.js').ToolContext
type DeployStatus = import('../deploy-waiting.js').DeployStatus
type WaitingEntry = import('../deploy-waiting.js').WaitingEntry
type SpawnJob = import('../chat-deploy.js').SpawnJob
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const MEMBER = 2
const OPS = 'operationkit'
const OTHER_WS = 'growth'
const REPO = 'acme/app'
const HEAD = 'a'.repeat(40)
const MAIN = 'b'.repeat(40)

function bot(slug: string, name = slug): Agent {
  return {
    slug, name, description: '', avatar: '', colour: 'blue', system_prompt: 'You help.',
    knowledge_folders: [], tools: ['get_objective'], model: null, provider: null, schedules: [],
    version: null, author: null, how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
  }
}
const DEV = bot('operation-kit-dev', 'Operation Kit Dev')
const OTHER = bot('sales-helper')

// ── host stubs ──
const host = {
  files: ['app/client/src/App.tsx'] as string[],
  waiting: [] as WaitingEntry[],
  head: HEAD,
  main: MAIN,
  dirty: [] as string[],
  ahead: 0,
  lockAge: null as number | null,
  spawned: [] as SpawnJob[],
  locks: [] as string[],
  spawnThrows: false,
  liveHead: MAIN,
}

function entry(pr: number, cardId: number | null, opts: { migration?: string[] } = {}): WaitingEntry {
  return {
    sha: String(pr).padStart(40, 'c'), short_sha: String(pr).padStart(8, 'c'), committed_at: '2026-11-18T00:00:00Z',
    pr_number: pr, pr_url: `https://github.com/${REPO}/pull/${pr}`, title: `Change ${pr}`, card_id: cardId, card_title: null,
    merged_by: { kind: 'person', login: 'operator' }, merged_by_label: 'operator',
    migration: !!opts.migration?.length, migration_paths: opts.migration ?? [],
  }
}

function status(): DeployStatus {
  return {
    ok: true, repo: REPO, checked_at: '', head: host.head, origin_main: host.main,
    checkout_at_origin_main: host.head === host.main, behind: host.waiting.length, ahead: host.ahead,
    dirty_served_files: host.dirty, waiting: host.waiting, migrations_waiting: host.waiting.filter(w => w.migration).length,
    last_merge_at: null, server_started_at: '', server_started_after_last_merge: null, live: false, summary: '', note: '',
  }
}

function installStubs() {
  chatDeploy.__setChatDeployDeps({
    driftCheck: () => ({ drifted: host.dirty.length > 0 || host.ahead > 0, dirtyServedFiles: host.dirty, behind: host.waiting.length, ahead: host.ahead, reasons: host.dirty.length ? ['dirty served paths'] : [], fetchOk: true, ok: true }),
    deployStatus: () => status(),
    git: args => {
      if (args[0] === 'log') return host.files.join('\n')
      if (args[0] === 'rev-parse') return host.liveHead
      throw new Error(`unexpected git ${args.join(' ')}`)
    },
    spawnDeploy: job => {
      if (host.spawnThrows) throw new Error('spawn EACCES')
      host.spawned.push(job)
    },
    lockAgeMs: () => host.lockAge,
    writeLock: reason => { host.locks.push(reason) },
    selfRepo: () => REPO,
    env: {},
    dir: () => DEPLOY_DIR,
  })
}

// ── chat fixtures ──
function say(text: string, opts: { userId?: number; ownerBrowser?: boolean; slug?: string; threadId?: number | null; queued?: boolean } = {}): number {
  const meta: Record<string, unknown> = {}
  if (opts.ownerBrowser !== false) meta.owner_browser = true
  if (opts.queued) meta.queued = true
  return Number(getDb().prepare(
    'INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, meta, thread_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(opts.userId ?? OWNER, opts.slug ?? DEV.slug, 'user', text, Object.keys(meta).length ? JSON.stringify(meta) : null, opts.threadId ?? null).lastInsertRowid)
}

function ctx(extra: Partial<Ctx> = {}): Ctx {
  return { userId: OWNER, username: 'operator', workspace: OPS, agent: DEV, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } as Loose, ...extra }
}

function setting(key: string, value: string | null) {
  if (value == null) getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
  else getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

const offered = (c: Ctx) => toolSpecsForContext(c).some(s => s.function.name === CHAT_DEPLOY_FN)
const deploy = async (c: Ctx) => (await runChatTool(c, CHAT_DEPLOY_FN, {})).result as Loose
const auditRows = () => getDb().prepare('SELECT * FROM chat_deploys ORDER BY id').all() as Loose[]
const lastAudit = () => getDb().prepare('SELECT * FROM chat_deploys ORDER BY id DESC LIMIT 1').get() as Loose

/** The owner asks in this turn; returns a ctx for that turn. */
function ownerAsks(text = 'Deploy it now please', extra: Partial<Ctx> = {}, sayOpts: Parameters<typeof say>[1] = {}): Ctx {
  const id = say(text, sayOpts)
  return ctx({ turnMessageIds: [id], ...extra })
}

async function expectRefused(c: Ctx, code: string) {
  const before = auditRows().length
  const r = await deploy(c)
  expect(r.started).toBe(false)
  expect(r.outcome).toBe('refused')
  expect(r.code).toBe(code)
  expect(typeof r.message).toBe('string')
  expect(host.spawned).toHaveLength(0)
  const rows = auditRows()
  expect(rows).toHaveLength(before + 1)
  expect(rows[rows.length - 1].outcome).toBe('refused')
  expect(rows[rows.length - 1].reason).toBe(code)
  return r
}

let cardA = 0
let cardB = 0

beforeAll(() => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(OWNER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'sam', 'x', 'member')`).run(MEMBER)
  createWorkspace({ slug: OPS, name: 'Operation Kit', default_agent_pool: ['general'] })
  createWorkspace({ slug: OTHER_WS, name: 'Growth', default_agent_pool: ['general'] })
  db.prepare('INSERT INTO workspace_repos (workspace, name, github) VALUES (?, ?, ?)').run(OPS, 'app', `https://github.com/${REPO}.git`)
  db.prepare('INSERT INTO workspace_repos (workspace, name, github) VALUES (?, ?, ?)').run(OTHER_WS, 'site', 'acme/site')
  cardA = Number(db.prepare(`INSERT INTO objectives (title, workspace, status, type, project) VALUES ('Card A', ?, 'done', 'task', 'operationkit')`).run(OPS).lastInsertRowid)
  cardB = Number(db.prepare(`INSERT INTO objectives (title, workspace, status, type, project) VALUES ('Card B', ?, 'done', 'task', 'operationkit')`).run(OPS).lastInsertRowid)
})

afterAll(() => {
  chatDeploy.__setChatDeployDeps({})
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM chat_deploys').run()
  db.prepare('DELETE FROM agent_chat_messages').run()
  db.prepare("DELETE FROM activity_log WHERE title = 'chat_deploy'").run()
  db.prepare("UPDATE objectives SET status = 'done', session_id = NULL").run()
  setting('chat_deploy_enabled', '1')
  setting('chat_deploy_bots', null)
  Object.assign(host, {
    files: ['app/client/src/App.tsx'], waiting: [entry(901, cardA), entry(902, cardB)], head: HEAD, main: MAIN,
    dirty: [], ahead: 0, lockAge: null, spawned: [], locks: [], spawnThrows: false, liveHead: MAIN,
  })
  fs.rmSync(DEPLOY_DIR, { recursive: true, force: true })
  installStubs()
})

describe('off by default', () => {
  it('no setting row = off: not offered, and a call is refused and audited', async () => {
    setting('chat_deploy_enabled', null)
    expect(chatDeploy.isChatDeployEnabled(getDb())).toBe(false)
    const c = ownerAsks()
    expect(offered(c)).toBe(false)
    await expectRefused(c, 'disabled')
  })
  it('switched on: offered to Operation Kit Dev for the owner in the repo-owning workspace', () => {
    expect(offered(ctx())).toBe(true)
  })
})

describe('who may trigger it', () => {
  it('a team member (not admin) is refused and never offered the tool', async () => {
    const c = ownerAsks('deploy now', { userId: MEMBER, username: 'sam' }, { userId: MEMBER })
    expect(offered(c)).toBe(false)
    await expectRefused(c, 'not_owner')
  })
  it('a card-wake turn and a bot-to-bot wake turn are refused', async () => {
    const id = say('deploy now')
    const wake = ctx({ turnMessageIds: [id], botWake: { conversationId: 1, depth: 1 } })
    expect(offered(wake)).toBe(false)
    await expectRefused(wake, 'wake_turn')
    // A card wake is confined to the own-card tools: the deploy tool is unknown there.
    const cardWake = ctx({ turnMessageIds: [id], cardWake: { cardId: cardA, workspace: OPS } as Loose })
    expect(offered(cardWake)).toBe(false)
    await expect(runChatTool(cardWake, CHAT_DEPLOY_FN, {})).rejects.toThrow()
    expect(host.spawned).toHaveLength(0)
  })
  it('a message not typed by the owner in the browser (agent key / API / relay) is refused', async () => {
    const c = ownerAsks('deploy now', {}, { ownerBrowser: false })
    await expectRefused(c, 'not_owner_browser')
  })
  it('a turn where the owner did not ask for a deploy is refused', async () => {
    await expectRefused(ownerAsks('What is waiting on me today?'), 'no_deploy_ask')
    await expectRefused(ownerAsks('Do not deploy yet, I am still checking.'), 'no_deploy_ask')
    await expectRefused(ownerAsks('Should we deploy?'), 'no_deploy_ask')
  })
  it('an ask from an earlier turn does not carry over', async () => {
    const old = say('deploy now')
    const reply = say('thanks', { ownerBrowser: true })
    // This turn delivered only "thanks"; the deploy ask was an earlier turn.
    await expectRefused(ctx({ turnMessageIds: [reply] }), 'no_deploy_ask')
    // A turn with no person message at all (the model calling on its own).
    await expectRefused(ctx({ turnMessageIds: [] }), 'no_ask_this_turn')
    void old
  })
  it('one say-so = one deploy: the same ask cannot start a second deploy', async () => {
    const c = ownerAsks('deploy please')
    expect((await deploy(c)).started).toBe(true)
    getDb().prepare("UPDATE chat_deploys SET outcome = 'deployed', finished_at = datetime('now')").run()
    host.spawned = []
    await expectRefused(c, 'ask_already_used')
  })
  it('a bot that is not on the chat deploy list is refused', async () => {
    const id = say('deploy now', { slug: OTHER.slug })
    const c = ctx({ agent: OTHER, turnMessageIds: [id] })
    expect(offered(c)).toBe(false)
    await expectRefused(c, 'bot_not_allowed')
  })
  it('a workspace that does not own the install repo is refused', async () => {
    const c = ownerAsks('deploy now', { workspace: OTHER_WS })
    expect(offered(c)).toBe(false)
    await expectRefused(c, 'not_self_repo_workspace')
  })
  it('Full access and grants are not consulted, and the tool is not a Full access tool', () => {
    expect(FULL_ACCESS_FNS.has(CHAT_DEPLOY_FN)).toBe(false)
    setting('chat_deploy_enabled', null)
    // Off = not offered, whatever else the bot holds.
    expect(offered(ctx())).toBe(false)
  })
})

describe('refusals on what would go live', () => {
  it('a migration path (db/schema) is refused — a restart IS the migration', async () => {
    host.files = ['app/server/src/db/schema/chat-deploys.ts', 'app/client/src/App.tsx']
    const r = await expectRefused(ownerAsks(), 'migration_needed')
    expect(r.paths).toContain('app/server/src/db/schema/chat-deploys.ts')
  })
  it('a waiting PR flagged as a migration by the deploy-waiting list is refused (same rule)', async () => {
    host.waiting = [entry(903, cardA, { migration: ['supabase/migrations/001.sql'] })]
    host.files = ['supabase/migrations/001.sql']
    await expectRefused(ownerAsks(), 'migration_needed')
  })
  it('a test file under db/ is not a migration', async () => {
    host.files = ['app/server/src/db/schema/foo.test.ts']
    expect((await deploy(ownerAsks())).started).toBe(true)
  })
  it.each([['app/Dockerfile'], ['docker-compose.yml'], ['app/server/package.json'], ['app/package-lock.json']])('a rebuild path (%s) is refused', async file => {
    host.files = ['app/client/src/App.tsx', file]
    const r = await expectRefused(ownerAsks(), 'rebuild_needed')
    expect(r.paths).toContain(file)
  })
  it('a dirty live checkout is refused', async () => {
    host.dirty = ['app/server/src/index.ts']
    await expectRefused(ownerAsks(), 'drift')
  })
  it('a live checkout ahead of main (divergent) is refused', async () => {
    host.ahead = 2
    await expectRefused(ownerAsks(), 'drift')
  })
  it('nothing to deploy is refused', async () => {
    host.waiting = []
    host.head = MAIN
    await expectRefused(ownerAsks(), 'nothing_to_deploy')
  })
  it('a deploy already running is refused', async () => {
    expect((await deploy(ownerAsks('deploy now'))).started).toBe(true)
    host.spawned = []
    await expectRefused(ownerAsks('deploy again'), 'deploy_running')
  })
  it('a deploy inside the shared debounce window (auto-deploy lock) is refused', async () => {
    host.lockAge = 30_000
    await expectRefused(ownerAsks(), 'debounced')
  })
  it('working cards block a deploy that restarts the backend, and it says how many', async () => {
    getDb().prepare("UPDATE objectives SET status = 'working', session_id = 's1' WHERE id IN (?, ?)").run(cardA, cardB)
    host.files = ['app/server/src/services/x.ts']
    const r = await expectRefused(ownerAsks(), 'cards_working')
    expect(r.working_cards).toBe(2)
    expect(r.message).toMatch(/2 cards are working/)
  })
  it('working cards do NOT block a frontend-only deploy', async () => {
    getDb().prepare("UPDATE objectives SET status = 'working', session_id = 's1' WHERE id = ?").run(cardA)
    host.files = ['app/client/src/App.tsx']
    const r = await deploy(ownerAsks())
    expect(r.started).toBe(true)
    expect(r.mode).toBe('frontend')
  })
  it('an image install (DRIFT_GUARD=off) is refused', async () => {
    chatDeploy.__setChatDeployDeps({ ...currentDeps(), env: { DRIFT_GUARD: 'off' } })
    await expectRefused(ownerAsks(), 'no_live_checkout')
  })
})

function currentDeps() {
  // Rebuild the stub set (installStubs is the source of truth).
  installStubs()
  return {
    driftCheck: () => ({ drifted: false, dirtyServedFiles: [], behind: host.waiting.length, ahead: 0, reasons: [], fetchOk: true, ok: true }),
    deployStatus: () => status(),
    git: (args: string[]) => (args[0] === 'log' ? host.files.join('\n') : host.liveHead),
    spawnDeploy: (job: SpawnJob) => { host.spawned.push(job) },
    lockAgeMs: () => host.lockAge,
    writeLock: (reason: string) => { host.locks.push(reason) },
    selfRepo: () => REPO,
    dir: () => DEPLOY_DIR,
  }
}

describe('allowed: the owner asks on a clean hot-deployable batch', () => {
  it('starts self-deploy pinned to origin/main, lists exactly what goes live, writes the audit row and the lock', async () => {
    host.files = ['app/client/src/App.tsx', 'app/server/src/services/x.ts', 'docs/wiki/X.md']
    const c = ownerAsks('Go ahead and deploy')
    const r = await deploy(c)
    expect(r.started).toBe(true)
    expect(r.mode).toBe('both')
    expect(r.going_live.map((p: Loose) => p.pr_number)).toEqual([902, 901])
    expect(r.message).toMatch(/PR #902/)
    expect(r.message).toMatch(/card #/)
    expect(r.message).toMatch(/I will post the result here/)
    expect(host.spawned).toHaveLength(1)
    expect(host.spawned[0]).toMatchObject({ mode: 'both', expectSha: MAIN })
    expect(host.locks).toHaveLength(1)
    const row = lastAudit()
    expect(row).toMatchObject({ outcome: 'started', user_id: OWNER, agent_slug: DEV.slug, bot_name: 'Operation Kit Dev', from_commit: HEAD, to_commit: MAIN, mode: 'both', thread_id: null })
    expect(row.message_id).toBe(c.turnMessageIds![0])
    expect(JSON.parse(row.prs_json).map((p: Loose) => p.pr_number)).toEqual([902, 901])
  })
  it('records the side thread the ask came from', async () => {
    const t = createThread(OWNER, DEV.slug, 'Deploys')
    const id = say('deploy now', { threadId: t.id })
    const r = await deploy(ctx({ turnMessageIds: [id], lane: { kind: 'thread', id: t.id } }))
    expect(r.started).toBe(true)
    expect(lastAudit().thread_id).toBe(t.id)
  })
  it('a failed spawn is audited as failed and nothing is left running', async () => {
    host.spawnThrows = true
    const r = await deploy(ownerAsks())
    expect(r.outcome).toBe('failed')
    expect(lastAudit()).toMatchObject({ outcome: 'failed', reason: 'spawn_failed' })
  })
})

describe('after the restart: the outcome is posted into the same chat thread', () => {
  async function started(text = 'deploy now', threadId: number | null = null) {
    const id = say(text, { threadId })
    const r = await deploy(ctx({ turnMessageIds: [id], ...(threadId ? { lane: { kind: 'thread' as const, id: threadId } } : {}) }))
    expect(r.started).toBe(true)
    return r.deploy_id as number
  }
  function finish(id: number, code: number, log: string) {
    fs.mkdirSync(DEPLOY_DIR, { recursive: true })
    fs.writeFileSync(path.join(DEPLOY_DIR, `${id}.log`), log)
    fs.writeFileSync(path.join(DEPLOY_DIR, `${id}.exit`), `${code}\n`)
  }
  const botLines = (threadId: number | null = null) => (getDb().prepare(
    `SELECT content, meta FROM agent_chat_messages WHERE user_id = ? AND agent_slug = ? AND role = 'assistant' AND ${threadId == null ? 'thread_id IS NULL' : 'thread_id = ?'} ORDER BY id`,
  ).all(...(threadId == null ? [OWNER, DEV.slug] : [OWNER, DEV.slug, threadId])) as { content: string }[]).map(r => r.content)
  const cardLines = (id: number) => getDb().prepare("SELECT detail FROM activity_log WHERE objective_id = ? AND title = 'chat_deploy'").all(id) as { detail: string }[]

  it('nothing is posted while the script is still running', async () => {
    await started()
    expect(reportChatDeploys(getDb())).toBe(0)
    expect(lastAudit().outcome).toBe('started')
  })
  it('deployed: posts "live" once, writes "Deployed by <bot> on <owner>\'s word" on each card', async () => {
    const t = createThread(OWNER, DEV.slug, 'Ship')
    const id = await started('deploy now', t.id)
    finish(id, 0, 'Health-gate PASSED\n=== Deploy complete ===\n{"ok":true}')
    expect(reportChatDeploys(getDb())).toBe(1)
    expect(reportChatDeploys(getDb())).toBe(0) // once only
    const lines = botLines(t.id)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(new RegExp(`Deploy #${id} is live`))
    expect(lastAudit()).toMatchObject({ outcome: 'deployed' })
    expect(lastAudit().reported_at).toBeTruthy()
    expect(cardLines(cardA)[0].detail).toMatch(/Deployed by Operation Kit Dev on operator's word/)
    expect(cardLines(cardB)[0].detail).toMatch(/Deployed by Operation Kit Dev on operator's word/)
  })
  it('rolled back: posts the rollback and why, and writes no "deployed" card line', async () => {
    const id = await started()
    finish(id, 1, 'HEALTH-GATE FAILED\nDeploy FAILED its health-gate and was AUTO-ROLLED-BACK to aaaa; the server RECOVERED.')
    reportChatDeploys(getDb())
    expect(lastAudit().outcome).toBe('rolled_back')
    expect(botLines()[0]).toMatch(/rolled back/)
    expect(cardLines(cardA)).toHaveLength(0)
  })
  it('main moved after the list was shown: failed, says so', async () => {
    const id = await started()
    finish(id, 3, 'Deploy REFUSED: origin/main is ccc, not the expected bbb (main moved). [main-moved]')
    reportChatDeploys(getDb())
    expect(lastAudit().outcome).toBe('failed')
    expect(botLines()[0]).toMatch(/Main moved/)
  })
  it('exit 0 but the checkout is not at the target: failed', async () => {
    const id = await started()
    host.liveHead = HEAD
    finish(id, 0, '{"ok":true}')
    reportChatDeploys(getDb())
    expect(lastAudit().outcome).toBe('failed')
  })
  it('no result after the timeout: failed, and the owner is told', async () => {
    const id = await started()
    getDb().prepare("UPDATE chat_deploys SET created_at = datetime('now', '-30 minutes') WHERE id = ?").run(id)
    reportChatDeploys(getDb())
    expect(lastAudit().outcome).toBe('failed')
    expect(botLines()[0]).toMatch(/No result/)
  })
})

describe('pure rules', () => {
  it('mode from changed files', () => {
    expect(chatDeploy.deployModeFor(['app/client/src/a.tsx'])).toBe('frontend')
    expect(chatDeploy.deployModeFor(['app/server/src/a.ts'])).toBe('backend')
    expect(chatDeploy.deployModeFor(['app/shared/types.ts'])).toBe('both')
    expect(chatDeploy.deployModeFor(['app/client/a.tsx', 'app/server/a.ts'])).toBe('both')
    expect(chatDeploy.deployModeFor(['docs/x.md'])).toBe('frontend')
  })
  it('deploy asks', () => {
    for (const yes of ['deploy', 'Deploy it', 'please deploy now', 'can you deploy?', 'ship it', 'go live with it', 'redeploy please']) {
      expect(chatDeploy.asksForDeploy(yes), yes).toBe(true)
    }
    for (const no of ['', 'hello', "don't deploy", 'do not deploy yet', 'never deploy on fridays', 'should we deploy?', 'what would deploy?', 'is it live?']) {
      expect(chatDeploy.asksForDeploy(no), no).toBe(false)
    }
  })
  it('repo names normalise', () => {
    expect(chatDeploy.normalizeRepo('https://github.com/Acme/App.git')).toBe('acme/app')
    expect(chatDeploy.normalizeRepo('git@github.com:Acme/App.git')).toBe('acme/app')
    expect(chatDeploy.normalizeRepo('Acme/App/')).toBe('acme/app')
  })
})

describe('the owner-browser stamp is written by the server', () => {
  it('runTurn stores meta.owner_browser only when the route says so', async () => {
    await engine.runTurn({ userId: OWNER, username: 'operator', agent: DEV, text: 'hello', ownerBrowser: true })
    await engine.runTurn({ userId: OWNER, username: 'operator', agent: DEV, text: 'hello again' })
    const rows = getDb().prepare("SELECT content, meta FROM agent_chat_messages WHERE role = 'user' ORDER BY id").all() as { content: string; meta: string | null }[]
    expect(JSON.parse(rows[0].meta ?? '{}').owner_browser).toBe(true)
    expect(JSON.parse(rows[1].meta ?? '{}').owner_browser).toBeUndefined()
  })
})
