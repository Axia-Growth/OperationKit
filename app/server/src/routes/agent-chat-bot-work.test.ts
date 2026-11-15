// Bot visibility (obj 900947) over HTTP + the needs-you poster. Proves:
//   - the Work tab groups a bot's cards into Running / In review / Queued /
//     Recently done, and ownership is agent_context = slug OR owner_bot;
//   - each card carries spend against its ceiling — the PR 794 per-effort
//     default (`spend_ceiling_default_usd:<tier>`) or an explicit one;
//   - "Needs you" counts exactly the four reasons (approval beyond grant, over
//     ceiling, decision, blocker), and across bots each card counts once;
//   - workspace scoping: a view covers only workspaces that are the viewer's
//     AND granted to the bot; a wake outside that is a 404;
//   - card visibility: inside those workspaces a member sees only what the
//     board list shows them — every card with 'all' visibility, else only
//     cards they are assigned to, created, or are an assignee on (Work,
//     Activity, the expanded run, sidebar counts, "Needs you", and who a
//     needs-you chat post goes to);
//   - the Activity feed: one entry per High Agency wake (card it picked, what
//     it did, PR, cost), a daily summary, and an expanded run;
//   - the chat-routing rule: only the four need-a-person reasons post to the
//     main chat; a finished High Agency card does not; old messages are
//     flagged for collapsing, never rewritten.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-bot-work-xxxxxxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-work-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59948'
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-work-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { setBotWorkspaces } = await import('../services/agent-chat/bot-workspaces.js')
const { setObjectiveCeiling } = await import('../services/job-accounting.js')
const { runBotAttentionTick, markFeedMessage, attentionText } = await import('../services/agent-chat/bot-attention.js')
const { enqueueBotThreadDeliveries } = await import('../services/bots/bot-thread-delivery.js')
const shared = await import('@operationkit/shared')

const ADMIN = 1
const MEMBER = 2 // member of ops only, the default 'own' card visibility
const MEMBER_ALL = 3 // member of ops only, 'all' card visibility

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
let agentKey = ''

function tokenFor(id: number, role: string) {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(p: string, opts: { as?: number; role?: string; key?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`
  else headers.Cookie = `token=${tokenFor(opts.as ?? ADMIN, opts.role ?? (opts.as === MEMBER || opts.as === MEMBER_ALL ? 'member' : 'admin'))}`
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, { headers })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

function writeBot(slug: string, yaml: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), yaml)
}

interface CardSpec {
  title?: string
  status?: string
  workspace?: string
  agent_context?: string
  owner_bot?: string | null
  session_id?: string | null
  has_blockers?: number
  routine_id?: number | null
  source_job_id?: number | null
  job_disposition?: string | null
  job_review_note?: string | null
  last_session_summary?: string | null
  pr_url?: string | null
  updated_at?: string
  created_at?: string
  needs_secret?: string | null
}

let seq = 0
function card(s: CardSpec = {}): number {
  seq += 1
  const db = getDb()
  const id = Number(
    db
      .prepare(
        `INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id, owner_bot, has_blockers,
           routine_id, source_job_id, job_disposition, job_review_note, last_session_summary, pr_url, needs_secret)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.title ?? `card ${seq}`,
        s.agent_context ?? 'cto',
        s.workspace ?? 'ops',
        s.status ?? 'queue',
        s.session_id ?? null,
        s.owner_bot ?? null,
        s.has_blockers ?? 0,
        s.routine_id ?? null,
        s.source_job_id ?? null,
        s.job_disposition ?? null,
        s.job_review_note ?? null,
        s.last_session_summary ?? null,
        s.pr_url ?? null,
        s.needs_secret ?? null,
      ).lastInsertRowid,
  )
  if (s.updated_at) db.prepare('UPDATE objectives SET updated_at = ? WHERE id = ?').run(s.updated_at, id)
  if (s.created_at) db.prepare('UPDATE objectives SET created_at = ? WHERE id = ?').run(s.created_at, id)
  return id
}

let sessionSeq = 0
function spend(objectiveId: number, usd: number, endedAt = "datetime('now')") {
  sessionSeq += 1
  getDb()
    .prepare(`INSERT INTO session_intel (objective_id, session_id, started_at, ended_at, total_cost_usd) VALUES (?, ?, datetime('now'), ${endedAt}, ?)`)
    .run(objectiveId, `sess-${sessionSeq}`, usd)
}

function audit(objectiveId: number, event: 'approval_denied' | 'approval_used', action = 'merge') {
  getDb()
    .prepare('INSERT INTO delegation_audit (event, objective_id, workspace, bot_name, action, actor) VALUES (?, ?, ?, ?, ?, ?)')
    .run(event, objectiveId, 'ops', 'Grok: CTO', action, 'test')
}

const ids: Record<string, number> = {}
let routineId = 0

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'user2', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ops', 'Ops'), ('sales', 'Sales'), ('finance', 'Finance')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (3, 'user3', 'x', 'member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'ops', 'admin'), (1, 'sales', 'admin'), (1, 'finance', 'admin'), (2, 'ops', 'member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (3, 'ops', 'member', 'all')`).run()
  writeBot('cto', 'name: CTO\nsystem_prompt: You own engineering.\n')
  writeBot('dev', 'name: Dev\nsystem_prompt: You write code.\n')
  setBotWorkspaces('cto', ['ops', 'finance'], 'test')
  setBotWorkspaces('dev', ['ops'], 'test')
  db.prepare("INSERT INTO settings (key, value) VALUES ('spend_ceiling_default_usd:normal', '10')").run()

  routineId = Number(
    db.prepare("INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth, kind) VALUES ('high-agency:cto', '0 2 * * *', '{}', 1, 1, 'ai')").run().lastInsertRowid,
  )
  db.prepare("INSERT INTO agent_chat_high_agency (slug, enabled, level, workspace, allow_cards, allow_workflows, run_as_user_id, routine_id, updated_by) VALUES ('cto', 1, 3, 'ops', 1, 1, 1, ?, 'test')").run(routineId)

  // Work
  ids.running = card({ status: 'working', session_id: 'live-1', title: 'Ship the importer' })
  spend(ids.running, 3)
  ids.decision = card({ status: 'review', agent_context: 'general', owner_bot: 'Grok: CTO', title: 'Pick a vendor' })
  ids.aiReview = card({ status: 'ai_review', session_id: 'rev-1' })
  ids.queued = card({ status: 'queue', title: 'Queued thing' })
  ids.doneRecent = card({ status: 'done', pr_url: 'https://github.com/acme/repo/pull/7' })
  ids.doneOld = card({ status: 'done', updated_at: '2020-01-01 00:00:00' })
  ids.cancelled = card({ status: 'cancelled' })
  ids.salesHidden = card({ status: 'queue', workspace: 'sales' })
  ids.overCeiling = card({ status: 'working', session_id: 'live-2', workspace: 'finance' })
  setObjectiveCeiling(db, ids.overCeiling, { costUsd: 5 })
  spend(ids.overCeiling, 6)
  ids.blocked = card({ status: 'working', session_id: 'live-3', has_blockers: 1 })
  ids.denied = card({ status: 'working', session_id: 'live-4' })
  audit(ids.denied, 'approval_denied', 'deploy')
  ids.deniedThenUsed = card({ status: 'working', session_id: 'live-5' })
  audit(ids.deniedThenUsed, 'approval_denied')
  audit(ids.deniedThenUsed, 'approval_used')
  ids.generalOnly = card({ status: 'queue', agent_context: 'general' })
  ids.devCard = card({ status: 'working', session_id: 'live-6', agent_context: 'dev' })

  // Wakes
  ids.wakeDone = card({ status: 'working', routine_id: routineId, job_review_note: 'Closed 2 cards and started the importer.', created_at: new Date(Date.now() - 2 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) })
  db.prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(ids.wakeDone)
  spend(ids.wakeDone, 0.5)
  ids.picked = card({ status: 'working', source_job_id: ids.wakeDone, pr_url: 'https://github.com/acme/repo/pull/9', title: 'Importer v2' })
  db.prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(ids.picked)
  spend(ids.picked, 1.25)
  ids.wakeReview = card({ status: 'review', routine_id: routineId, job_disposition: 'needs_review', last_session_summary: '## Report\nNeeds a budget decision.' })
  ids.wakeSales = card({ status: 'done', routine_id: routineId, workspace: 'sales' })

  const k = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'remote-bot' })
  if (!k.ok) throw new Error(k.error)
  agentKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

const idsIn = (cards: Loose[]) => cards.map((c: Loose) => c.id).sort((a: number, b: number) => a - b)

describe('Work tab: grouping and ownership', () => {
  it('groups the bot\'s cards and leaves out cancelled, old done, done wakes and other bots\' cards', async () => {
    const r = await call('/agents/cto/work')
    expect(r.status).toBe(200)
    expect(r.json.owner_token).toBe('bot:Grok: CTO')
    const g = r.json.groups
    expect(idsIn(g.running)).toEqual([ids.running, ids.overCeiling, ids.blocked, ids.denied, ids.deniedThenUsed].sort((a, b) => a - b))
    expect(idsIn(g.review)).toEqual([ids.decision, ids.aiReview, ids.wakeReview].sort((a, b) => a - b))
    expect(idsIn(g.queued)).toEqual([ids.queued])
    expect(idsIn(g.done)).toEqual([ids.doneRecent, ids.picked].sort((a, b) => a - b))
    const all = [...g.running, ...g.review, ...g.queued, ...g.done].map((c: Loose) => c.id)
    for (const gone of [ids.doneOld, ids.cancelled, ids.generalOnly, ids.devCard, ids.wakeDone, ids.salesHidden]) expect(all).not.toContain(gone)
  })

  it('owner_bot alone (agent_context general) is ownership; the review card says so', async () => {
    const r = await call('/agents/cto/work')
    const decision = r.json.groups.review.find((c: Loose) => c.id === ids.decision)
    expect(decision).toBeTruthy()
    expect(decision.needs_you).toEqual(['decision'])
  })

  it('carries the PR link and spend against the ceiling: the per-effort default, or an explicit one', async () => {
    const r = await call('/agents/cto/work')
    const running = r.json.groups.running.find((c: Loose) => c.id === ids.running)
    expect(running).toMatchObject({ spent_usd: 3, ceiling_usd: 10, ceiling_source: 'default:normal', ceiling_is_default: true, needs_you: [] })
    const over = r.json.groups.running.find((c: Loose) => c.id === ids.overCeiling)
    expect(over).toMatchObject({ spent_usd: 6, ceiling_usd: 5, ceiling_source: 'objective', ceiling_is_default: false })
    expect(over.needs_you).toContain('over_ceiling')
    const done = r.json.groups.done.find((c: Loose) => c.id === ids.doneRecent)
    expect(done.pr_url).toBe('https://github.com/acme/repo/pull/7')
  })
})

describe('"Needs you": the four reasons, counted once', () => {
  it('flags approval beyond grant, over ceiling, decision and blocker — and nothing else', async () => {
    const r = await call('/agents/cto/work')
    const all = [...r.json.groups.running, ...r.json.groups.review, ...r.json.groups.queued]
    const reasons = Object.fromEntries(all.map((c: Loose) => [c.id, c.needs_you]))
    expect(reasons[ids.denied]).toEqual(['approval_beyond_grant'])
    expect(reasons[ids.deniedThenUsed]).toEqual([])
    expect(reasons[ids.overCeiling]).toEqual(['over_ceiling'])
    expect(reasons[ids.decision]).toEqual(['decision'])
    expect(reasons[ids.wakeReview]).toEqual(['decision'])
    expect(reasons[ids.blocked]).toEqual(['blocker'])
    expect(reasons[ids.aiReview]).toEqual([])
    expect(reasons[ids.queued]).toEqual([])
    expect(r.json.counts).toEqual({ running: 5, review: 3, queued: 1, done: 2, needs_you: 5 })
    expect(r.json.state).toBe('waiting')
    expect(r.json.line).toMatch(/^5 need you · 5 running · 3 in review$/)
  })

  it('the sidebar status covers every bot and totals needs-you across bots, each card once', async () => {
    // A second bot claims one of CTO's waiting cards through owner_bot.
    getDb().prepare("UPDATE objectives SET owner_bot = 'Dev' WHERE id = ?").run(ids.blocked)
    try {
      const r = await call('/bot-status')
      expect(r.status).toBe(200)
      expect(r.json.bots.cto.state).toBe('waiting')
      // Dev: its own running card + the shared blocked card (owner_bot) — both in ops.
      expect(r.json.bots.dev.counts.needs_you).toBe(1)
      expect(r.json.bots.dev.line).toBe(`Needs you on #${ids.blocked} · 2 running`)
      expect(r.json.needs_you_total).toBe(5)
    } finally {
      getDb().prepare('UPDATE objectives SET owner_bot = NULL WHERE id = ?').run(ids.blocked)
    }
  })

  it('a bot with nothing open reads Idle', () => {
    expect(shared.botLiveLine({ running: 0, review: 0, queued: 0, done: 3, needs_you: 0 }, null)).toBe('Idle')
    expect(shared.botLiveLine({ running: 1, review: 2, queued: 0, done: 0, needs_you: 0 }, { id: 900936 })).toBe('Working on #900936 · 2 in review')
  })
})

describe('workspace scoping', () => {
  it('a member with all-visibility sees only workspaces that are theirs AND granted to the bot', async () => {
    const r = await call('/agents/cto/work', { as: MEMBER_ALL })
    expect(r.status).toBe(200)
    expect(r.json.workspaces).toEqual(['ops'])
    const all = [...r.json.groups.running, ...r.json.groups.review, ...r.json.groups.queued, ...r.json.groups.done]
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((c: Loose) => c.workspace === 'ops')).toBe(true)
    expect(all.map((c: Loose) => c.id)).not.toContain(ids.overCeiling)
    expect(r.json.counts.needs_you).toBe(4)
  })

  it('a member with own-visibility and no card of their own sees the workspace but none of the bot\'s cards', async () => {
    // Every fixture card was created by the admin and is assigned to nobody.
    const r = await call('/agents/cto/work', { as: MEMBER })
    expect(r.status).toBe(200)
    expect(r.json.workspaces).toEqual(['ops'])
    expect(r.json.groups).toEqual({ running: [], review: [], queued: [], done: [] })
    expect(r.json.counts).toEqual({ running: 0, review: 0, queued: 0, done: 0, needs_you: 0 })
    expect(r.json.line).toBe('Idle')
  })

  it('an admin still only sees workspaces the bot is granted (sales is not)', async () => {
    const r = await call('/agents/cto/work')
    expect(r.json.workspaces.sort()).toEqual(['finance', 'ops'])
    const act = await call('/agents/cto/activity')
    expect(act.json.entries.map((e: Loose) => e.wake_id)).not.toContain(ids.wakeSales)
    expect((await call(`/agents/cto/activity/${ids.wakeSales}`)).status).toBe(404)
  })

  it('a bot with no grant shows nothing', async () => {
    setBotWorkspaces('dev', [], 'test')
    try {
      const r = await call('/agents/dev/work')
      expect(r.json.workspaces).toEqual([])
      expect(r.json.counts).toEqual({ running: 0, review: 0, queued: 0, done: 0, needs_you: 0 })
    } finally {
      setBotWorkspaces('dev', ['ops'], 'test')
    }
  })

  it('an agent API key cannot read these views', async () => {
    for (const p of ['/bot-status', '/agents/cto/work', '/agents/cto/activity', `/agents/cto/activity/${ids.wakeDone}`]) {
      expect((await call(p, { key: agentKey })).status).toBe(403)
    }
  })
})

describe('Activity feed', () => {
  it('one entry per wake: time, the card it picked, what it did, PR and cost', async () => {
    const r = await call('/agents/cto/activity')
    expect(r.status).toBe(200)
    expect(r.json.high_agency).toBe(true)
    expect(r.json.entries.map((e: Loose) => e.wake_id)).toEqual([ids.wakeReview, ids.wakeDone])
    const done = r.json.entries[1]
    expect(done.picked).toMatchObject({ id: ids.picked, title: 'Importer v2', pr_url: 'https://github.com/acme/repo/pull/9' })
    expect(done.did).toBe('Closed 2 cards and started the importer.')
    expect(done.pr_url).toBe('https://github.com/acme/repo/pull/9')
    expect(done.cost_usd).toBeCloseTo(1.75)
    const review = r.json.entries[0]
    expect(review.did).toBe('Report')
    expect(review.needs_you).toEqual(['decision'])
  })

  it('the daily summary: what shipped, spend, and what is next', async () => {
    const r = await call('/agents/cto/activity')
    const s = r.json.summary
    expect(s.wakes).toBe(2)
    expect(s.shipped.map((c: Loose) => c.id).sort()).toEqual([ids.doneRecent, ids.picked].sort())
    expect(s.spent_usd).toBeGreaterThan(0)
    expect(s.next.queued).toEqual([{ id: ids.queued, title: 'Queued thing' }])
    expect(s.next.needs_you).toBe(5)
  })

  it('an entry expands into the full run', async () => {
    const r = await call(`/agents/cto/activity/${ids.wakeDone}`)
    expect(r.status).toBe(200)
    expect(r.json.run).toMatchObject({ wake_id: ids.wakeDone, review_note: 'Closed 2 cards and started the importer.', wake_spent_usd: 0.5 })
    expect(r.json.run.children.map((c: Loose) => c.id)).toEqual([ids.picked])
    expect((await call(`/agents/cto/activity/${ids.running}`)).status).toBe(404) // not a wake
    expect((await call(`/agents/dev/activity/${ids.wakeDone}`)).status).toBe(404) // not dev's wake
  })
})

describe('chat routing: only the four need-a-person reasons reach the main chat', () => {
  it('the rule itself', () => {
    for (const r of ['approval_beyond_grant', 'over_ceiling', 'decision', 'blocker']) expect(shared.chatRouteFor(r)).toBe('main_chat')
    for (const r of ['wake_started', 'completed', 'pr_opened', 'summary', null, undefined, '']) expect(shared.chatRouteFor(r)).toBe('activity_feed')
  })

  const chat = () =>
    getDb()
      .prepare("SELECT * FROM agent_chat_messages WHERE agent_slug = 'cto' AND user_id = 1 AND json_extract(meta, '$.kind') = 'bot_needs_you' ORDER BY id")
      .all() as Loose[]
  const bots = [{ slug: 'cto', name: 'CTO' }, { slug: 'dev', name: 'Dev' }]

  it('the first pass anchors silently; a NEW need on a High Agency card posts once, with its reason', () => {
    const first = runBotAttentionTick(getDb(), bots)
    expect(first.posted).toBe(0)
    expect(first.seeded).toBe(false)
    expect(chat()).toHaveLength(0)

    // A card the wake filed goes over its ceiling → one message.
    const child = card({ status: 'working', session_id: 'live-9', source_job_id: ids.wakeReview, title: 'Pricing page' })
    setObjectiveCeiling(getDb(), child, { costUsd: 2 })
    spend(child, 2.5)
    // A NON-High-Agency card that needs a decision → not this poster's (it is not wake activity).
    card({ status: 'review', title: 'Chat-filed card' })
    // A wake-filed card that just finished → activity feed only, never chat.
    const finished = card({ status: 'working', source_job_id: ids.wakeReview })
    getDb().prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(finished)

    const second = runBotAttentionTick(getDb(), bots)
    expect(second.posted).toBe(1)
    const msgs = chat()
    expect(msgs).toHaveLength(1)
    const meta = JSON.parse(msgs[0].meta)
    expect(meta).toMatchObject({ kind: 'bot_needs_you', objective_id: child, reason: 'over_ceiling', spent_usd: 2.5, ceiling_usd: 2 })
    expect(msgs[0].content).toContain(`card #${child}`)
    expect(msgs[0].thread_id).toBeNull() // the MAIN conversation

    // Still over: no repeat.
    expect(runBotAttentionTick(getDb(), bots).posted).toBe(0)
    // Raise the ceiling → the reason clears; go over again → a new message.
    setObjectiveCeiling(getDb(), child, { costUsd: 50 })
    expect(runBotAttentionTick(getDb(), bots).cleared).toBe(1)
    setObjectiveCeiling(getDb(), child, { costUsd: 1 })
    expect(runBotAttentionTick(getDb(), bots).posted).toBe(1)
    expect(chat()).toHaveLength(2)
  })

  it('each of the four reasons is a message; every one names the card', () => {
    const meta = { kind: 'bot_needs_you' as const, objective_id: 7, title: 'X' }
    expect(attentionText('CTO', { ...meta, reason: 'approval_beyond_grant', action: 'deploy' })).toMatch(/approve a deploy on card #7/)
    expect(attentionText('CTO', { ...meta, reason: 'over_ceiling', spent_usd: 6, ceiling_usd: 5 })).toMatch(/\$6\.00 against its \$5\.00 ceiling/)
    expect(attentionText('CTO', { ...meta, reason: 'decision' })).toMatch(/decision from you on card #7/)
    expect(attentionText('CTO', { ...meta, reason: 'blocker' })).toMatch(/blocked on card #7/)
  })

  it('a High Agency card is not delivered to the chat thread on completion; a chat-filed card still is', () => {
    const db = getDb()
    enqueueBotThreadDeliveries(db) // anchor the cursor
    const haCard = card({ status: 'working', source_job_id: ids.wakeDone })
    const chatCard = card({ status: 'working', agent_context: 'general', owner_bot: 'Grok: CTO' })
    for (const id of [haCard, chatCard]) {
      db.prepare(
        "INSERT INTO bot_job_origins (objective_id, thread_user_id, thread_agent_slug, owner_bot, owner_user_id, workspace, idempotency_key) VALUES (?, 1, 'cto', 'Grok: CTO', 1, 'ops', ?)",
      ).run(id, `k-${id}`)
      db.prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(id)
    }
    expect(enqueueBotThreadDeliveries(db)).toBe(1)
    const rows = db.prepare('SELECT objective_id FROM bot_thread_deliveries').all() as Loose[]
    expect(rows.map(r => r.objective_id)).toEqual([chatCard])
  })

  it('old High Agency messages are flagged for collapsing at read time, never rewritten', async () => {
    const db = getDb()
    const oldId = Number(db.prepare("INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, meta) VALUES (1, 'cto', 'assistant', 'Your job finished — card', ?)").run(JSON.stringify({ bot_job: ids.picked })).lastInsertRowid)
    const plainId = Number(db.prepare("INSERT INTO agent_chat_messages (user_id, agent_slug, role, content) VALUES (1, 'cto', 'assistant', 'Hello')").run().lastInsertRowid)
    const r = await call('/agents/cto/messages')
    expect(r.status).toBe(200)
    const byId = Object.fromEntries((r.json.messages as Loose[]).map(m => [m.id, m]))
    expect(byId[oldId].meta.activity_feed).toBe(true)
    expect(byId[plainId].meta?.activity_feed).toBeUndefined()
    const needsYou = (r.json.messages as Loose[]).find(m => m.meta?.kind === 'bot_needs_you')
    expect(needsYou.meta.activity_feed).toBeUndefined()
    // The stored row is untouched.
    expect(JSON.parse((db.prepare('SELECT meta FROM agent_chat_messages WHERE id = ?').get(oldId) as Loose).meta)).toEqual({ bot_job: ids.picked })
    expect(markFeedMessage({ kind: 'high_agency_wake' }, '', () => false)).toBe(true)
    expect(markFeedMessage(null, 'High Agency wake for CTO — done', () => false)).toBe(true)
  })
})

// The board list's rule (lib/agent-control.ts visibilityClauseFor): a member
// with objective_visibility = 'all' in a workspace sees every card there; any
// other member sees only cards they are assigned to, created, or are an
// assignee on. The bot views apply it to EVERY card they read.
describe('card visibility: a member sees only what the board list shows them', () => {
  const cardsOf = (g: Loose) => [...g.running, ...g.review, ...g.queued, ...g.done]
  const opsOnly = (g: Loose) => idsIn(cardsOf(g).filter((c: Loose) => c.workspace === 'ops'))
  let visibleKid = 0
  let hiddenKid = 0

  beforeAll(() => {
    const db = getDb()
    // The three ways a card is the member's own on the board list.
    db.prepare('UPDATE objectives SET assigned_user_id = ? WHERE id IN (?, ?)').run(MEMBER, ids.blocked, ids.wakeReview)
    db.prepare('INSERT INTO objective_assignees (objective_id, user_id) VALUES (?, ?)').run(ids.queued, MEMBER)
    db.prepare('UPDATE objectives SET created_by = ? WHERE id = ?').run(MEMBER, ids.doneRecent)
    // One wake the member can see, with one card of theirs under it and one that is not.
    hiddenKid = card({ status: 'working', session_id: 'live-h', source_job_id: ids.wakeReview, title: 'Not the member\'s', pr_url: 'https://github.com/acme/repo/pull/41' })
    visibleKid = card({ status: 'working', session_id: 'live-v', source_job_id: ids.wakeReview, title: 'The member\'s own' })
    db.prepare('UPDATE objectives SET assigned_user_id = ? WHERE id = ?').run(MEMBER, visibleKid)
  })

  it('Work: an own-visibility member sees only the bot cards they are assigned to, created, or are an assignee on', async () => {
    const r = await call('/agents/cto/work', { as: MEMBER })
    expect(r.status).toBe(200)
    expect(r.json.workspaces).toEqual(['ops'])
    const g = r.json.groups
    expect(idsIn(g.running)).toEqual([ids.blocked, visibleKid].sort((a, b) => a - b)) // assigned
    expect(idsIn(g.review)).toEqual([ids.wakeReview]) // assigned
    expect(idsIn(g.queued)).toEqual([ids.queued]) // objective_assignees
    expect(idsIn(g.done)).toEqual([ids.doneRecent]) // created by them
    // The counts, the dot and the line are built from the same cards — nothing they cannot open.
    expect(r.json.counts).toEqual({ running: 2, review: 1, queued: 1, done: 1, needs_you: 2 })
    expect(r.json.line).toBe('2 need you · 2 running · 1 in review')
    for (const hidden of [ids.running, ids.decision, ids.aiReview, ids.denied, ids.deniedThenUsed, ids.picked, hiddenKid]) {
      expect(cardsOf(g).map((c: Loose) => c.id)).not.toContain(hidden)
    }
    // Nothing about a hidden card leaks through the body either (title, PR).
    const body = JSON.stringify(r.json)
    for (const leak of ['Ship the importer', 'Pick a vendor', 'Importer v2', 'Not the member', 'pull/9', 'pull/41']) expect(body).not.toContain(leak)
  })

  it('Activity: only wakes they can see, each naming only a card they can see; the summary counts only their cards', async () => {
    const r = await call('/agents/cto/activity', { as: MEMBER })
    expect(r.status).toBe(200)
    expect(r.json.entries.map((e: Loose) => e.wake_id)).toEqual([ids.wakeReview]) // wakeDone is not theirs
    expect(r.json.entries[0].picked).toMatchObject({ id: visibleKid }) // not the hidden sibling filed before it
    const s = r.json.summary
    expect(s.wakes).toBe(1)
    expect(s.shipped.map((c: Loose) => c.id)).toEqual([ids.doneRecent])
    expect(s.next.queued).toEqual([{ id: ids.queued, title: 'Queued thing' }])
    expect(s.next.needs_you).toBe(2)
    expect(s.spent_usd).toBe(0) // every dollar in the fixture was spent on cards they cannot see
    const body = JSON.stringify(r.json)
    for (const leak of ['Closed 2 cards', 'Importer v2', 'Not the member', 'pull/9', 'pull/41']) expect(body).not.toContain(leak)

    // The admin's feed still has both wakes, and names the first card the wake filed.
    const admin = await call('/agents/cto/activity')
    expect(admin.json.entries.map((e: Loose) => e.wake_id)).toEqual([ids.wakeReview, ids.wakeDone])
    expect(admin.json.entries[0].picked.id).not.toBe(visibleKid)
  })

  it('the expanded run: 404 for a wake they cannot see; invisible children are left out', async () => {
    expect((await call(`/agents/cto/activity/${ids.wakeDone}`, { as: MEMBER })).status).toBe(404)
    const mine = await call(`/agents/cto/activity/${ids.wakeReview}`, { as: MEMBER })
    expect(mine.status).toBe(200)
    expect(mine.json.run.children.map((c: Loose) => c.id)).toEqual([visibleKid])
    expect(mine.json.run.pr_url).toBeNull() // the hidden child's PR is not surfaced on the entry
    // The same wake as an admin carries every child.
    const admin = await call(`/agents/cto/activity/${ids.wakeReview}`)
    expect(admin.json.run.children.map((c: Loose) => c.id)).toEqual(expect.arrayContaining([hiddenKid, visibleKid]))
  })

  it('the sidebar: counts and the "Needs you" total cover only cards they can open', async () => {
    const r = await call('/bot-status', { as: MEMBER })
    expect(r.status).toBe(200)
    expect(r.json.bots.cto.counts).toEqual({ running: 2, review: 1, queued: 1, done: 1, needs_you: 2 })
    expect(r.json.bots.cto.state).toBe('waiting')
    // Dev's only card is not theirs.
    expect(r.json.bots.dev.counts).toEqual({ running: 0, review: 0, queued: 0, done: 0, needs_you: 0 })
    expect(r.json.bots.dev.state).toBe('idle')
    expect(r.json.bots.dev.line).toBe('Idle')
    expect(r.json.needs_you_total).toBe(2) // the blocked card + the wake waiting on a decision
  })

  it('an all-visibility member sees every bot card in their workspace, exactly as the admin does there', async () => {
    const admin = await call('/agents/cto/work')
    const all = await call('/agents/cto/work', { as: MEMBER_ALL })
    expect(all.json.workspaces).toEqual(['ops'])
    expect(idsIn(cardsOf(all.json.groups))).toEqual(opsOnly(admin.json.groups))
    expect(cardsOf(all.json.groups).length).toBeGreaterThan(8)
    expect(cardsOf(all.json.groups).map((c: Loose) => c.id)).toEqual(expect.arrayContaining([ids.running, ids.decision, ids.picked, hiddenKid]))

    const adminAct = await call('/agents/cto/activity')
    const allAct = await call('/agents/cto/activity', { as: MEMBER_ALL })
    expect(allAct.json.entries).toEqual(adminAct.json.entries) // every wake is in ops
    const run = await call(`/agents/cto/activity/${ids.wakeDone}`, { as: MEMBER_ALL })
    expect(run.status).toBe(200)
    expect(run.json.run.children.map((c: Loose) => c.id)).toContain(ids.picked)

    // Sidebar: the same needs-you cards the admin has in ops, across both bots.
    const needing = new Set<number>()
    for (const slug of ['cto', 'dev']) {
      const w = await call(`/agents/${slug}/work`)
      for (const c of [...w.json.groups.running, ...w.json.groups.review, ...w.json.groups.queued]) {
        if (c.workspace === 'ops' && c.needs_you.length > 0) needing.add(c.id)
      }
    }
    const status = await call('/bot-status', { as: MEMBER_ALL })
    expect(status.json.needs_you_total).toBe(needing.size)
    expect(status.json.needs_you_total).toBeGreaterThan(2)
    expect(status.json.bots.dev.counts.running).toBe(1)
  })

  it('visibility is per workspace: all-visibility in one, own-visibility in another', async () => {
    const db = getDb()
    db.prepare("INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, 'finance', 'member', 'all')").run(MEMBER)
    try {
      const r = await call('/agents/cto/work', { as: MEMBER })
      expect(r.json.workspaces.sort()).toEqual(['finance', 'ops'])
      const got = cardsOf(r.json.groups).map((c: Loose) => c.id)
      expect(got).toContain(ids.overCeiling) // finance: everything
      expect(got).not.toContain(ids.running) // ops: still only their own
      expect(r.json.counts.needs_you).toBe(3)
    } finally {
      db.prepare("DELETE FROM user_workspaces WHERE user_id = ? AND workspace = 'finance'").run(MEMBER)
    }
  })

  it('admins are unchanged: every card in the bot\'s granted workspaces, whoever owns it', async () => {
    const r = await call('/agents/cto/work')
    const got = cardsOf(r.json.groups).map((c: Loose) => c.id)
    // doneRecent now belongs to the member; hiddenKid and overCeiling to nobody the admin is "assigned" with.
    expect(got).toEqual(expect.arrayContaining([ids.running, ids.decision, ids.overCeiling, ids.doneRecent, ids.blocked, hiddenKid, visibleKid]))
    expect(r.json.workspaces.sort()).toEqual(['finance', 'ops'])
    expect((await call(`/agents/cto/activity/${ids.wakeDone}`)).status).toBe(200)
  })

  it('needs-you chat posts: a bot that runs as a member only announces cards that member can see', () => {
    const db = getDb()
    const bots = [{ slug: 'cto', name: 'CTO' }, { slug: 'dev', name: 'Dev' }]
    const memberPosts = () =>
      (db.prepare("SELECT meta FROM agent_chat_messages WHERE agent_slug = 'cto' AND user_id = ? AND json_extract(meta, '$.kind') = 'bot_needs_you' ORDER BY id").all(MEMBER) as Loose[])
        .map(m => JSON.parse(m.meta).objective_id)
    db.prepare("UPDATE agent_chat_high_agency SET run_as_user_id = ? WHERE slug = 'cto'").run(MEMBER)
    try {
      runBotAttentionTick(db, bots) // settle: reasons on cards the member cannot see are dropped
      const before = memberPosts().length
      // Two wake-filed cards get blocked: one is the member's, one is not.
      const theirs = card({ status: 'working', session_id: 'live-m1', source_job_id: ids.wakeReview, has_blockers: 1, title: 'Blocked, the member\'s' })
      db.prepare('UPDATE objectives SET assigned_user_id = ? WHERE id = ?').run(MEMBER, theirs)
      const notTheirs = card({ status: 'working', session_id: 'live-m2', source_job_id: ids.wakeReview, has_blockers: 1, title: 'Blocked, someone else\'s' })
      const tick = runBotAttentionTick(db, bots)
      expect(tick.posted).toBe(1)
      const posts = memberPosts()
      expect(posts.length).toBe(before + 1)
      expect(posts).toContain(theirs)
      expect(posts).not.toContain(notTheirs)
      expect(db.prepare('SELECT 1 FROM bot_attention_posts WHERE objective_id = ?').get(notTheirs)).toBeUndefined()

      // Back to an admin: the card the member could not see is announced to the admin.
      db.prepare("UPDATE agent_chat_high_agency SET run_as_user_id = ? WHERE slug = 'cto'").run(ADMIN)
      runBotAttentionTick(db, bots)
      const adminPosts = (db.prepare("SELECT meta FROM agent_chat_messages WHERE agent_slug = 'cto' AND user_id = ? AND json_extract(meta, '$.kind') = 'bot_needs_you'").all(ADMIN) as Loose[])
        .map(m => JSON.parse(m.meta).objective_id)
      expect(adminPosts).toContain(notTheirs)
    } finally {
      db.prepare("UPDATE agent_chat_high_agency SET run_as_user_id = ? WHERE slug = 'cto'").run(ADMIN)
    }
  })
})
