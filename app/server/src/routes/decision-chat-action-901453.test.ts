/**
 * obj 901453 — a decision answer for a deploy / merge reaches the bot chat.
 *
 * Card #901383: the owner answered decision #44 ("When should Dev deploy?")
 * with "Deploy the four now". Operation Kit Dev raised it from chat, but the
 * answer restarted the CARD session, which has no deploy tool, so nothing
 * deployed. Through the real chat tool entry point, the real decide route and a
 * real temp DB:
 *   1. raise_decision refuses an option that promises the click will deploy;
 *   2. the owner's answer on a chat-raised deploy option lands in the bot's chat
 *      as "Type deploy here to run it.", the card is NOT restarted, and nothing
 *      deploys (no host call, no dev_ops_audit row);
 *   3. a worker's deploy decision keeps the old card path;
 *   4. an API / bearer answer is refused and posts nothing;
 *   5. a card wake and a bot-to-bot wake still cannot call dev_deploy, and a
 *      non-browser turn cannot either (devOpsGate unchanged).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-decision-901453-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-901453'
process.env.TRANSCRIPT_DIR = TMP
process.env.DOC_INGEST_KB_DIR = path.join(TMP, 'kbroot')
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-decision-901453-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-decision-901453-kb-'))

vi.mock('node-pty', () => ({ spawn: vi.fn(), default: { spawn: vi.fn() } }))

const sendFollowUp = vi.hoisted(() => vi.fn((sid: string) => sid))
vi.mock('../services/session-manager.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/session-manager.js')>()),
  sendFollowUp,
  getSessionState: () => 'review',
  stopSession: vi.fn(async () => {}),
}))
vi.mock('../services/session-control.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/session-control.js')>()),
  getSessionState: () => 'review',
}))
// Any deploy that starts would go through here; it must never be called.
const startDevDeploy = vi.hoisted(() => vi.fn(() => { throw new Error('a deploy must never start in these tests') }))
vi.mock('../services/dev-ops/deploy.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/dev-ops/deploy.js')>()),
  startDevDeploy,
}))

const { getDb, initDb } = await import('../db/index.js')
const { default: decisionsRouter } = await import('./decisions.js')
const { raiseDecision, getDecision } = await import('../services/decisions.js')
const { runChatTool, toolSpecsForContext } = await import('../services/agent-chat/tools.js')
const { seedExistingBotsOnce } = await import('../services/agent-chat/bot-workspaces.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { clearInstalledChatBotCache } = await import('../services/bots/card-owner.js')
const { DEV_OPS_BOT_SLUG } = await import('../services/dev-ops/switch.js')
const { setHostRunnerForTests } = await import('../services/dev-ops/host-exec.js')
const { DEV_OPS_FNS } = await import('../services/agent-chat/dev-ops-tools.js')
const { chatOnlyActionFor } = await import('../services/decision-apply.js')

type Agent = import('../services/agent-chat/agent-defs.js').ChatAgent
type Ctx = import('../services/agent-chat/tools.js').ToolContext
type Loose = any

const WS = 'operationkit'
const OWNER = 1
let server: http.Server
let base: string
let adminCookie: string
let bearer: string
const hostCalls: unknown[] = []

const DEV: Agent = {
  slug: DEV_OPS_BOT_SLUG, name: 'Operation Kit Dev', description: '', avatar: '', colour: 'blue', system_prompt: 'You help.',
  knowledge_folders: [], tools: ['get_objective', 'list_objectives', 'create_objective'], model: null, provider: null, schedules: [],
  version: null, author: null, how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
} as Agent

function ctx(extra: Partial<Ctx> = {}): Ctx {
  return { userId: OWNER, username: 'operator', workspace: WS, agent: DEV, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } as Loose, browserSession: true, ...extra }
}

const deployOptions = (aNext: string) => [
  { label: 'Deploy the four now', pros: ['Fixes go live today'], cons: ['Brief reconnect'], next: aNext },
  { label: 'Wait until Monday', pros: ['Quiet weekend'], cons: ['Fixes wait'], next: 'I hold; nothing is deployed until you say so.' },
]
const brief = (aNext: string) => ({
  context: 'Four PRs are merged to main and CI is green. A deploy puts them live.',
  question: 'When should Dev deploy?',
  options: deployOptions(aNext),
  recommended: 'A',
  recommended_why: 'All four are green and small.',
})

function card(status = 'review'): number {
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id) VALUES ('Deploy the four', ?, ?, ?, ?, 'cc-sess-1')`,
  ).run(DEV_OPS_BOT_SLUG, WS, OWNER, status).lastInsertRowid)
}

async function decide(id: number, body: unknown, auth: { cookie?: string; bearer?: string }) {
  const res = await fetch(`${base}/api/decisions/${id}/decide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth.cookie ? { Cookie: auth.cookie } : {}),
      ...(auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Loose }
}

const chatRows = (decisionId: number) =>
  (getDb().prepare("SELECT user_id, agent_slug, role, content, meta FROM agent_chat_messages WHERE meta LIKE ?").all(`%"decision_id":${decisionId}%`) as Loose[])
const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const deployAuditRows = () => (getDb().prepare("SELECT * FROM dev_ops_audit WHERE action = 'dev_deploy' AND outcome != 'refused'").all() as Loose[])
const settle = () => new Promise(r => setTimeout(r, 30))

beforeAll(async () => {
  fs.mkdirSync(path.join(TMP_AGENTS, DEV_OPS_BOT_SLUG), { recursive: true })
  fs.writeFileSync(
    path.join(TMP_AGENTS, DEV_OPS_BOT_SLUG, 'agent.yaml'),
    'name: Operation Kit Dev\nsystem_prompt: You are Dev.\nknowledge_folders: []\ntools: [get_objective, list_objectives, create_objective]\nversion: 1.0.0\nauthor: Test\n',
  )
  clearInstalledChatBotCache()
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(OWNER)
  createWorkspace({ slug: WS, name: 'Operation Kit', default_agent_pool: ['general'] })
  seedExistingBotsOnce([DEV_OPS_BOT_SLUG])
  setHostRunnerForTests(async (image: string, args: string[]) => {
    hostCalls.push({ image, args })
    return { code: 0, stdout: '{"ok":true}', stderr: '' }
  })
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/decisions', decisionsRouter)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  bearer = jwt.sign({ id: OWNER, username: 'operator', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  adminCookie = `token=${bearer}`
})

afterAll(async () => {
  setHostRunnerForTests(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('raising from chat: no option may promise a click-deploy', () => {
  it('raise_decision refuses "I deploy the four" and names the fix', async () => {
    const id = card()
    await expect(runChatTool(ctx(), 'raise_decision', { card_id: id, ...brief('I deploy the four and report health.') }))
      .rejects.toThrow(/option A .* promises a deploy, but answering a decision cannot run one.*You type deploy in this chat and I run it/)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM decisions WHERE objective_id = ?').get(id)).toEqual({ n: 0 })
  })

  it('the same option worded "you type deploy in this chat" is raised', async () => {
    const id = card()
    const out = await runChatTool(ctx(), 'raise_decision', { card_id: id, ...brief('You type deploy in this chat and I run it.') })
    expect((out.result as Loose).decision_id).toBeGreaterThan(0)
  })
})

describe('the owner answers a chat-raised deploy decision', () => {
  it('the answer reaches the bot chat, the card is not restarted, and nothing deploys', async () => {
    const id = card('review')
    const out = await runChatTool(ctx(), 'raise_decision', { card_id: id, ...brief('You type deploy in this chat and I run it.') })
    const decisionId = (out.result as Loose).decision_id as number
    sendFollowUp.mockClear()

    const r = await decide(decisionId, { choice: 'A' }, { cookie: adminCookie })
    await settle()
    expect(r.status).toBe(200)
    expect(r.json.outcome).toBe('to_chat')
    expect(r.json.outcome_text).toMatch(/Type deploy in Operation Kit Dev's chat to run it\. Nothing has run yet\./)

    const rows = chatRows(decisionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: OWNER, agent_slug: DEV_OPS_BOT_SLUG, role: 'assistant' })
    expect(rows[0].content).toMatch(/^You chose Deploy \(A: Deploy the four now\) on decision #\d+, card #\d+\. Type deploy here to run it\./)
    expect(JSON.parse(rows[0].meta)).toMatchObject({ kind: 'decision_chat_action', action: 'deploy', decision_id: decisionId, objective_id: id })

    // The card stays where it was: no restart of a session that has no deploy tool.
    expect(sendFollowUp).not.toHaveBeenCalled()
    expect(statusOf(id)).toBe('review')
    // Never handed to a later card session either.
    expect(getDecision(getDb(), decisionId)?.delivered_to ?? null).toBeNull()
    // The click ran nothing.
    expect(startDevDeploy).not.toHaveBeenCalled()
    expect(hostCalls).toHaveLength(0)
    expect(deployAuditRows()).toHaveLength(0)
  })

  it('picking the wait option takes the ordinary card path', async () => {
    const id = card('review')
    const out = await runChatTool(ctx(), 'raise_decision', { card_id: id, ...brief('You type deploy in this chat and I run it.') })
    const decisionId = (out.result as Loose).decision_id as number
    sendFollowUp.mockClear()
    const r = await decide(decisionId, { choice: 'B' }, { cookie: adminCookie })
    await settle()
    expect(r.json.outcome).toBe('sent')
    expect(chatRows(decisionId).filter(m => JSON.parse(m.meta).kind === 'decision_chat_action')).toHaveLength(0)
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
  })

  it("a WORKER's deploy decision (not raised from chat) keeps the card path", async () => {
    const id = card('review')
    const raised = raiseDecision(getDb(), { objective_id: id, workspace: WS, source: 'worker', agent_slug: DEV_OPS_BOT_SLUG, briefing: brief('I deploy the four.') })
    if (!raised.ok) throw new Error(raised.errors.join('; '))
    expect(chatOnlyActionFor({ ...raised.decision, chosen: 'A' })).toBeNull()
    sendFollowUp.mockClear()
    const r = await decide(raised.decision.id, { choice: 'A' }, { cookie: adminCookie })
    await settle()
    expect(r.json.outcome).toBe('sent')
    expect(chatRows(raised.decision.id)).toHaveLength(0)
    expect(startDevDeploy).not.toHaveBeenCalled()
  })

  it('an API / bearer answer is refused and posts nothing to the chat', async () => {
    const id = card('review')
    const out = await runChatTool(ctx(), 'raise_decision', { card_id: id, ...brief('You type deploy in this chat and I run it.') })
    const decisionId = (out.result as Loose).decision_id as number
    const r = await decide(decisionId, { choice: 'A' }, { bearer })
    expect(r.status).toBe(403)
    expect(chatRows(decisionId)).toHaveLength(0)
    expect(getDecision(getDb(), decisionId)?.state).toBe('open')
    expect(startDevDeploy).not.toHaveBeenCalled()
    expect(hostCalls).toHaveLength(0)
  })
})

describe('devOpsGate is unchanged: only a live browser chat turn can deploy', () => {
  const wake = { wakeId: 1, objectiveId: 1, workspace: WS, toolScope: 'chat' as const }

  it('a card wake is not offered dev_deploy and is refused when it calls it', async () => {
    const c = ctx({ cardWake: wake as Loose })
    expect(toolSpecsForContext(c).map(s => s.function.name).filter(n => DEV_OPS_FNS.has(n))).toEqual([])
    const out = await runChatTool(c, 'dev_deploy', { reason: 'decision said deploy' }).catch(e => ({ result: { ok: false, error: (e as Error).message } }))
    expect((out.result as Loose).ok).toBe(false)
    expect(startDevDeploy).not.toHaveBeenCalled()
  })

  it('a bot-to-bot wake and a non-browser (API / relayed) turn are refused', async () => {
    for (const c of [ctx({ botWake: { conversationId: 1, depth: 1 } }), ctx({ browserSession: false })]) {
      expect(toolSpecsForContext(c).map(s => s.function.name)).not.toContain('dev_deploy')
      const out = await runChatTool(c, 'dev_deploy', {}).catch(e => ({ result: { ok: false, error: (e as Error).message } }))
      expect((out.result as Loose).ok).toBe(false)
    }
    expect(startDevDeploy).not.toHaveBeenCalled()
    expect(hostCalls).toHaveLength(0)
  })

  it('a live browser chat turn by the admin IS offered dev_deploy (the place the answer points to)', () => {
    expect(toolSpecsForContext(ctx()).map(s => s.function.name)).toContain('dev_deploy')
  })
})
