/**
 * obj 901381 — a card that ends its session with a linked PR is routed to AI
 * review, whatever its origin.
 *
 * The bug: six Operation Kit Dev cards (#901371-#901378) were filed with
 * `create_pr = 0` and no acceptance criteria — five by the chat
 * `create_objective` tool, one by the internal create route — and their sessions
 * opened PRs. At session end poller-loop.ts classified them with
 * `createPr: !!objective.create_pr` as the only PR signal, so merge-lane.ts
 * returned `green` and resolveWorkerEndStatus sent green to `review`: no
 * reviewer, `ai_review_verdict` NULL forever.
 *
 * These tests create the card through the REAL creation paths (the chat tool's
 * `runTool(..., 'create_objective')`, and the real express route for
 * `POST /api/internal/objectives`), link a PR the way the session-end autolink
 * does (pr_number + pr_url on the row), then ask the routing function the poller
 * calls (`decideWorkerEndRoute`) where the card goes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

process.env.JWT_SECRET = 'test-secret-901381-xxxxxxxxxxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-linked-pr-review-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-linked-pr-kb-'))

// The route module graph reaches the spawn stack; no PTY is ever opened here.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

const { initDb, getDb } = await import('../db/index.js')
const { runTool } = await import('./agent-chat/tools.js')
const { seedExistingBotsOnce } = await import('./agent-chat/bot-workspaces.js')
const { default: internalRouter } = await import('../routes/internal.js')
const { decideWorkerEndRoute, resolveWorkerEndStatus } = await import('./poller-decisions.js')
const { isRedLaneText } = await import('./merge-lane.js')
type Agent = import('./agent-chat/agent-defs.js').ChatAgent
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const ALICE = 2
const WS = 'operationkit-test'

const dev: Agent = {
  slug: 'operation-kit-dev',
  name: 'Operation Kit Dev',
  description: '',
  avatar: '',
  colour: 'blue',
  system_prompt: 'You file dev work.',
  knowledge_folders: [],
  tools: ['create_objective', 'get_objective', 'list_objectives'],
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

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice', 'x', 'member')`).run(ALICE)
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(WS, WS)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(ALICE, WS)
  seedExistingBotsOnce(['operation-kit-dev'])

  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address()
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      resolve()
    })
  })
})

afterAll(() => {
  try { server?.close() } catch { /* ignore */ }
  try { getDb().close() } catch { /* ignore */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

const row = (id: number) => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Loose

/** What the session-end autolink (relinkPrFromTranscript / discoverAndBackfillPR) leaves on the row. */
function endSessionWithLinkedPr(id: number, prNumber: number) {
  getDb()
    .prepare(`UPDATE objectives SET status = 'working', session_id = ?, pr_number = ?, pr_url = ?, branch_name = ? WHERE id = ?`)
    .run(`sess-${id}`, prNumber, `https://github.com/your-org/operationkit/pull/${prNumber}`, `cc/obj-${id}-x`, id)
}

/** The poller's call at session end (poller-loop.ts), with the inputs it has for a create_pr = 0 card. */
function routeAtSessionEnd(id: number) {
  const o = row(id)
  return decideWorkerEndRoute(o, {
    redPath: isRedLaneText(o),
    // create_pr = 0 → the poller does not resolve the file list (poller-loop.ts `if (objective.create_pr)`).
    filesKnown: false,
    uiTouched: false,
    hasDelegatorParent: false,
    producedNothing: false,
  })
}

function chatCreate(title: string): number {
  const ctx = { userId: ALICE, username: 'alice', workspace: WS, agent: dev, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } }
  const r = runTool(ctx as Loose, 'create_objective', { title, description: 'Fix the thing in operationkit and open a PR.' }).result as Loose
  return r.id as number
}

async function internalCreate(title: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ title, description: 'Fix the thing and open a PR.', workspace: WS, project: 'operationkit', type: 'task' }]),
  })
  const json = (await res.json()) as Loose
  expect(res.status).toBe(201)
  return json.objectives[0].id as number
}

describe('chat create_objective card (origin agent_chat, no criteria) that ends with a linked PR', () => {
  it('is created exactly like the stranded cards: origin agent_chat, create_pr 0, no acceptance criteria', () => {
    const id = chatCreate('901381 chat card shape')
    expect(row(id)).toMatchObject({ origin: 'agent_chat', create_pr: 0, acceptance_criteria: null, ai_review_verdict: null })
  })

  it('is routed to ai_review (was `review` with no reviewer before obj 901381)', () => {
    const id = chatCreate('901381 chat card with PR')
    endSessionWithLinkedPr(id, 881)
    const route = routeAtSessionEnd(id)
    expect(route.prLinked).toBe(true)
    expect(route.lane).toBe('yellow')
    expect(route.status).toBe('ai_review')
  })

  it('the SAME card without a PR keeps its old routing (human review, green lane)', () => {
    const id = chatCreate('901381 plain card, nothing linked') // not a near-twin of the card above (obj 901498)
    getDb().prepare(`UPDATE objectives SET status = 'working', session_id = 'sess-nopr' WHERE id = ?`).run(id)
    const route = routeAtSessionEnd(id)
    expect(route.prLinked).toBe(false)
    expect(route.lane).toBe('green')
    expect(route.status).toBe('review')
  })

  it('a pr_url alone (no pr_number) also counts as a linked PR', () => {
    const id = chatCreate('901381 chat card url only')
    getDb().prepare(`UPDATE objectives SET status = 'working', pr_url = 'https://github.com/your-org/operationkit/pull/882' WHERE id = ?`).run(id)
    expect(routeAtSessionEnd(id).status).toBe('ai_review')
  })

  it('skip_ai_review is still the operator opt-out', () => {
    const id = chatCreate('901381 chat card skip')
    endSessionWithLinkedPr(id, 883)
    getDb().prepare('UPDATE objectives SET skip_ai_review = 1 WHERE id = ?').run(id)
    expect(routeAtSessionEnd(id).status).toBe('review')
  })

  it('a routine card with a PR keeps the routine routing (never strands a recurring job in review)', () => {
    const id = chatCreate('901381 routine card')
    endSessionWithLinkedPr(id, 884)
    getDb().prepare('UPDATE objectives SET routine_id = 4242 WHERE id = ?').run(id)
    const route = routeAtSessionEnd(id)
    expect(route.prLinked).toBe(false)
    expect(route.status).toBe('done')
  })
})

describe('internal create route card (no create_pr, no criteria) that ends with a linked PR', () => {
  it('is stored with create_pr 0 and no acceptance criteria', async () => {
    const id = await internalCreate('901381 internal card shape')
    expect(row(id)).toMatchObject({ create_pr: 0, acceptance_criteria: null, ai_review_verdict: null })
  })

  it('is routed to ai_review', async () => {
    const id = await internalCreate('901381 internal card with PR')
    endSessionWithLinkedPr(id, 885)
    const route = routeAtSessionEnd(id)
    expect(route.lane).toBe('yellow')
    expect(route.status).toBe('ai_review')
  })

  it('without a PR it still lands in human review', async () => {
    const id = await internalCreate('901381 internal card no PR')
    getDb().prepare(`UPDATE objectives SET status = 'working' WHERE id = ?`).run(id)
    expect(routeAtSessionEnd(id).status).toBe('review')
  })
})

describe('the cause, reproduced with the pre-901381 call (create_pr as the only PR signal)', () => {
  it('main\'s poller-loop.ts inline routing sends a chat card WITH a linked PR to review: green lane, no reviewer', async () => {
    const { classifyMergeLane } = await import('./merge-lane.js')
    const id = chatCreate('901381 chat card old routing')
    endSessionWithLinkedPr(id, 881)
    const o = row(id)
    expect(o.pr_number).toBe(881)
    // Exactly the arguments poller-loop.ts built before this change.
    const lane = classifyMergeLane({ type: o.type, createPr: !!o.create_pr, delegateMode: !!o.delegate_mode, redPath: isRedLaneText(o), filesKnown: false, uiTouched: false })
    expect(lane).toBe('green')
    const status = resolveWorkerEndStatus({ type: o.type, delegateMode: !!o.delegate_mode, createPr: !!o.create_pr, skipAi: !!o.skip_ai_review, hasDelegatorParent: false, isRoutine: o.routine_id != null, lane, producedNothing: false })
    expect(status).toBe('review')
  })
})

describe('the routing table itself', () => {
  it('omitting hasLinkedPr is the pre-901381 table (create_pr=0 task, no lane → review)', () => {
    expect(resolveWorkerEndStatus({ type: 'task', delegateMode: false, createPr: false, skipAi: false, hasDelegatorParent: false })).toBe('review')
    expect(resolveWorkerEndStatus({ type: 'task', delegateMode: false, createPr: false, skipAi: false, hasDelegatorParent: false, hasLinkedPr: true })).toBe('ai_review')
  })

  it('a create_pr card is unchanged: backend-only known files stay green', () => {
    const o = { type: 'task', create_pr: 1, delegate_mode: 0, pr_number: 9, pr_url: 'https://github.com/a/b/pull/9', routine_id: null } as Loose
    expect(decideWorkerEndRoute(o, { redPath: false, filesKnown: true, uiTouched: false, hasDelegatorParent: false })).toMatchObject({ lane: 'green', status: 'review' })
    expect(decideWorkerEndRoute(o, { redPath: false, filesKnown: false, uiTouched: false, hasDelegatorParent: false })).toMatchObject({ lane: 'yellow', status: 'ai_review' })
  })

  it('the poller really uses decideWorkerEndRoute for the session-end routing', () => {
    const src = fs.readFileSync(new URL('./poller-loop.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/const route = decideWorkerEndRoute\(/)
    expect(src).toMatch(/resolvedStatus = route\.status/)
  })
})

describe('missing acceptance criteria do not skip the review', () => {
  it('the reviewer prompt for a card with no criteria generates the rubric from the description / completion goal (Step 0)', async () => {
    const { buildReviewerPrompt } = await import('./session-reviewer-prompt.js')
    const id = chatCreate('901381 chat card rubric')
    endSessionWithLinkedPr(id, 886)
    const o = { ...row(id), ai_review_iteration: 1 }
    const prompt = String(buildReviewerPrompt(o, [], null))
    expect(prompt).toContain('Step 0 — Generate and lock the acceptance criteria')
  })
})
