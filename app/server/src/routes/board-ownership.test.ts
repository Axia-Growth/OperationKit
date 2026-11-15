/**
 * obj 900869 — board ownership, bot approvals and Needs You bulk triage, end to
 * end over the real routers and the real agent-key guard. Throwaway temp DB:
 * every card here is a fixture.
 *
 *   - owner shifts: a bot card reads as the bot while it works and as the human
 *     the moment it sits in Needs You; a claim makes a bot the owner;
 *   - bot approval eligibility: grant (open PR + active merge grant), rule (own
 *     reviewed work), and every deny path — no grant, revoked/expired grant,
 *     another bot's card, no passing review, needs a secret, money path, not in
 *     Needs You, and a person (cookie) trying the bot route;
 *   - bulk triage: approve / dismiss / reassign with per-card audit rows; a card
 *     not in Needs You or not the caller's is SKIPPED, not moved; a bot key and
 *     a Bearer JWT cannot reach the route at all.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-board-ownership-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-board-ownership'
process.env.TRANSCRIPT_DIR = TMP

vi.mock('../services/worktree-reaper.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, scheduleObjectiveWorktreeReap: () => {} }
})

const { initDb, getDb } = await import('../db/index.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { createGrant, revokeGrant } = await import('../services/delegated-approvals.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: boardTriageRouter } = await import('./board-triage.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const MEMBER = 2
const BOT = 'Operation Kit'
const OTHER_BOT = 'Grok: CTO'
let server: http.Server
let baseUrl: string
let botKey = ''

const cookie = (id: number, role: string, username: string) =>
  `token=${jwt.sign({ id, username, role }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`
const ownerCookie = () => cookie(OWNER, 'admin', 'operator')
const memberCookie = () => cookie(MEMBER, 'member', 'casey')
const ownerBearer = () => `Bearer ${jwt.sign({ id: OWNER, username: 'operator', role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json }
}
const asOwner = (m: string, p: string, b?: unknown) => call(m, p, { Cookie: ownerCookie() }, b)
const asMember = (m: string, p: string, b?: unknown) => call(m, p, { Cookie: memberCookie() }, b)
const asBot = (m: string, p: string, b?: unknown) => call(m, p, { Authorization: `Bearer ${botKey}` }, b)

interface CardSpec {
  title?: string
  status?: string
  session_id?: string | null
  owner_bot?: string | null
  agent_context?: string
  workspace?: string
  created_by?: number
  assigned_user_id?: number | null
  ai_review_verdict?: string | null
  pr_url?: string | null
  pr_number?: number | null
  needs_secret?: string | null
  is_strategy?: number
}

let seq = 0
function card(spec: CardSpec = {}): number {
  seq += 1
  const db = getDb()
  const id = Number(db.prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id, owner_bot, assigned_user_id, ai_review_verdict, pr_url, pr_number, needs_secret, is_strategy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    spec.title ?? `fixture card ${seq}`,
    spec.agent_context ?? 'general',
    spec.workspace ?? 'growth',
    spec.created_by ?? OWNER,
    spec.status ?? 'review',
    spec.session_id ?? null,
    spec.owner_bot === undefined ? BOT : spec.owner_bot,
    spec.assigned_user_id ?? null,
    spec.ai_review_verdict ?? null,
    spec.pr_url ?? null,
    spec.pr_number ?? null,
    spec.needs_secret ?? null,
    spec.is_strategy ?? 0,
  ).lastInsertRowid)
  if (spec.assigned_user_id) db.prepare('INSERT OR IGNORE INTO objective_assignees (objective_id, user_id) VALUES (?, ?)').run(id, spec.assigned_user_id)
  return id
}

const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const auditFor = (id: number) => getDb().prepare('SELECT event_type, from_status, to_status, actor, pathway FROM objective_audit WHERE objective_id = ? ORDER BY id').all(id) as Loose[]

function grant(actions: string[], opts: { workspace?: string; bot?: string } = {}) {
  return createGrant(getDb(), {
    grantor: { id: OWNER, username: 'operator' },
    botName: opts.bot ?? BOT,
    agentSlug: null,
    workspace: opts.workspace ?? 'growth',
    actions,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    allowedWorkspaces: ['growth', 'other'],
  })
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'casey', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('growth', 'Growth'), ('other', 'Other')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'growth', 'admin'), (1, 'other', 'admin'), (2, 'growth', 'member')`).run()
  // The CI-green gate would shell out to gh for a PR card; this suite tests
  // ownership, not that gate (it has its own suite).
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ci_green_gate_enabled', '0')`).run()
  const k = createAgentKey({ id: OWNER, role: 'admin' }, { label: 'OpKit', scopes: ['board:read', 'board:write'] })
  if (!k.ok) throw new Error(k.error)
  botKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/board-triage', boardTriageRouter)
  server = http.createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('owner on the card payload (shifts with the column)', () => {
  it('a bot card is the bot while it works, the human once it sits in Needs You', async () => {
    const id = card({ status: 'working', session_id: 'cc-x-1', assigned_user_id: OWNER })
    let r = await asOwner('GET', `/api/objectives/${id}`)
    expect(r.status).toBe(200)
    expect(r.json.bot_owner).toBe(BOT)
    expect(r.json.current_owner).toMatchObject({ kind: 'bot', label: BOT, needs_human: false })

    getDb().prepare("UPDATE objectives SET status = 'review', session_id = NULL WHERE id = ?").run(id)
    r = await asOwner('GET', `/api/objectives/${id}`)
    expect(r.json.current_owner).toMatchObject({ kind: 'human', label: 'operator', needs_human: true, handed_off_from_bot: BOT })
  })

  it('an unassigned Needs You card falls to the person who filed it', async () => {
    const id = card({ created_by: MEMBER, assigned_user_id: null })
    const r = await asOwner('GET', `/api/objectives/${id}`)
    expect(r.json.created_by_username).toBe('casey')
    expect(r.json.current_owner).toMatchObject({ kind: 'human', label: 'casey' })
  })

  it('a card with no owner_bot resolves its bot from the chat slug in agent_context', async () => {
    const id = card({ owner_bot: null, agent_context: 'operation-kit', status: 'working', session_id: 'cc-x-2' })
    const r = await asOwner('GET', `/api/objectives/${id}`)
    expect(r.json.bot_owner).toBe(BOT)
    expect(r.json.current_owner.kind).toBe('bot')
  })

  it('the DEFAULT agent_context (general) never implies a bot, even though the General bot lists that slug', async () => {
    const id = card({ owner_bot: null, agent_context: 'general', status: 'queue', assigned_user_id: OWNER })
    const r = await asOwner('GET', `/api/objectives/${id}`)
    expect(r.json.bot_owner).toBeNull()
    expect(r.json.current_owner).toMatchObject({ kind: 'human', label: 'operator' })
    // An explicit owner_bot still names the General bot.
    getDb().prepare("UPDATE objectives SET owner_bot = 'Grok: General' WHERE id = ?").run(id)
    const r2 = await asOwner('GET', `/api/objectives/${id}`)
    expect(r2.json.current_owner).toMatchObject({ kind: 'bot', label: 'General' })
  })

  it('a bot claim makes the bot the owner and writes an owner_change audit row', async () => {
    const id = card({ owner_bot: null, status: 'queue' })
    const r = await asBot('POST', `/api/objectives/${id}/claim`, { owner_bot: 'okit' })
    expect(r.status).toBe(200)
    expect(r.json.owner_bot).toBe(BOT)
    expect(r.json.current_owner).toMatchObject({ kind: 'bot', label: BOT })
    expect(auditFor(id).some(a => a.event_type === 'owner_change' && String(a.pathway).startsWith('owner-claim:none->Operation Kit'))).toBe(true)
  })

  it('claim: a person cannot use the bot route, an unknown bot is refused', async () => {
    const id = card({ status: 'queue' })
    expect((await asOwner('POST', `/api/objectives/${id}/claim`, { owner_bot: BOT })).status).toBe(403)
    const bad = await asBot('POST', `/api/objectives/${id}/claim`, { owner_bot: 'Operaton Kit' })
    expect(bad.status).toBe(400)
    expect(bad.json.known_bots).toContain(BOT)
  })
})

describe('bot approval — eligible under an existing grant or the no-signature rule', () => {
  it('rule: the bot closes its own reviewed work (no PR) → done, audited, not a human terminal', async () => {
    const id = card({ ai_review_verdict: 'pass' })
    const pre = await asBot('GET', `/api/objectives/${id}/bot-approval?bot=${encodeURIComponent(BOT)}`)
    expect(pre.json).toMatchObject({ eligible: true, need: 'close', basis: 'rule:own_work_reviewed', bot: BOT })

    const r = await asBot('POST', `/api/objectives/${id}/bot-approve`, { owner_bot: BOT })
    expect(r.status).toBe(200)
    expect(r.json.approved).toBe(true)
    expect(statusOf(id)).toBe('done')
    const row = getDb().prepare('SELECT terminal_by_human FROM objectives WHERE id = ?').get(id) as { terminal_by_human: number }
    expect(row.terminal_by_human).toBe(0)
    expect(auditFor(id).some(a => a.event_type === 'status_change' && a.to_status === 'done' && a.pathway === 'bot-approve:rule:own_work_reviewed' && String(a.actor).startsWith('bot:Operation Kit'))).toBe(true)
    const used = getDb().prepare("SELECT * FROM delegation_audit WHERE objective_id = ? AND event = 'approval_used'").get(id) as Loose
    expect(used.action).toBe('card_close')
    const line = getDb().prepare("SELECT title FROM activity_log WHERE objective_id = ? AND event_type = 'decision'").get(id) as { title: string }
    expect(line.title).toContain('Closed by Operation Kit')
  })

  it('rule: the General bot cannot pass off a persona-less card (agent_context=general, no owner_bot) as its own work', async () => {
    const id = card({ owner_bot: null, agent_context: 'general', ai_review_verdict: 'pass' })
    const r = await asBot('GET', `/api/objectives/${id}/bot-approval?bot=${encodeURIComponent('Grok: General')}`)
    expect(r.json).toMatchObject({ eligible: false, refusal: 'not_bot_owned', bot: 'Grok: General' })
  })

  it('grant: an open PR needs a merge grant — refused without, approved with, refused again once revoked', async () => {
    const id = card({ pr_url: 'https://github.com/x/y/pull/9', pr_number: 9, ai_review_verdict: 'pass' })
    getDb().prepare("INSERT INTO objective_prs (objective_id, repo, pr_number, pr_url, state) VALUES (?, 'x/y', 9, 'https://github.com/x/y/pull/9', 'open')").run(id)

    let r = await asBot('POST', `/api/objectives/${id}/bot-approve`, { owner_bot: BOT })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('no_active_grant')
    expect(statusOf(id)).toBe('review')

    // A deploy grant is not a merge grant.
    const g0 = grant(['deploy'])
    r = await asBot('POST', `/api/objectives/${id}/bot-approve`, { owner_bot: BOT })
    expect(r.json.code).toBe('no_active_grant')

    const g = grant(['merge'])
    revokeGrant(getDb(), g.id, BOT, 'operator')
    r = await asBot('POST', `/api/objectives/${id}/bot-approve`, { owner_bot: BOT })
    expect(r.json.code).toBe('no_active_grant')

    const g2 = grant(['merge'])
    const pre = await asBot('GET', `/api/objectives/${id}/bot-approval?bot=${encodeURIComponent(BOT)}`)
    expect(pre.json).toMatchObject({ eligible: true, need: 'merge', basis: 'grant', grant_id: g2.id })
    r = await asBot('POST', `/api/objectives/${id}/bot-approve`, { owner_bot: BOT })
    expect(r.status).toBe(200)
    expect(statusOf(id)).toBe('done')
    const used = getDb().prepare("SELECT grant_id FROM delegation_audit WHERE objective_id = ? AND event = 'approval_used'").get(id) as Loose
    expect(used.grant_id).toBe(g2.id)
    revokeGrant(getDb(), g2.id, BOT, 'operator')
    revokeGrant(getDb(), g0.id, BOT, 'operator')
  })

  it('a grant in another workspace does not count', async () => {
    const id = card({ pr_url: 'https://github.com/x/y/pull/10', pr_number: 10 })
    const g = grant(['merge'], { workspace: 'other' })
    const r = await asBot('POST', `/api/objectives/${id}/bot-approve`, { owner_bot: BOT })
    expect(r.json.code).toBe('no_active_grant')
    revokeGrant(getDb(), g.id, BOT, 'operator')
  })

  it.each([
    ['another bot\'s card', { owner_bot: OTHER_BOT, ai_review_verdict: 'pass' }, 'not_bot_owned'],
    ['no passing review', { ai_review_verdict: 'fail' }, 'no_passing_review'],
    ['waiting on a secret', { ai_review_verdict: 'pass', needs_secret: JSON.stringify([{ name: 'X', reason: 'r' }]) }, 'needs_secret'],
    ['money path', { ai_review_verdict: 'pass', title: 'Stripe billing refund flow' }, 'money_path'],
    ['a Strategy', { ai_review_verdict: 'pass', is_strategy: 1 }, 'strategy'],
    ['an agent still on it', { ai_review_verdict: 'pass', session_id: 'cc-live-1' }, 'not_in_needs_you'],
    ['not in review', { ai_review_verdict: 'pass', status: 'queue' }, 'not_in_needs_you'],
  ] as const)('refuses: %s', async (_label, spec, code) => {
    const id = card(spec as CardSpec)
    const before = statusOf(id)
    const r = await asBot('POST', `/api/objectives/${id}/bot-approve`, { owner_bot: BOT })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe(code)
    expect(statusOf(id)).toBe(before)
    const denied = getDb().prepare("SELECT reason FROM delegation_audit WHERE objective_id = ? AND event = 'approval_denied'").get(id) as Loose
    expect(denied.reason).toBe(code)
  })

  it('a person (cookie or Bearer JWT) cannot use the bot route', async () => {
    const id = card({ ai_review_verdict: 'pass' })
    expect((await asOwner('POST', `/api/objectives/${id}/bot-approve`)).status).toBe(403)
    expect((await call('POST', `/api/objectives/${id}/bot-approve`, { Authorization: ownerBearer() })).status).toBe(403)
    expect(statusOf(id)).toBe('review')
  })

  it('a key without board:write is stopped by the guard before the route', async () => {
    const ro = createAgentKey({ id: OWNER, role: 'admin' }, { label: 'ReadOnly', scopes: ['board:read'] })
    if (!ro.ok) throw new Error(ro.error)
    const id = card({ ai_review_verdict: 'pass' })
    const r = await call('POST', `/api/objectives/${id}/bot-approve`, { Authorization: `Bearer ${ro.key.token}` }, { owner_bot: BOT })
    expect(r.status).toBe(403)
    expect(r.json.missing_scope).toBe('board:write')
  })
})

describe('Needs You bulk triage', () => {
  it('approve: moves every Needs You card to done, skips the rest, audits batch + cards', async () => {
    const a = card()
    const b = card()
    const running = card({ session_id: 'cc-live-2' })
    const queued = card({ status: 'queue' })
    const r = await asOwner('POST', '/api/board-triage/batches', { action: 'approve', objective_ids: [a, b, running, queued], note: 'clearing the backlog' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ action: 'approve', requested: 4, ok: 2, skipped: 2, failed: 0 })
    expect(statusOf(a)).toBe('done')
    expect(statusOf(b)).toBe('done')
    expect(statusOf(running)).toBe('review')
    expect(statusOf(queued)).toBe('queue')
    const batchId = r.json.batch_id
    const batch = getDb().prepare('SELECT * FROM board_triage_batches WHERE id = ?').get(batchId) as Loose
    expect(batch).toMatchObject({ action: 'approve', actor: 'operator', requested: 4, ok: 2, skipped: 2, failed: 0, note: 'clearing the backlog' })
    expect(batch.finished_at).toBeTruthy()
    const items = getDb().prepare('SELECT objective_id, result FROM board_triage_items WHERE batch_id = ? ORDER BY id').all(batchId) as Loose[]
    expect(items.map(i => i.result)).toEqual(['ok', 'ok', 'skipped', 'skipped'])
    expect(auditFor(a).some(x => x.event_type === 'status_change' && x.to_status === 'done' && x.pathway === `bulk-triage:${batchId}` && x.actor === 'user:operator')).toBe(true)

    const list = await asOwner('GET', '/api/board-triage/batches')
    expect(list.json.batches[0]).toMatchObject({ id: batchId, action: 'approve', ok: 2 })
    const detail = await asOwner('GET', `/api/board-triage/batches/${batchId}`)
    expect(detail.json.items).toHaveLength(4)
  })

  it('dismiss: Needs You → cancelled', async () => {
    const a = card()
    const r = await asOwner('POST', '/api/board-triage/batches', { action: 'dismiss', objective_ids: [a] })
    expect(r.json.ok).toBe(1)
    expect(statusOf(a)).toBe('cancelled')
  })

  it('reassign: hands cards to a bot and/or people; status untouched; owner_change audited', async () => {
    const a = card({ owner_bot: null })
    const r = await asOwner('POST', '/api/board-triage/batches', { action: 'reassign', objective_ids: [a], owner_bot: 'General', assigned_user_ids: [MEMBER] })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(1)
    const row = getDb().prepare('SELECT owner_bot, assigned_user_id, status FROM objectives WHERE id = ?').get(a) as Loose
    expect(row).toMatchObject({ owner_bot: 'Grok: General', assigned_user_id: MEMBER, status: 'review' })
    const got = await asOwner('GET', `/api/objectives/${a}`)
    expect(got.json.current_owner).toMatchObject({ kind: 'human', label: 'casey', handed_off_from_bot: 'General' })
    expect(auditFor(a).some(x => x.event_type === 'owner_change' && String(x.pathway).includes('bot:none->Grok: General'))).toBe(true)
  })

  it('reassign validates the target before touching any card', async () => {
    const a = card({ owner_bot: null })
    expect((await asOwner('POST', '/api/board-triage/batches', { action: 'reassign', objective_ids: [a], owner_bot: 'Nobody Bot' })).status).toBe(400)
    expect((await asOwner('POST', '/api/board-triage/batches', { action: 'reassign', objective_ids: [a], assigned_user_ids: [999] })).status).toBe(400)
    expect((await asOwner('POST', '/api/board-triage/batches', { action: 'reassign', objective_ids: [a] })).status).toBe(400)
    const row = getDb().prepare('SELECT owner_bot FROM objectives WHERE id = ?').get(a) as Loose
    expect(row.owner_bot).toBeNull()
  })

  it('a member only moves cards they own; the rest are skipped', async () => {
    const mine = card({ created_by: MEMBER })
    const notMine = card({ created_by: OWNER })
    const r = await asMember('POST', '/api/board-triage/batches', { action: 'approve', objective_ids: [mine, notMine] })
    expect(r.json).toMatchObject({ ok: 1, skipped: 1 })
    expect(statusOf(notMine)).toBe('review')
  })

  it('refuses a bot key, a Bearer JWT, bad input and an oversize batch', async () => {
    const a = card()
    const bot = await asBot('POST', '/api/board-triage/batches', { action: 'approve', objective_ids: [a] })
    expect(bot.status).toBe(403)
    const bearer = await call('POST', '/api/board-triage/batches', { Authorization: ownerBearer() }, { action: 'approve', objective_ids: [a] })
    expect(bearer.status).toBe(403)
    expect(statusOf(a)).toBe('review')
    expect((await asOwner('POST', '/api/board-triage/batches', { action: 'nuke', objective_ids: [a] })).status).toBe(400)
    expect((await asOwner('POST', '/api/board-triage/batches', { action: 'approve', objective_ids: [] })).status).toBe(400)
    const many = Array.from({ length: 101 }, (_, i) => i + 1)
    expect((await asOwner('POST', '/api/board-triage/batches', { action: 'approve', objective_ids: many })).status).toBe(400)
  })

  it('owners lists people and registry bots', async () => {
    const r = await asOwner('GET', '/api/board-triage/owners')
    expect(r.json.humans.map((h: Loose) => h.username)).toEqual(['casey', 'operator'])
    expect(r.json.bots.map((b: Loose) => b.id)).toContain(BOT)
  })
})

describe('agent surface', () => {
  it('bot-approve / claim are board:write; bulk triage is off the agent surface entirely', async () => {
    const { requiredScope } = await import('../middleware/agent-key-guard.js')
    expect(requiredScope('POST', '/api/objectives/5/bot-approve', {})).toEqual({ kind: 'scope', scope: 'board:write' })
    expect(requiredScope('POST', '/api/objectives/5/claim', {})).toEqual({ kind: 'scope', scope: 'board:write' })
    expect(requiredScope('GET', '/api/objectives/5/bot-approval', {})).toEqual({ kind: 'scope', scope: 'board:read' })
    expect(requiredScope('POST', '/api/board-triage/batches', {})).toEqual({ kind: 'off_surface' })
    expect(requiredScope('GET', '/api/board-triage/owners', {})).toEqual({ kind: 'off_surface' })
  })
})
