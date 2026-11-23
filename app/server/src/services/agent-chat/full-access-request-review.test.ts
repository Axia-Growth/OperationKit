// obj 901457 — a Full access bot asks for an AI review of its OWN card.
//
// Through the real chat tool (`card_request_review`), the real ownership rule
// (cardOwnerBot), the real review service (requestAiReview, the one the
// operator's /api/internal/ai-review/request route uses) and a temp SQLite DB.
// Only the reviewer spawn is a stub. Proves:
//   - the tool starts a review on the bot's own card (status → ai_review, round
//     bumped, reviewer session recorded, one audit row + one feed line);
//   - it refuses another bot's card, an unowned card and a protected card, and
//     starts nothing;
//   - it stops at the review bounce cap (AI_REVIEW_ITERATION_CAP);
//   - a card that already has a verdict or no PR is refused by the service.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-fa-request-review-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-fa-request-review-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fa-request-review-kb-'))
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fa-request-review-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
fs.mkdirSync(path.join(TMP_AGENTS, 'dev'), { recursive: true })
fs.writeFileSync(path.join(TMP_AGENTS, 'dev', 'agent.yaml'), 'name: Operation Kit Dev\ndescription: Builds things\ntools: [web_search]\nknowledge_folders: [shared]\nsystem_prompt: You help.\n')

const { initDb, getDb } = await import('../../db/index.js')
const { runChatTool, toolSpecsForContext, ToolUseError } = await import('./tools.js')
const { grantBotWorkspace } = await import('./bot-workspaces.js')
const { setFullAccess, listFullAccessAudit } = await import('./bot-full-access.js')
const { requestAiReview } = await import('../ai-review-backfill.js')
const { AI_REVIEW_ITERATION_CAP } = await import('../poller-decisions.js')
const { SELF_ACTION_TOOLS } = await import('./card-wake-routing.js')
const { createWorkspace } = await import('../workspaces.js')
type Agent = import('./agent-defs.js').ChatAgent
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const GROWTH = 'growth'
const NOW = new Date('2026-11-18T12:00:00Z')

function bot(): Agent {
  return {
    slug: 'dev', name: 'Operation Kit Dev', description: 'Builds things', avatar: '', colour: 'blue', system_prompt: 'You help.',
    knowledge_folders: ['shared'], tools: ['web_search'], model: null, provider: null, schedules: [], version: null, author: null,
    how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
  }
}

/** Reviewer spawns the stub host made. Everything else is the real service. */
const spawned: number[] = []
const host = {
  async startCard() { return { ok: true } },
  async messageCard() { return { ok: true } },
  requestReview: (id: number, opts: { requestedBy: string; maxIteration: number }) =>
    requestAiReview(getDb(), id, { spawnReviewer: async o => { spawned.push(o.id); return `reviewer-${o.id}-${spawned.length}` } }, opts),
}

function ctx() {
  return { userId: ADMIN, username: 'jordan', workspace: GROWTH, agent: bot(), kbRoot: TMP_KB, connectors: { mail: null, calendar: null }, now: () => NOW, fullAccessHost: host }
}

/** A card in review with an open PR and no verdict — the stranded shape. */
function card(extra: { agent?: string; owner_bot?: string | null; pr?: number | null; iteration?: number; verdict?: string | null; status?: string } = {}): number {
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, agent_context, owner_bot, project, pr_number, pr_url, ai_review_iteration, ai_review_verdict, updated_at)
     VALUES (?, 'brief', ?, ?, 'task', 'general', ?, ?, ?, ?, 'operationkit', ?, ?, ?, ?, datetime('now'))`,
  ).run(
    `card ${Math.random()}`, GROWTH, extra.status ?? 'review', ADMIN, ADMIN, extra.agent ?? 'dev',
    extra.owner_bot === undefined ? 'Operation Kit Dev' : extra.owner_bot,
    extra.pr === undefined ? 900 : extra.pr,
    extra.pr === null ? null : `https://github.com/acme/infra/pull/${extra.pr ?? 900}`,
    extra.iteration ?? 0, extra.verdict ?? null,
  ).lastInsertRowid)
}

const row = (id: number) => getDb().prepare('SELECT status, ai_review_iteration, ai_review_session_id, ai_review_verdict FROM objectives WHERE id = ?').get(id) as Loose
const audit = () => listFullAccessAudit('dev', { limit: 200 }).filter(r => r.ability === 'card_request_review')

async function refused(id: number, pattern: RegExp) {
  const before = row(id)
  let err: unknown
  try { await runChatTool(ctx(), 'card_request_review', { id }) } catch (e) { err = e }
  expect(err, 'expected the tool to refuse').toBeInstanceOf(ToolUseError)
  expect((err as Error).message).toMatch(pattern)
  expect(row(id)).toEqual(before) // the card is left exactly as it was
  expect(spawned).toEqual([]) // no reviewer was started
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'jordan', 'x', 'admin')`).run(ADMIN)
  createWorkspace({ slug: GROWTH, name: 'Growth', default_agent_pool: ['general'] })
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  for (const t of ['agent_chat_bot_access', 'agent_chat_bot_workspaces', 'agent_chat_bot_full_access', 'agent_chat_bot_full_access_audit', 'objectives']) db.prepare(`DELETE FROM ${t}`).run()
  spawned.length = 0
  grantBotWorkspace('dev', GROWTH, 'jordan')
  setFullAccess('dev', GROWTH, { enabled: true }, { id: ADMIN, username: 'jordan' }, NOW)
})

describe('card_request_review (obj 901457)', () => {
  it('is a Full access tool, offered while Full access is on, and bracketed as a self action', () => {
    expect(toolSpecsForContext(ctx()).map(s => s.function.name)).toContain('card_request_review')
    expect(SELF_ACTION_TOOLS.has('card_request_review')).toBe(true)
  })

  it('starts a review on the bot\'s own card through the shared review service, and logs it', async () => {
    const id = card()
    const r = await runChatTool(ctx(), 'card_request_review', { id, note: 'review never ran' })
    expect(r.result).toMatchObject({ id, status: 'ai_review', review_round: 1, review_cap: AI_REVIEW_ITERATION_CAP })
    expect(spawned).toEqual([id])
    expect(row(id)).toEqual({ status: 'ai_review', ai_review_iteration: 1, ai_review_session_id: `reviewer-${id}-1`, ai_review_verdict: null })
    const used = audit().filter(a => a.event === 'ability_used')
    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({ objective_id: id, workspace: GROWTH, actor: 'bot:dev' })
    expect(used[0].detail).toMatch(/asked for an AI review of card #\d+ \(round 1 of 2\) — review never ran/)
    // The service's own milestone names the bot as the requester.
    const m = getDb().prepare("SELECT metadata FROM activity_log WHERE objective_id = ? AND title = 'ai_review_requested'").get(id) as Loose
    expect(JSON.parse(m.metadata)).toMatchObject({ kind: 'ai_review_requested', requested_by: 'bot:dev', iteration: 1 })
  })

  it('also counts a card the bot works under its slug with no owner_bot as its own', async () => {
    const id = card({ owner_bot: null, agent: 'dev' })
    await runChatTool(ctx(), 'card_request_review', { id })
    expect(row(id).status).toBe('ai_review')
  })

  it('refuses another bot\'s card and an unowned card, and logs the refusal', async () => {
    const other = card({ owner_bot: 'Grok: CTO', agent: 'dev' }) // owner_bot wins over agent_context
    await refused(other, /is not Operation Kit Dev's card/)
    const unowned = card({ owner_bot: null, agent: 'general' })
    await refused(unowned, /is not Operation Kit Dev's card/)
    const rows = audit().filter(a => a.event === 'ability_refused')
    expect(rows.map(a => a.objective_id).sort()).toEqual([other, unowned].sort())
    expect(rows[0].detail).toBe('card is not owned by this bot')
  })

  it('refuses a protected card (PR 645) before anything else', async () => {
    const id = card({ pr: 645 })
    await refused(id, /carries pull request 645, which is protected/)
    expect(listFullAccessAudit('dev', { limit: 50 }).filter(a => a.event === 'protected_refused')).toHaveLength(1)
  })

  it('stops at the review cap', async () => {
    expect(AI_REVIEW_ITERATION_CAP).toBe(2)
    const id = card({ iteration: 1 })
    const r = await runChatTool(ctx(), 'card_request_review', { id })
    expect(r.result).toMatchObject({ review_round: 2 })
    // Back in review with no verdict at the cap: a third round is not the bot's to buy.
    getDb().prepare("UPDATE objectives SET status = 'review' WHERE id = ?").run(id)
    spawned.length = 0
    await refused(id, /has used its 2 AI review rounds/)
    expect(audit().filter(a => a.event === 'ability_refused')[0].detail).toBe('review cap reached (2/2)')
  })

  it('the service itself enforces the cap it is given, and the operator route (no cap) is unchanged', async () => {
    const id = card({ iteration: 2 })
    const spawn = async () => 'x'
    expect(await requestAiReview(getDb(), id, { spawnReviewer: spawn }, { maxIteration: 2 })).toMatchObject({ ok: false, code: 'iteration_cap' })
    expect(await requestAiReview(getDb(), id, { spawnReviewer: spawn }, { dryRun: true })).toMatchObject({ ok: true, iteration: 3 })
  })

  it('refuses a card that already has a verdict, has no PR, or is not in review', async () => {
    await refused(card({ verdict: 'fail' }), /already has a review verdict \(fail\)/)
    await refused(card({ pr: null }), /has no pull request linked/)
    await refused(card({ status: 'working' }), /it is working, not in review/)
  })
})
