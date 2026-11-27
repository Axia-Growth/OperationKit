// obj 901195 — jailed card sessions and the /api/internal front door.
//
// Since obj 901027 the gate answered 403 to EVERY sandbox-CIDR peer without
// X-Internal-Secret / the objectives token, so a jailed card could not save its
// NOTES/ARTIFACT, post progress, record a job disposition or file child cards —
// all routes its own prompt tells it to call with its CC_SESSION_TOKEN.
//
// These tests mount the REAL gate and the REAL internal routers exactly as
// index.ts does, and fake the socket peer (x-test-peer) so a request looks like
// it came from the jail network. One test per acceptance criterion:
//   1. own card + allow-listed route            → allowed
//   2. same routes for ANOTHER card              → 403
//   3. a jailed REVIEWER: GET/POST /reviews/N/criteria for its own card only
//   4. any non-allow-listed internal route       → 403 (token or not)
//   5. no / bad / expired / ended-card token     → 403, same message as before
//   6. loopback + credentialled callers unchanged; REQUIRE_SECRET still bites
//   7. every internal call the prompts tell a card to make is allow-listed
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import express from 'express'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gate-card-session-'))
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-gate-card-session-901195'
process.env.INTERNAL_API_SECRET = 'test-internal-secret-901195'
process.env.TRANSCRIPT_DIR = TMP
process.env.OBJECTIVE_MEMORY_ROOT = path.join(TMP, 'memory')
process.env.INTERNAL_TRUSTED_PEER_CIDRS = '172.30.250.0/24'
delete process.env.INTERNAL_API_REQUIRE_SECRET
delete process.env.CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL

const { initDb, getDb } = await import('../db/index.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { internalApiGate, SANDBOX_PEER_REFUSAL } = await import('./internal-api-gate.js')
const { default: internalRouter } = await import('../routes/internal.js')
const { default: internalSupervisorRouter } = await import('../routes/internal-supervisor.js')
const { internalReviewsRouter } = await import('../routes/reviews.js')
const { CARD_SESSION_ROUTES, internalSubPath, matchCardSessionRoute } = await import('../lib/card-session-scope.js')

const JAIL = '172.30.250.9'
let server: http.Server
let baseUrl: string
let card: number // the jailed card (a routine job, so job-disposition applies)
let other: number // another card, same workspace
let foreign: number // a card in another workspace
let done: number // a finished card
let token: string
let otherToken: string
let reviewed: number // a card in AI review (its reviewer holds reviewerToken)
let reviewedPeer: number // a different card in AI review
let reviewerToken: string

function insert(sql: string, ...args: unknown[]): number {
  return Number(getDb().prepare(sql).run(...args).lastInsertRowid)
}

async function call(
  method: string,
  p: string,
  opts: { body?: unknown; tok?: string | null; peer?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-test-peer': opts.peer ?? JAIL, ...(opts.headers ?? {}) }
  if (opts.tok) headers['X-CC-Session-Token'] = opts.tok
  const res = await fetch(`${baseUrl}/api/internal${p}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  initDb()
  const routine = insert(
    "INSERT INTO routines (name, cron_expr, objective_template, enabled) VALUES ('job-901195', '0 3 * * *', '{}', 0)",
  )
  card = insert("INSERT INTO objectives (title, workspace, status, routine_id) VALUES ('jailed card', 'ws-a', 'working', ?)", routine)
  other = insert("INSERT INTO objectives (title, workspace, status, routine_id) VALUES ('other card', 'ws-a', 'working', ?)", routine)
  foreign = insert("INSERT INTO objectives (title, workspace, status) VALUES ('foreign card', 'ws-b', 'working')")
  done = insert("INSERT INTO objectives (title, workspace, status) VALUES ('finished card', 'ws-a', 'done')")
  token = mintSessionToken({ objectiveId: card, workspace: 'ws-a', actingUserId: null })
  otherToken = mintSessionToken({ objectiveId: other, workspace: 'ws-a', actingUserId: null })
  // A card under AI review: the reviewer's token is minted for the card it reviews.
  reviewed = insert("INSERT INTO objectives (title, workspace, status) VALUES ('card under review', 'ws-a', 'review')")
  reviewedPeer = insert("INSERT INTO objectives (title, workspace, status) VALUES ('another card under review', 'ws-a', 'review')")
  reviewerToken = mintSessionToken({ objectiveId: reviewed, workspace: 'ws-a', actingUserId: null })

  const app = express()
  app.set('trust proxy', 'loopback, uniquelocal')
  app.use((req, _res, next) => {
    const peer = req.header('x-test-peer')
    if (peer) Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true })
    next()
  })
  app.use(express.json({ limit: '2mb' }))
  // Same order as index.ts.
  app.use('/api/internal', internalApiGate)
  app.use('/api/internal', internalRouter)
  app.use('/api/internal/supervisor', internalSupervisorRouter)
  app.use('/api/internal/reviews', internalReviewsRouter)
  // Sentinel: anything the gate lets through that no router answers. A 403 on
  // a sentinel-backed path therefore comes from the gate, never from a 404.
  app.all('/api/internal/*', (_req, res) => { res.status(200).json({ reached: true }) })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

afterEach(() => { delete process.env.INTERNAL_API_REQUIRE_SECRET })

describe('criterion 1 — a jailed card reaches its OWN card-scoped routes with its session token', () => {
  it('memory file write + read', async () => {
    const w = await call('PUT', `/objectives/${card}/memory/file`, { tok: token, body: { path: 'NOTES.md', content: 'hello from the jail\n' } })
    expect(w.status).toBe(200)
    expect(w.json.ok).toBe(true)
    const r = await call('GET', `/objectives/${card}/memory/file?path=NOTES.md`, { tok: token })
    expect(r.status).toBe(200)
    expect(r.json.content).toBe('hello from the jail\n')
  })

  it('progress post + read, artifacts list', async () => {
    const p = await call('POST', `/objectives/${card}/progress`, { tok: token, body: { step: 1, total_steps: 3, label: 'start' } })
    expect(p.status).toBe(201)
    expect((await call('GET', `/objectives/${card}/progress`, { tok: token })).status).toBe(200)
    expect((await call('GET', `/objectives/${card}/artifacts`, { tok: token })).status).toBe(200)
  })

  it('job-disposition (complete, and needs_review raising a decision on its own card)', async () => {
    const c = await call('POST', `/objectives/${card}/job-disposition`, { tok: token, body: { disposition: 'complete', note: 'ok' } })
    expect(c.status).toBe(200)
    expect(c.json.job_disposition).toBe('complete')
    const nr = await call('POST', `/objectives/${card}/job-disposition`, {
      tok: token,
      body: {
        disposition: 'needs_review',
        note: 'pick one',
        decision: {
          context: 'The batch is drafted. Sending is the last step.',
          question: 'Send it today?',
          options: [
            { key: 'A', label: 'Send', pros: ['fast'], cons: ['no review'], next: 'I send it.' },
            { key: 'B', label: 'Hold', pros: ['safer'], cons: ['slower'], next: 'I wait.' },
          ],
          recommended: 'A',
          recommended_why: 'It matches last month.',
        },
      },
    })
    expect(nr.status).toBe(200)
    expect(nr.json.decision_id).toBeTruthy()
  })

  it('creates child cards AS itself: parent pinned to the card, workspace pinned to its workspace', async () => {
    const r = await call('POST', '/objectives', { tok: token, body: [{ title: 'child of the jailed card 901195', description: 'x', type: 'task' }] })
    expect(r.status).toBe(201)
    const id = r.json.objectives[0].id
    const row = getDb().prepare('SELECT parent_id, workspace FROM objectives WHERE id = ?').get(id) as { parent_id: number; workspace: string }
    expect(row).toEqual({ parent_id: card, workspace: 'ws-a' })

    // A High Agency style project card links back by source_job_id instead.
    const s = await call('POST', '/objectives', { tok: token, body: [{ title: 'sourced card 901195', type: 'task', workspace: 'ws-a', source_job_id: card }] })
    expect(s.status).toBe(201)
    const srow = getDb().prepare('SELECT parent_id, source_job_id, workspace FROM objectives WHERE id = ?').get(s.json.objectives[0].id) as Record<string, unknown>
    expect(srow).toEqual({ parent_id: null, source_job_id: card, workspace: 'ws-a' })

    // ...and fans its child out under its own card.
    const f = await call('POST', `/objectives/${card}/fanout`, { tok: token, body: { child_ids: [id], max_concurrency: 1, start: false } })
    expect(f.status).toBe(201)
  })

  it('reports its own PR', async () => {
    const r = await call('POST', '/pr-created', { tok: token, body: { objective_id: card, branch_name: 'cc/obj-x', pr_url: 'https://github.com/o/r/pull/9' } })
    expect(r.status).toBe(200)
  })

  it('reads its OWN card row', async () => {
    const r = await call('GET', `/objectives/${card}`, { tok: token })
    expect(r.status).toBe(200)
    expect(r.json.id).toBe(card)
  })
})

describe('criterion 2 — the same token aimed at ANOTHER card is refused', () => {
  it.each([
    ['PUT', 'memory/file', { path: 'NOTES.md', content: 'x' }],
    ['GET', 'memory/file?path=NOTES.md', undefined],
    ['POST', 'progress', { step: 1, label: 'x' }],
    ['GET', 'progress', undefined],
    ['GET', 'artifacts', undefined],
    ['GET', 'artifacts/file?path=ARTIFACT.md', undefined],
    ['POST', 'job-disposition', { disposition: 'complete' }],
    ['POST', 'fanout', { child_ids: [], start: false }],
  ])('%s /objectives/<other>/%s → 403', async (method, sub, body) => {
    const r = await call(method, `/objectives/${other}/${sub}`, { tok: token, body })
    expect(r.status).toBe(403)
  })

  it('creating a card under another parent / source / workspace → 403', async () => {
    for (const item of [
      { title: 'x', parent_id: other },
      { title: 'x', source_job_id: other },
      { title: 'x', workspace: 'ws-b' },
    ]) {
      const r = await call('POST', '/objectives', { tok: token, body: [item] })
      expect(r.status, JSON.stringify(item)).toBe(403)
    }
  })

  it('reporting a PR for another card → 403', async () => {
    const r = await call('POST', '/pr-created', { tok: token, body: { objective_id: other, pr_url: 'https://github.com/o/r/pull/1' } })
    expect(r.status).toBe(403)
  })

  it('another card\'s row → 403 (same or other workspace)', async () => {
    for (const target of [other, foreign]) {
      const r = await call('GET', `/objectives/${target}`, { tok: token })
      expect(r.status, String(target)).toBe(403)
      expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
    }
  })
})

// Operator review of PR 847: no cross-card or board rule for a jailed session.
// Each of these routes is refused to a sandbox peer holding a VALID live token,
// whether :id is its own card, a child it filed, another card or another workspace.
describe('criterion 4a — cross-card writes, board reads and Full access are NOT on the list (own id and other id)', () => {
  let child: number
  beforeAll(() => {
    child = insert("INSERT INTO objectives (title, workspace, status, parent_id) VALUES ('filed child', 'ws-a', 'working', ?)", card)
  })

  const ID_ROUTES: Array<[string, string, unknown]> = [
    ['PATCH', 'status', { status: 'cancelled' }],
    ['POST', 'message', { message: 'hi' }],
    ['GET', 'output', undefined],
    ['GET', 'siblings', undefined],
  ]
  it.each(ID_ROUTES)('%s /objectives/:id/%s → 403 for its own card, a child it filed, another card, another workspace', async (method, sub, body) => {
    for (const [label, target] of [['own', card], ['child', child], ['other', other], ['foreign', foreign]] as const) {
      const r = await call(method, `/objectives/${target}/${sub}`, { tok: token, body })
      expect(r.status, `${label} #${target}`).toBe(403)
      expect(r.json.error, `${label} #${target}`).toBe(SANDBOX_PEER_REFUSAL)
    }
    // Nothing moved.
    for (const id of [card, child, other, foreign]) {
      expect((getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status).toBe('working')
    }
  })

  it('POST /full-access/cards/:id/take-over → 403 for its own card and another card', async () => {
    for (const target of [card, child, other, foreign]) {
      const r = await call('POST', `/full-access/cards/${target}/take-over`, { tok: token, body: {} })
      expect(r.status, String(target)).toBe(403)
      expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
    }
  })

  it.each([
    ['GET', '/objectives'],
    ['GET', '/objectives?fields=minimal'],
    ['GET', '/objectives?workspace=ws-a'],
    ['GET', '/objectives?owned_by_bot=some-bot'],
    ['GET', '/supervisor/flags'],
    ['GET', '/full-access'],
  ])('%s %s → 403', async (method, p) => {
    const r = await call(method, p, { tok: token })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
  })

  it('the handlers refuse too when the gate is bypassed (defense in depth)', async () => {
    const { default: router } = await import('../routes/internal.js')
    const bare = express()
    bare.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: JAIL, configurable: true })
      next()
    })
    bare.use(express.json())
    bare.use('/api/internal', router) // NO internalApiGate in front
    const srv = http.createServer(bare)
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const a = srv.address()
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/internal`
    const h = { 'X-CC-Session-Token': token, 'Content-Type': 'application/json' }
    try {
      expect((await fetch(`${url}/objectives/${child}/status`, { method: 'PATCH', headers: h, body: '{"status":"cancelled"}' })).status).toBe(403)
      expect((await fetch(`${url}/objectives/${child}/message`, { method: 'POST', headers: h, body: '{"message":"hi"}' })).status).toBe(403)
      expect((await fetch(`${url}/objectives/${child}/output`, { headers: h })).status).toBe(403)
      expect((await fetch(`${url}/objectives/${other}`, { headers: h })).status).toBe(403)
      expect((await fetch(`${url}/objectives/${card}`, { headers: h })).status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
    expect((getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(child) as { status: string }).status).toBe('working')
  })
})

describe('criterion 3 — a jailed AI reviewer locks and reads the rubric of ITS card only', () => {
  const rubric = [{ id: 'gate-scope', criterion: 'Jailed sessions reach only their own card', type: 'functional', method: 'api' }]

  it('POST /reviews/N/criteria with the token for N → 201 and the rubric is locked on N', async () => {
    const r = await call('POST', `/reviews/${reviewed}/criteria`, { tok: reviewerToken, body: { criteria: rubric } })
    expect(r.status).toBe(201)
    expect(r.json.ok).toBe(true)
    const row = getDb().prepare('SELECT acceptance_criteria FROM objectives WHERE id = ?').get(reviewed) as { acceptance_criteria: string }
    expect(JSON.parse(row.acceptance_criteria)).toEqual(rubric)
    // The lock still holds: a second POST is the existing 409, not an overwrite.
    expect((await call('POST', `/reviews/${reviewed}/criteria`, { tok: reviewerToken, body: { criteria: [] } })).status).toBe(409)
  })

  it('GET /reviews/N/criteria with the token for N → 200 with the locked rubric', async () => {
    const r = await call('GET', `/reviews/${reviewed}/criteria`, { tok: reviewerToken })
    expect(r.status).toBe(200)
    expect(r.json.criteria).toEqual(rubric)
  })

  it('the same token on /reviews/M/criteria (another card) → 403, and M is untouched', async () => {
    for (const target of [reviewedPeer, card, foreign]) {
      const post = await call('POST', `/reviews/${target}/criteria`, { tok: reviewerToken, body: { criteria: rubric } })
      expect(post.status, `POST ${target}`).toBe(403)
      expect(post.json.error).toBe(SANDBOX_PEER_REFUSAL)
      const get = await call('GET', `/reviews/${target}/criteria`, { tok: reviewerToken })
      expect(get.status, `GET ${target}`).toBe(403)
    }
    const row = getDb().prepare('SELECT acceptance_criteria FROM objectives WHERE id = ?').get(reviewedPeer) as { acceptance_criteria: string | null }
    expect(row.acceptance_criteria).toBeNull()
  })

  it('no token / a bad token on the reviews route → 403 with the gate message', async () => {
    for (const tok of [null, 'ccs_garbage']) {
      const r = await call('GET', `/reviews/${reviewed}/criteria`, { tok })
      expect(r.status).toBe(403)
      expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
    }
  })

  it('the handler re-checks the binding itself (defense in depth, gate bypassed)', async () => {
    const { internalReviewsRouter: router } = await import('../routes/reviews.js')
    const bare = express()
    bare.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: JAIL, configurable: true })
      next()
    })
    bare.use(express.json())
    bare.use('/api/internal/reviews', router) // NO internalApiGate in front
    const srv = http.createServer(bare)
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const a = srv.address()
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/internal/reviews`
    try {
      const other = await fetch(`${url}/${reviewedPeer}/criteria`, { headers: { 'X-CC-Session-Token': reviewerToken } })
      expect(other.status).toBe(403)
      const none = await fetch(`${url}/${reviewed}/criteria`)
      expect(none.status).toBe(403)
      const own = await fetch(`${url}/${reviewed}/criteria`, { headers: { 'X-CC-Session-Token': reviewerToken } })
      expect(own.status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  })
})

describe('criterion 4 —a valid token does not open any route off the allow-list', () => {
  it.each([
    ['POST', '/deploy'],
    ['POST', '/restart'],
    ['GET', '/pr-health'],
    ['GET', '/pr-health/digest'],
    ['GET', '/reviews/9999999/criteria'],
    ['POST', '/reviews/9999999/criteria'],
    ['GET', '/strategies'],
    ['GET', '/briefing'],
    ['GET', '/routines'],
    ['POST', '/routines'],
    ['POST', '/progress'],
    ['GET', '/objectives/1/accountability'],
    ['POST', '/objectives/1/decision'],
    ['GET', '/test-credentials/x'],
    ['GET', '/supervisor'],
    ['POST', '/supervisor/run'],
    ['GET', '/vault/search'],
    ['GET', '/repos'],
    ['POST', '/gmail-triage/run'],
    ['DELETE', '/objectives/1/memory/file'],
  ])('%s %s → 403', async (method, p) => {
    const r = await call(method, p.replace('/1/', `/${card}/`), { tok: token, body: method === 'GET' ? undefined : {} })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
  })

  it('path tricks do not widen the list', async () => {
    for (const p of [
      `/objectives/${card}/memory/file/../../../deploy`,
      `/objectives/${card}%2F..%2F..%2Fdeploy`,
      `/objectives/${card}/progress%2F..`,
      `/objectives/${card}/memory/file.json`,
    ]) {
      const r = await call('POST', p, { tok: token, body: {} })
      expect(r.status, p).toBe(403)
    }
  })
})

describe('criterion 5 — no, bad, expired or ended-card token: 403 with the same message as before', () => {
  const ROUTE = () => `/objectives/${card}/progress`
  it('no token', async () => {
    const r = await call('POST', ROUTE(), { tok: null, body: { step: 1 } })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
  })
  it('bad / forged token', async () => {
    for (const bad of ['ccs_garbage', `${token.slice(0, -3)}AAA`, 'Bearer x']) {
      const r = await call('POST', ROUTE(), { tok: bad, body: { step: 1 } })
      expect(r.status, bad).toBe(403)
      expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
    }
  })
  it('expired token', async () => {
    const expired = mintSessionToken({ objectiveId: card, workspace: 'ws-a', actingUserId: null }, Date.now() - 10 * 86_400_000, 86_400_000)
    const r = await call('POST', ROUTE(), { tok: expired, body: { step: 1 } })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
  })
  it('a token for a card that has ENDED (done) or no longer exists', async () => {
    const doneTok = mintSessionToken({ objectiveId: done, workspace: 'ws-a', actingUserId: null })
    const r = await call('GET', `/objectives/${done}/memory/file?path=NOTES.md`, { tok: doneTok })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
    const ghost = mintSessionToken({ objectiveId: 9_999_999, workspace: 'ws-a', actingUserId: null })
    expect((await call('GET', '/objectives/9999999/progress', { tok: ghost })).status).toBe(403)
  })
  it('a token whose workspace claim no longer matches the card', async () => {
    const moved = mintSessionToken({ objectiveId: card, workspace: 'ws-b', actingUserId: null })
    expect((await call('GET', `/objectives/${card}/progress`, { tok: moved })).status).toBe(403)
  })
})

describe('criterion 6 — loopback and credentialled callers behave exactly as before', () => {
  it('bare loopback still reaches any card and any internal route', async () => {
    expect((await call('POST', `/objectives/${other}/progress`, { peer: '127.0.0.1', body: { step: 1, label: 'cron' } })).status).toBe(201)
    expect((await call('GET', '/strategies', { peer: '127.0.0.1' })).status).toBe(200)
  })
  it('loopback with a session token for card N on card M is unchanged (tmux mode)', async () => {
    expect((await call('POST', `/objectives/${other}/progress`, { peer: '127.0.0.1', tok: token, body: { step: 2, label: 'x' } })).status).toBe(201)
  })
  it('a sandbox peer with X-Internal-Secret is still board-wide', async () => {
    const h = { 'x-internal-secret': process.env.INTERNAL_API_SECRET! }
    expect((await call('POST', `/objectives/${other}/progress`, { headers: h, body: { step: 3, label: 'x' } })).status).toBe(201)
    expect((await call('GET', '/strategies', { headers: h })).status).toBe(200)
  })
  it('INTERNAL_API_REQUIRE_SECRET=1 still refuses bare localhost', async () => {
    process.env.INTERNAL_API_REQUIRE_SECRET = '1'
    const r = await call('GET', '/strategies', { peer: '127.0.0.1' })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe('Internal API: local origin or X-Internal-Secret required')
  })
  it('a session token from a remote (non-jail) peer gets nothing', async () => {
    expect((await call('GET', `/objectives/${card}/progress`, { peer: '203.0.113.9', tok: token })).status).toBe(403)
  })
})

describe('criterion 7 — every internal call the session prompts tell a card to make is allow-listed', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const PROMPT_FILES = [
    'services/prompt-builder.ts',
    'services/prompt-builder-blocks.ts',
    'services/kb-access-prompt.ts',
    'services/decision-prompt.ts',
    'services/agent-chat/high-agency.ts',
    'services/session-reviewer-prompt.ts',
  ]
  // Told to a card, but deliberately NOT for a jailed peer — with the reason.
  const EXEMPT: Record<string, string> = {
    // Strategy Decision Requests need X-Internal-Secret from EVERY caller,
    // loopback included (requireInternalSecret in the handler); that is a
    // stricter rule than the gate and unchanged here.
    'POST /objectives/1/decision': 'requires X-Internal-Secret on every origin',
  }
  // Told to a DELEGATOR or a High Agency wake, and refused to a jailed session
  // on purpose (operator review of PR 847): they read the board or act on
  // ANOTHER card. Opening any of them from a jail needs the owner's approval
  // and is listed in the PR body as a follow-up. They still work on loopback
  // (tmux mode) exactly as before. This list is EXACT: a new cross-card call in
  // a prompt fails the test until someone decides about it.
  const JAIL_REFUSED_FOLLOW_UP: Record<string, string> = {
    // obj 901280: a High Agency wake now reaches these four for its OWN bot's
    // cards (lib/high-agency-wake-scope.ts); every other caller is still refused,
    // so they stay off the own-card list. Delegators remain a follow-up.
    'GET /objectives': 'board read (HA wake: owned_by_bot list — wake-scoped since 901280)',
    'GET /objectives/1/siblings': 'reads other cards',
    'GET /objectives/1/output': "reads another card's transcript (delegator → child)",
    'PATCH /objectives/1/status': "changes another card's status (delegator; HA close-out wake-scoped since 901280)",
    'POST /objectives/1/message': 'steers another card (delegator; HA wake-scoped since 901280)',
    'GET /supervisor/flags': 'board read (HA wake — wake-scoped since 901280)',
    'GET /full-access': 'Full access (HA wake)',
    'POST /full-access/cards/1/take-over': 'acts on another card (HA wake)',
  }

  /** Every `curl … /api/internal/…` in the prompt sources, with method and a concrete path. */
  function promptCalls(): Array<{ file: string; method: string; path: string }> {
    const out: Array<{ file: string; method: string; path: string }> = []
    for (const rel of PROMPT_FILES) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8')
      const base = /const base = 'http:\/\/localhost:3002(\/api\/internal\/objectives)'/.exec(text)?.[1]
      // The reviewer prompt names its one internal URL once and interpolates it.
      const criteriaUrl = /const criteriaUrl = `http:\/\/localhost:3002(\/api\/internal\/reviews\/\$\{objective\.id\}\/criteria)`/.exec(text)?.[1]
      for (const line of text.split('\n')) {
        if (/^\s*(\/\/|\*)/.test(line)) continue // a code comment is not prompt text
        if (!/curl|POST |PATCH |GET /.test(line)) continue
        const withUrl = criteriaUrl ? line.replace(/\$\{criteriaUrl\}/g, criteriaUrl) : line
        const expanded = (base ? withUrl.replace(/\$\{base\}/g, base) : withUrl).replace(/<new id>/g, '<id>')
        // A line can carry several calls; each one's method is the last `-X` since its own `curl`.
        for (const m of expanded.matchAll(/(\/api\/internal\/[A-Za-z0-9_\-/<>${}.]*)/g)) {
          const before = expanded.slice(0, m.index)
          const seg = before.slice(Math.max(0, before.lastIndexOf('curl')))
          const methods = [...seg.matchAll(/-X (POST|PATCH|PUT|DELETE)/g)]
          const method = methods.length ? methods[methods.length - 1][1] : (/(POST|PUT|PATCH) (?:http[^\s]*)?$/.exec(before)?.[1] ?? 'GET')
          const p = m[1].replace(/\$\{[^}]+\}|\$CC_OBJECTIVE_ID|<id>/g, '1').replace(/\/+$/, '')
          out.push({ file: rel, method, path: p })
        }
      }
    }
    return out
  }

  it('finds the calls (guards the scanner itself)', () => {
    const calls = promptCalls()
    const keys = new Set(calls.map((c) => `${c.method} ${c.path}`))
    for (const k of [
      'POST /api/internal/objectives/1/job-disposition',
      'POST /api/internal/objectives',
      'POST /api/internal/pr-created',
      'PATCH /api/internal/objectives/1/status',
      'GET /api/internal/supervisor/flags',
      'GET /api/internal/full-access',
      'POST /api/internal/reviews/1/criteria',
      'GET /api/internal/reviews/1/criteria',
    ]) expect(keys, k).toContain(k)
    expect(calls.length).toBeGreaterThan(15)
  })

  it('each is on CARD_SESSION_ROUTES (or explicitly exempt with a reason)', () => {
    const missing: string[] = []
    for (const c of promptCalls()) {
      const sub = internalSubPath({ baseUrl: '', path: c.path })
      const key = `${c.method} ${sub}`
      if (EXEMPT[key] || JAIL_REFUSED_FOLLOW_UP[key]) continue
      if (!matchCardSessionRoute(c.method, sub)) missing.push(`${c.file}: ${c.method} ${c.path}`)
    }
    expect(missing).toEqual([])
  })

  it('the jail-refused follow-up list is exact, and none of it is on the allow-list', () => {
    const seen = new Set(promptCalls().map((c) => `${c.method} ${internalSubPath({ baseUrl: '', path: c.path })}`))
    for (const key of Object.keys(JAIL_REFUSED_FOLLOW_UP)) {
      expect(seen.has(key), `stale follow-up entry: ${key}`).toBe(true)
      const [method, p] = key.split(' ')
      expect(matchCardSessionRoute(method, p), key).toBeNull()
    }
  })

  it('every curl to /api/internal in the prompts carries the session token header', () => {
    const missing: string[] = []
    for (const rel of PROMPT_FILES) {
      const lines = fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/curl/.test(line) || !/api\/internal|\$\{base\}|\$\{criteriaUrl\}/.test(line)) return
        const window = lines.slice(i, i + 3).join('\n')
        if (!/CC_SESSION_TOKEN|\$\{H\}/.test(window)) missing.push(`${rel}:${i + 1}`)
      })
    }
    expect(missing).toEqual([])
  })
})

describe('criterion 8 — the internal secret and the objectives token never reach a jail or a prompt', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  it('no worker or reviewer prompt source names them', () => {
    const hits: string[] = []
    for (const rel of [
      'services/prompt-builder.ts',
      'services/prompt-builder-blocks.ts',
      'services/kb-access-prompt.ts',
      'services/decision-prompt.ts',
      'services/agent-chat/high-agency.ts',
      'services/session-reviewer-prompt.ts',
    ]) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8')
      for (const name of ['INTERNAL_API_SECRET', 'OBJECTIVES_API_TOKEN', 'X-Internal-Secret']) {
        if (text.toLowerCase().includes(name.toLowerCase())) hits.push(`${rel}: ${name}`)
      }
    }
    expect(hits).toEqual([])
  })
  it('the jail env file drops them even when the spawn env carries them', async () => {
    const { renderEnvFile } = await import('../services/session-jail.js')
    const out = renderEnvFile({ INTERNAL_API_SECRET: 's', OBJECTIVES_API_TOKEN: 't', CC_SESSION_TOKEN: token })
    expect(out).not.toMatch(/INTERNAL_API_SECRET|OBJECTIVES_API_TOKEN/)
    expect(out).toContain('CC_SESSION_TOKEN=')
  })
})

describe('route matcher', () => {
  it('normalises the way Express routes (case, trailing slash, percent-encoding)', () => {
    expect(matchCardSessionRoute('GET', internalSubPath({ baseUrl: '/api/internal', path: '/Objectives/12/Progress/' }))).toEqual({ scope: 'own', id: 12 })
    expect(matchCardSessionRoute('HEAD', internalSubPath({ baseUrl: '/api/internal', path: '/objectives/%31%32/progress' }))).toEqual({ scope: 'own', id: 12 })
    expect(internalSubPath({ baseUrl: '/api/internal', path: '/objectives/1%2F..%2Fdeploy' })).toBeNull()
    expect(internalSubPath({ baseUrl: '/api/other', path: '/objectives' })).toBeNull()
    expect(matchCardSessionRoute('DELETE', '/objectives/1/memory/file')).toBeNull()
    expect(matchCardSessionRoute('POST', '/deploy')).toBeNull()
  })
  it('the allow-list is exactly the documented set', () => {
    expect(CARD_SESSION_ROUTES.map((r) => `${r.methods.join('|')} ${r.pattern.source} ${r.scope}`)).toMatchInlineSnapshot(`
      [
        "GET|PUT ^\\/objectives\\/(\\d{1,12})\\/memory\\/file$ own",
        "GET|POST ^\\/objectives\\/(\\d{1,12})\\/progress$ own",
        "GET ^\\/objectives\\/(\\d{1,12})\\/artifacts$ own",
        "GET ^\\/objectives\\/(\\d{1,12})\\/artifacts\\/file$ own",
        "POST ^\\/objectives\\/(\\d{1,12})\\/job-disposition$ own",
        "POST ^\\/objectives\\/(\\d{1,12})\\/fanout$ own",
        "GET|POST ^\\/reviews\\/(\\d{1,12})\\/criteria$ own",
        "POST ^\\/objectives$ create",
        "POST ^\\/pr-created$ pr",
        "GET ^\\/objectives\\/(\\d{1,12})$ own",
      ]
    `)
  })
})
