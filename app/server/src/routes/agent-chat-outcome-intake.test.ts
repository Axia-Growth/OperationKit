// Outcome-first intake (obj 901764), end to end through the real chat tool, the
// real routes and a temp SQLite DB:
//   1. A bot that can file cards gets propose_outcome (implied by create_objective,
//      no agent-file edit) and the platform prompt tells it to use it.
//   2. propose_outcome files NOTHING; a proposal with no done-bar is refused with the gaps.
//   3. The proposal is the person's: someone else reads 404; an API-style bearer
//      token cannot edit or approve it (browser cookie only).
//   4. The person's edits win: approve files the outcome card + children through the
//      bot's own create path, freezes criteria + standing rules into acceptance_criteria,
//      writes the approved plan, registers the children as a fan-out and starts the card.
//   5. A double approve files nothing twice; a look-alike open card holds the approval
//      back until "file anyway"; discard files nothing.
//   6. Standing rules: saved only from the approve click, frozen into later cards,
//      skippable per proposal, removable by an admin or their author only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-outcome-intake-xxxxxxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-outcome-intake-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-outcome-intake-kb-'))
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-outcome-intake-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
fs.mkdirSync(path.join(TMP_AGENTS, 'operator'), { recursive: true })
fs.writeFileSync(
  path.join(TMP_AGENTS, 'operator', 'agent.yaml'),
  'name: Operator\ndescription: Turns requests into cards\ntools: [create_objective, list_objectives]\nknowledge_folders: [shared]\ncolour: amber\nversion: 1.0.0\nauthor: Test\nsystem_prompt: You turn requests into cards.\n',
)

// The board's Start, stubbed: the real one spawns a worker session.
const starts: number[] = []
vi.mock('./objectives-status.js', () => ({
  runStatusChange: vi.fn(async (_req: unknown, id: number) => {
    starts.push(id)
    const { getDb } = await import('../db/index.js')
    getDb().prepare("UPDATE objectives SET status = 'working' WHERE id = ?").run(id)
    return { code: 200, body: { id, status: 'working' } }
  }),
}))

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat-outcome-intake.js')
const { runChatTool, toolSpecsFor, effectiveTools, ToolUseError } = await import('../services/agent-chat/tools.js')
const { findAgent, systemPromptFor } = await import('../services/agent-chat/engine.js')
const { grantBotWorkspace } = await import('../services/agent-chat/bot-workspaces.js')
const { createWorkspace } = await import('../services/workspaces.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const ALICE = 2 // a member of the workspace
const BOB = 3 // another member
const WS = 'growth'
let server: Server
let baseUrl = ''

function tokenFor(id: number) {
  const role = id === ADMIN ? 'admin' : 'member'
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as: number; body?: unknown; bearer?: boolean }) {
  const auth: Record<string, string> = opts.bearer ? { Authorization: `Bearer ${tokenFor(opts.as)}` } : { Cookie: `token=${tokenFor(opts.as)}` }
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...auth },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Loose }
}

function ctx(userId = ALICE) {
  return { userId, username: `user${userId}`, workspace: WS, agent: findAgent('operator')!, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } }
}

const GOOD = {
  outcome: 'I want a contact form on the website that emails sales, and before-and-after screenshots on every PR.',
  title: 'Contact form on the website emails sales',
  brief: 'Add a contact form to the marketing site. Submissions email the sales inbox.',
  done_when: 'One open PR with CI green; submitting the form on the preview sends an email to sales.',
  criteria: [
    { criterion: 'The contact page shows name, email and message fields', type: 'visual', method: 'browser' },
    { criterion: 'A submission sends one email to the sales inbox' },
  ],
  standing_rules: [{ text: 'Before-and-after screenshots in the pull request description', applies_to: 'pr' }],
}

const cards = () => getDb().prepare('SELECT id, title, status, parent_id, acceptance_criteria, approved_plan, plan_approved_at, completion_goal, description FROM objectives ORDER BY id').all() as Loose[]

async function propose(args: Loose = GOOD, userId = ALICE) {
  const r = (await runChatTool(ctx(userId) as Loose, 'propose_outcome', args)) as Loose
  return r
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user1', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(ALICE)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user3', 'x', 'member')`).run(BOB)
  createWorkspace({ slug: WS, name: 'Growth', default_agent_pool: ['general'] })
  for (const u of [ALICE, BOB]) db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, ?, 'member', 'all')`).run(u, WS)
  grantBotWorkspace('operator', WS, 'user1')

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  const { requireAuth } = await import('../middleware/auth.js')
  app.use('/api/agent-chat', requireAuth, router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  for (const t of ['agent_chat_cards', 'bot_job_origins', 'idempotency_keys', 'outcome_proposals', 'outcome_rules', 'fanout_groups', 'agent_chat_messages']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  db.prepare('DELETE FROM objectives').run()
  starts.length = 0
})

describe('propose_outcome is a tool every card-filing bot has', () => {
  it('is implied by create_objective, with no agent-file edit, and the platform prompt says when to use it', () => {
    const agent = findAgent('operator')!
    expect(agent.tools).not.toContain('propose_outcome')
    expect(effectiveTools(agent)).toContain('propose_outcome')
    expect(toolSpecsFor(agent).map(s => s.function.name)).toContain('propose_outcome')
    const prompt = systemPromptFor(agent, { username: 'user2', now: new Date('2026-11-23T10:00:00Z'), connectors: [] })
    expect(prompt).toContain('propose_outcome')
    expect(prompt).toContain('Never ask them to pick skills, tools or knowledge folders')
  })
})

describe('propose_outcome files nothing', () => {
  it('stores a pending proposal and no card', async () => {
    const r = await propose()
    expect(r.outcome_proposal_id).toBeGreaterThan(0)
    expect(r.result.note).toMatch(/NOTHING is filed/)
    expect(cards()).toHaveLength(0)
    const row = getDb().prepare('SELECT status, workspace, user_id, agent_slug FROM outcome_proposals WHERE id = ?').get(r.outcome_proposal_id) as Loose
    expect(row).toMatchObject({ status: 'pending', workspace: WS, user_id: ALICE, agent_slug: 'operator' })
  })

  it('refuses a proposal with no definition of done, naming the gaps', async () => {
    await expect(propose({ outcome: 'a contact form', title: 'Contact form', brief: 'Build it', done_when: '', criteria: [] })).rejects.toBeInstanceOf(ToolUseError)
    await expect(propose({ outcome: 'a contact form', title: 'Contact form', brief: 'Build it', done_when: '', criteria: [] })).rejects.toThrow(/done when.*acceptance criterion/s)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM outcome_proposals').get()).toEqual({ n: 0 })
  })
})

describe('the proposal belongs to the person, in the browser', () => {
  it('another person reads it as missing; a bearer token cannot edit or approve it', async () => {
    const { outcome_proposal_id: id } = await propose()
    const mine = await call('GET', `/outcome-proposals/${id}`, { as: ALICE })
    expect(mine.status).toBe(200)
    expect(mine.json).toMatchObject({ status: 'pending', can_edit: true, workspace: WS })
    expect(mine.json.proposal.card.criteria).toHaveLength(2)

    expect((await call('GET', `/outcome-proposals/${id}`, { as: BOB })).status).toBe(404)
    expect((await call('POST', `/outcome-proposals/${id}/approve`, { as: BOB })).status).toBe(404)
    expect((await call('POST', `/outcome-proposals/${id}/approve`, { as: ALICE, bearer: true })).status).toBe(403)
    expect((await call('PUT', `/outcome-proposals/${id}`, { as: ALICE, bearer: true, body: { proposal: mine.json.proposal } })).status).toBe(403)
    expect(cards()).toHaveLength(0)
  })

  it('saves valid edits and refuses edits that drop the definition of done', async () => {
    const { outcome_proposal_id: id } = await propose()
    const { json } = await call('GET', `/outcome-proposals/${id}`, { as: ALICE })
    const bad = { ...json.proposal, card: { ...json.proposal.card, criteria: [] } }
    const refused = await call('PUT', `/outcome-proposals/${id}`, { as: ALICE, body: { proposal: bad } })
    expect(refused.status).toBe(400)
    expect(refused.json.errors.join(' ')).toMatch(/acceptance criterion/)
    const edited = { ...json.proposal, card: { ...json.proposal.card, title: 'Website contact form that emails sales' } }
    const ok = await call('PUT', `/outcome-proposals/${id}`, { as: ALICE, body: { proposal: edited } })
    expect(ok.status).toBe(200)
    expect(ok.json.proposal.card.title).toBe('Website contact form that emails sales')
  })
})

describe('approve files the approved breakdown through the existing paths', () => {
  it('files the outcome card and children with their criteria, saves + freezes the standing rule, fans out, and starts', async () => {
    const { outcome_proposal_id: id } = await propose()
    const { json } = await call('GET', `/outcome-proposals/${id}`, { as: ALICE })
    // The person edits before approving: a criterion added, a child split added.
    const edited = {
      ...json.proposal,
      card: { ...json.proposal.card, criteria: [...json.proposal.card.criteria, { criterion: 'Spam submissions are rejected', type: 'functional', method: 'api' }] },
      children: [
        { title: 'Contact form page', brief: 'Build the form page.', done_when: 'The page renders on the preview.', criteria: [{ criterion: 'The form validates the email field' }], stop_conditions: [] },
        { title: 'Sales email delivery', brief: 'Send submissions to sales.', done_when: 'A test submission reaches the sales inbox.', criteria: [{ criterion: 'One email per submission' }], stop_conditions: ['the mail provider needs a paid plan'] },
      ],
    }
    const r = await call('POST', `/outcome-proposals/${id}/approve`, { as: ALICE, body: { proposal: edited } })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('approved')
    expect(r.json.started).toBe(true)

    const all = cards()
    expect(all).toHaveLength(3)
    const [parent, c1, c2] = all
    expect(parent.title).toBe('Contact form on the website emails sales')
    expect(parent.completion_goal).toBe(GOOD.done_when)
    expect(parent.status).toBe('working')
    expect(starts).toEqual([parent.id])
    expect([c1.parent_id, c2.parent_id]).toEqual([parent.id, parent.id])
    expect([c1.status, c2.status]).toEqual(['queue', 'queue']) // the fan-out tick starts them

    // The standing rule was saved for the workspace and frozen into every card.
    const rules = getDb().prepare('SELECT id, text, applies_to, created_by FROM outcome_rules').all() as Loose[]
    expect(rules).toEqual([expect.objectContaining({ text: GOOD.standing_rules[0].text, applies_to: 'pr', created_by: ALICE })])
    const pc = JSON.parse(parent.acceptance_criteria)
    expect(pc.map((c: Loose) => c.criterion)).toContain('Spam submissions are rejected')
    expect(pc.find((c: Loose) => c.id === `rule-${rules[0].id}`).criterion).toMatch(/every pull request: Before-and-after screenshots/)
    for (const child of [c1, c2]) {
      const cc = JSON.parse(child.acceptance_criteria)
      expect(cc.map((c: Loose) => c.id)).toContain(`rule-${rules[0].id}`)
      expect(child.description).toContain(`of the outcome on card #${parent.id}`)
      expect(child.plan_approved_at).toBeTruthy()
    }
    expect(c2.description).toContain('## Stop and report if')

    // The planning stage's own columns carry the approved breakdown.
    expect(parent.plan_approved_at).toBeTruthy()
    expect(parent.approved_plan).toContain(`#${c1.id} Contact form page`)
    expect(parent.approved_plan).toContain('do NOT redo or re-file the child cards')
    expect(parent.approved_plan).toContain('you do not grade yourself')

    // The children run as a fan-out under the server's ceiling.
    const group = getDb().prepare('SELECT child_ids FROM fanout_groups WHERE parent_id = ?').get(parent.id) as Loose
    expect(JSON.parse(group.child_ids)).toEqual([c1.id, c2.id])

    // The cards are the bot's cards (filed through its own create path).
    const origins = getDb().prepare('SELECT objective_id, thread_agent_slug FROM bot_job_origins ORDER BY objective_id').all() as Loose[]
    expect(origins.map((o: Loose) => o.thread_agent_slug)).toEqual(['operator', 'operator', 'operator'])

    // The chat lane says what was filed.
    const line = getDb().prepare("SELECT content, meta FROM agent_chat_messages WHERE agent_slug = 'operator' AND user_id = ?").get(ALICE) as Loose
    expect(line.content).toContain(`#${parent.id}`)
    expect(JSON.parse(line.meta)).toMatchObject({ kind: 'outcome_approved', outcome_proposal_id: id, objective_id: parent.id })

    // A second click files nothing.
    const again = await call('POST', `/outcome-proposals/${id}/approve`, { as: ALICE, body: { proposal: edited } })
    expect(again.status).toBe(409)
    expect(cards()).toHaveLength(3)
    expect(starts).toHaveLength(1)
  })

  it('a look-alike open card holds the approval back until "file anyway"', async () => {
    const { outcome_proposal_id: first } = await propose({ ...GOOD, standing_rules: [] })
    expect((await call('POST', `/outcome-proposals/${first}/approve`, { as: ALICE })).status).toBe(200)
    const { outcome_proposal_id: id } = await propose({ ...GOOD, outcome: 'again, a contact form', standing_rules: [] })
    const held = await call('POST', `/outcome-proposals/${id}/approve`, { as: ALICE })
    expect(held.status).toBe(409)
    expect(held.json.code).toBe('duplicate')
    expect(held.json.duplicate.id).toBe(cards()[0].id)
    expect(cards()).toHaveLength(1)
    expect((await call('GET', `/outcome-proposals/${id}`, { as: ALICE })).json.status).toBe('pending')
    const anyway = await call('POST', `/outcome-proposals/${id}/approve`, { as: ALICE, body: { file_anyway: true } })
    expect(anyway.status).toBe(200)
    expect(cards()).toHaveLength(2)
  })

  it('discard files nothing and cannot be approved afterwards', async () => {
    const { outcome_proposal_id: id } = await propose()
    expect((await call('POST', `/outcome-proposals/${id}/discard`, { as: ALICE })).json.status).toBe('discarded')
    expect((await call('POST', `/outcome-proposals/${id}/approve`, { as: ALICE })).status).toBe(409)
    expect(cards()).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM outcome_rules').get()).toEqual({ n: 0 })
  })
})

describe('standing rules are a workspace preference, not a skill file', () => {
  it('a saved rule is frozen into later cards unless the person skips it for this proposal', async () => {
    const saved = await call('POST', '/outcome-rules', { as: ALICE, body: { workspace: WS, text: 'Before-and-after screenshots on every PR' } })
    expect(saved.status).toBe(201)
    const ruleId = saved.json.rule.id
    const { outcome_proposal_id: a } = await propose({ ...GOOD, standing_rules: [] })
    const view = await call('GET', `/outcome-proposals/${a}`, { as: ALICE })
    expect(view.json.rules.map((r: Loose) => r.id)).toEqual([ruleId])
    await call('POST', `/outcome-proposals/${a}/approve`, { as: ALICE })
    const first = cards()[0]
    expect(JSON.parse(first.acceptance_criteria).map((c: Loose) => c.id)).toContain(`rule-${ruleId}`)

    const { outcome_proposal_id: b } = await propose({ ...GOOD, title: 'Newsletter signup on the website', standing_rules: [] })
    const pb = (await call('GET', `/outcome-proposals/${b}`, { as: ALICE })).json.proposal
    await call('POST', `/outcome-proposals/${b}/approve`, { as: ALICE, body: { proposal: { ...pb, skip_rule_ids: [ruleId] } } })
    const second = cards()[1]
    expect(JSON.parse(second.acceptance_criteria).map((c: Loose) => c.id)).not.toContain(`rule-${ruleId}`)
  })

  it('a bot cannot forge a rule criterion, and only an admin or the author removes a rule', async () => {
    const { outcome_proposal_id: id } = await propose({ ...GOOD, standing_rules: [], criteria: [{ id: 'rule-99', criterion: 'pretend rule' }] })
    const p = (await call('GET', `/outcome-proposals/${id}`, { as: ALICE })).json.proposal
    expect(p.card.criteria[0].id).not.toMatch(/^rule-/)

    const saved = await call('POST', '/outcome-rules', { as: ALICE, body: { workspace: WS, text: 'Screenshots on every PR', applies_to: 'pr' } })
    const ruleId = saved.json.rule.id
    expect((await call('POST', '/outcome-rules', { as: ALICE, bearer: true, body: { workspace: WS, text: 'x' } })).status).toBe(403)
    expect((await call('DELETE', `/outcome-rules/${ruleId}`, { as: BOB })).status).toBe(403)
    expect((await call('GET', `/outcome-rules?workspace=${WS}`, { as: BOB })).json.rules).toHaveLength(1)
    const removed = await call('DELETE', `/outcome-rules/${ruleId}`, { as: ADMIN })
    expect(removed.status).toBe(200)
    expect(removed.json.rules).toHaveLength(0)
  })
})
