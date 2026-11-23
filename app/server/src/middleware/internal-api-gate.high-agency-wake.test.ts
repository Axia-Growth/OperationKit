// obj 901280 — a jailed High Agency wake manages the cards ITS bot owns.
//
// PR 847 (obj 901195) let a jailed card session use a short list of internal
// routes on its OWN card only, so a High Agency wake oriented and then got 403
// on every card it is told to close out or start. These tests mount the REAL
// gate and the REAL internal routers exactly as index.ts does, fake a jail peer
// (x-test-peer), and prove:
//   1. each allowed action on a card the wake's bot owns: list, read, start,
//      hold, close (done / cancelled, override_reason on a PR card), message,
//      supervisor flags
//   2. 403 on another bot's card, an unowned card and another workspace's card
//      (and on the list / flags reads aimed at another bot or workspace)
//   3. a normal card session (and a look-alike that is not a real wake) is
//      still own-card-only
//   4. regression: orient > list own cards > file one > start it, all without 403
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gate-ha-wake-'))
const AGENTS = path.join(TMP, 'agents')
fs.mkdirSync(AGENTS, { recursive: true })
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-gate-card-session-901280'
process.env.INTERNAL_API_SECRET = 'test-internal-secret-901280'
process.env.TRANSCRIPT_DIR = TMP
process.env.OBJECTIVE_MEMORY_ROOT = path.join(TMP, 'memory')
process.env.INTERNAL_TRUSTED_PEER_CIDRS = '172.30.250.0/24'
process.env.AGENT_FILES_DIR = AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
delete process.env.INTERNAL_API_REQUIRE_SECRET
delete process.env.CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL

const startSession = vi.fn(async (o: { id: number }) => `sess-start-${o.id}`)
const sendFollowUp = vi.fn((_sid: string | null, _msg: string, o: { id: number }) => `sess-msg-${o.id}`)
const stopSession = vi.fn(async () => {})
vi.mock('../services/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/session-manager.js')>()),
  startSession,
  sendFollowUp,
  stopSession,
}))
vi.mock('../services/ci-green-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ci-green-gate.js')>()),
  runCompletionGate: vi.fn(async () => ({ blocked: false })),
}))

function writeBot(slug: string, yaml: string) {
  fs.mkdirSync(path.join(AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(AGENTS, slug, 'agent.yaml'), yaml)
}
writeBot('opsbot', 'name: Ops Bot\nsystem_prompt: You own operations.\n')
writeBot('sdr', 'name: SDR\nsystem_prompt: You own outbound.\n')

const { initDb, getDb } = await import('../db/index.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { internalApiGate, SANDBOX_PEER_REFUSAL } = await import('./internal-api-gate.js')
const { default: internalRouter } = await import('../routes/internal.js')
const { default: internalSupervisorRouter } = await import('../routes/internal-supervisor.js')
const { grantBotWorkspace } = await import('../services/agent-chat/bot-workspaces.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { buildHighAgencyBrief } = await import('../services/agent-chat/high-agency.js')
const { resolveHighAgencyWake, matchWakeRoute } = await import('../lib/high-agency-wake-scope.js')
const { internalSubPath, matchCardSessionRoute } = await import('../lib/card-session-scope.js')

const JAIL = '172.30.250.9'
const WS = 'ws-a'
let server: http.Server
let baseUrl: string

let wake: number // the opsbot High Agency wake (the caller)
let wakeToken: string
let parent: number // an ordinary parent card, so a done close is not redirected to review
const owned: Record<string, number> = {}
let otherBot: number // owned by SDR
let unowned: number // no bot owns it
let foreign: number // owned by opsbot, but in ws-b
let jobCard: number // a normal routine job card (not a wake)
let jobToken: string
let lookAlike: number // agent_context opsbot, but not filed by the wake routine
let lookAlikeToken: string
let wrongBotWake: number // filed by high-agency:opsbot, but worked by sdr
let wrongBotWakeToken: string

const insert = (sql: string, ...args: unknown[]): number => Number(getDb().prepare(sql).run(...args).lastInsertRowid)
const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status

async function call(
  method: string,
  p: string,
  opts: { body?: unknown; tok?: string | null; peer?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-test-peer': opts.peer ?? JAIL }
  const tok = opts.tok === undefined ? wakeToken : opts.tok
  if (tok) headers['X-CC-Session-Token'] = tok
  const res = await fetch(`${baseUrl}/api/internal${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  createWorkspace({ slug: WS, name: 'WS A' })
  createWorkspace({ slug: 'ws-b', name: 'WS B' })
  grantBotWorkspace('opsbot', WS, 'test')
  grantBotWorkspace('opsbot', 'ws-b', 'test') // the workspace, not the grant, is what keeps ws-b out
  grantBotWorkspace('sdr', WS, 'test')

  const haRoutine = insert("INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth) VALUES ('high-agency:opsbot', '5 7 * * *', ?, 0, 1)", JSON.stringify({ workspace: WS }))
  db.prepare("INSERT INTO agent_chat_high_agency (slug, enabled, level, workspace, routine_id) VALUES ('opsbot', 0, 3, ?, ?)").run(WS, haRoutine)
  wake = insert("INSERT INTO objectives (title, workspace, status, agent_context, routine_id) VALUES ('High Agency: Ops Bot', ?, 'working', 'opsbot', ?)", WS, haRoutine)
  wakeToken = mintSessionToken({ objectiveId: wake, workspace: WS, actingUserId: null })

  parent = insert("INSERT INTO objectives (title, workspace, status) VALUES ('a parent', ?, 'working')", WS)
  const card = (title: string, status: string, extra: Record<string, unknown> = {}) => {
    const cols = ['title', 'workspace', 'status', ...Object.keys(extra)]
    return insert(`INSERT INTO objectives (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, title, WS, status, ...Object.values(extra))
  }
  owned.queued = card('owned queued (by name)', 'queue', { owner_bot: 'Ops Bot' })
  owned.running = card('owned running (by slug)', 'working', { owner_bot: 'opsbot', session_id: 'sess-running' })
  owned.hold = card('owned to hold', 'working', { owner_bot: 'opsbot', parent_id: parent })
  owned.child = card('owned child to close', 'working', { owner_bot: 'opsbot', parent_id: parent })
  owned.pr = card('owned PR card', 'review', { owner_bot: 'opsbot', parent_id: parent, pr_url: 'https://github.com/o/r/pull/7', pr_number: 7, ai_review_verdict: 'fail' })
  owned.cancel = card('owned to cancel', 'queue', { owner_bot: 'opsbot' })
  owned.viaContext = card('owned via agent_context', 'queue', { agent_context: 'opsbot' })
  otherBot = card('SDR card', 'queue', { owner_bot: 'SDR' })
  unowned = card('nobody owns this', 'queue', {})
  foreign = insert("INSERT INTO objectives (title, workspace, status, owner_bot) VALUES ('opsbot card in ws-b', 'ws-b', 'queue', 'opsbot')")

  const jobRoutine = insert("INSERT INTO routines (name, cron_expr, objective_template, enabled) VALUES ('job-901280', '0 3 * * *', '{}', 0)")
  jobCard = insert("INSERT INTO objectives (title, workspace, status, routine_id, agent_context) VALUES ('ordinary job', ?, 'working', ?, 'opsbot')", WS, jobRoutine)
  jobToken = mintSessionToken({ objectiveId: jobCard, workspace: WS, actingUserId: null })
  lookAlike = insert("INSERT INTO objectives (title, workspace, status, agent_context) VALUES ('High Agency: Ops Bot (hand-made)', ?, 'working', 'opsbot')", WS)
  lookAlikeToken = mintSessionToken({ objectiveId: lookAlike, workspace: WS, actingUserId: null })
  wrongBotWake = insert("INSERT INTO objectives (title, workspace, status, agent_context, routine_id) VALUES ('wake worked by sdr', ?, 'working', 'sdr', ?)", WS, haRoutine)
  wrongBotWakeToken = mintSessionToken({ objectiveId: wrongBotWake, workspace: WS, actingUserId: null })

  // A supervisor flag routed to each bot.
  for (const [bot, id] of [['opsbot', owned.running], ['sdr', otherBot]] as const) {
    db.prepare(
      `INSERT INTO review_items (objective_id, workspace, kind, state, ask, dedupe_key, routed_to) VALUES (?, ?, 'stalled', 'open', ?, ?, ?)`,
    ).run(id, WS, `stalled #${id}`, `supervisor:stalled:${id}`, `agent:${bot}`)
  }

  const app = express()
  app.set('trust proxy', 'loopback, uniquelocal')
  app.use((req, _res, next) => {
    const peer = req.header('x-test-peer')
    if (peer) Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true })
    next()
  })
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/internal', internalApiGate)
  app.use('/api/internal', internalRouter)
  app.use('/api/internal/supervisor', internalSupervisorRouter)
  app.all('/api/internal/*', (_req, res) => { res.status(200).json({ reached: true }) })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('who counts as a High Agency wake', () => {
  it('the wake card resolves to its bot; a look-alike, a normal job and a wake worked by another bot do not', () => {
    const row = (id: number) => getDb().prepare('SELECT id, workspace, agent_context, routine_id FROM objectives WHERE id = ?').get(id) as any
    expect(resolveHighAgencyWake(row(wake), getDb())).toMatchObject({ cardId: wake, slug: 'opsbot', workspace: WS })
    expect(resolveHighAgencyWake(row(lookAlike), getDb())).toBeNull()
    expect(resolveHighAgencyWake(row(jobCard), getDb())).toBeNull()
    expect(resolveHighAgencyWake(row(wrongBotWake), getDb())).toBeNull()
  })
})

describe('criterion 1 — every allowed action on a card the wake\'s bot owns', () => {
  it('lists its own cards (owned_by_bot = its slug), and only those', async () => {
    const r = await call('GET', `/objectives?workspace=${WS}&include_terminal=0&fields=minimal&owned_by_bot=opsbot`)
    expect(r.status).toBe(200)
    const ids = (r.json as Array<{ id: number }>).map((o) => o.id)
    for (const id of Object.values(owned)) expect(ids).toContain(id)
    expect(ids).toContain(wake)
    for (const id of [otherBot, unowned, foreign, parent]) expect(ids).not.toContain(id)
    // Without ?workspace= it is pinned to the wake's workspace anyway.
    const pinned = await call('GET', '/objectives?owned_by_bot=opsbot&fields=minimal')
    expect(pinned.status).toBe(200)
    expect((pinned.json as Array<{ id: number }>).map((o) => o.id)).not.toContain(foreign)
  })

  it('reads an owned card in full (owner_bot by name, by slug, or by agent_context)', async () => {
    for (const id of [owned.queued, owned.running, owned.viaContext]) {
      const r = await call('GET', `/objectives/${id}`)
      expect(r.status, `#${id}`).toBe(200)
      expect(r.json.id).toBe(id)
    }
  })

  it('starts an owned queued card', async () => {
    startSession.mockClear()
    const r = await call('PATCH', `/objectives/${owned.queued}/status`, { body: { status: 'working' } })
    expect(r.status).toBe(200)
    expect(statusOf(owned.queued)).toBe('working')
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it('holds an owned running card (→ review, parked for a person)', async () => {
    const r = await call('PATCH', `/objectives/${owned.hold}/status`, { body: { status: 'review' } })
    expect(r.status).toBe(200)
    expect(statusOf(owned.hold)).toBe('review')
  })

  it('closes an owned card as done, and the audit row names the bot', async () => {
    const r = await call('PATCH', `/objectives/${owned.child}/status`, { body: { status: 'done' } })
    expect(r.status).toBe(200)
    expect(statusOf(owned.child)).toBe('done')
    const audit = getDb().prepare("SELECT actor, pathway FROM objective_audit WHERE objective_id = ? AND to_status = 'done'").get(owned.child) as { actor: string; pathway: string }
    expect(audit.actor).toBe('bot:opsbot')
    expect(audit.pathway).toBe(`internal-patch-status:high-agency-wake#${wake}`)
  })

  it('cancels an owned card', async () => {
    const r = await call('PATCH', `/objectives/${owned.cancel}/status`, { body: { status: 'cancelled' } })
    expect(r.status).toBe(200)
    expect(statusOf(owned.cancel)).toBe('cancelled')
  })

  it('a PR card with no passing review closes only with override_reason, which is audited', async () => {
    const refused = await call('PATCH', `/objectives/${owned.pr}/status`, { body: { status: 'done' } })
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('no_passing_review')
    expect(statusOf(owned.pr)).toBe('review')
    const ok = await call('PATCH', `/objectives/${owned.pr}/status`, { body: { status: 'done', override_reason: 'Superseded by PR 8; the owner closed the issue.' } })
    expect(ok.status).toBe(200)
    expect(statusOf(owned.pr)).toBe('done')
    const audit = getDb().prepare("SELECT actor, reason FROM objective_audit WHERE objective_id = ? AND to_status = 'done'").get(owned.pr) as { actor: string; reason: string }
    expect(audit).toEqual({ actor: 'bot:opsbot', reason: 'Superseded by PR 8; the owner closed the issue.' })
  })

  it('a wake may not move its bot\'s cards to other states (e.g. ai_review / queue / planning)', async () => {
    for (const status of ['ai_review', 'queue', 'planning']) {
      const r = await call('PATCH', `/objectives/${owned.running}/status`, { body: { status } })
      expect(r.status, status).toBe(403)
    }
    expect(statusOf(owned.running)).toBe('working')
  })

  it('steers an owned card with a message (server-derived sender, relation bot_owner)', async () => {
    sendFollowUp.mockClear()
    const r = await call('POST', `/objectives/${owned.running}/message`, { body: { message: 'Finish the export, then stop.' } })
    expect(r.status).toBe(200)
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    const log = getDb().prepare("SELECT metadata FROM activity_log WHERE objective_id = ? AND title LIKE 'internal message%' ORDER BY id DESC").get(owned.running) as { metadata: string }
    expect(JSON.parse(log.metadata)).toMatchObject({ from_objective_id: wake, relation: 'bot_owner', identity: 'session_token' })
  })

  it('reads its own bot\'s supervisor flags', async () => {
    const r = await call('GET', '/supervisor/flags?bot=opsbot')
    expect(r.status).toBe(200)
    const routed = (r.json.flags as Array<{ routed_to: string }>).map((f) => f.routed_to)
    expect(routed.length).toBeGreaterThan(0)
    expect(new Set(routed)).toEqual(new Set(['agent:opsbot']))
  })
})

describe('criterion 2 — another bot\'s card, an unowned card and another workspace stay 403', () => {
  const ACTIONS: Array<[string, string, unknown]> = [
    ['GET', '', undefined],
    ['PATCH', '/status', { status: 'working' }],
    ['PATCH', '/status', { status: 'cancelled' }],
    ['PATCH', '/status', { status: 'done' }],
    ['POST', '/message', { message: 'hi' }],
  ]
  it.each(ACTIONS)('%s /objectives/:id%s → 403 for another bot, unowned and another workspace', async (method, sub, body) => {
    for (const [label, target] of [['other bot', otherBot], ['unowned', unowned], ['other workspace', foreign]] as const) {
      const r = await call(method, `/objectives/${target}${sub}`, { body })
      expect(r.status, `${label} #${target}`).toBe(403)
      expect(r.json.error, `${label} #${target}`).toBe(SANDBOX_PEER_REFUSAL)
    }
    for (const id of [otherBot, unowned, foreign]) expect(statusOf(id)).toBe('queue')
  })

  it.each([
    ['GET', '/objectives'],
    ['GET', '/objectives?fields=minimal'],
    ['GET', `/objectives?workspace=${WS}`],
    ['GET', '/objectives?owned_by_bot=sdr'],
    ['GET', '/objectives?owned_by_bot=opsbot&workspace=ws-b'],
    ['GET', '/objectives?owned_by_bot=opsbot&owned_by_bot=sdr'],
    ['GET', '/supervisor/flags'],
    ['GET', '/supervisor/flags?bot=sdr'],
    ['GET', '/supervisor/flags?bot=opsbot&workspace=ws-b'],
    ['GET', '/supervisor/flags?bot=opsbot&routed_to=human'],
    ['GET', '/supervisor'],
    ['GET', `/objectives/${0}/output`],
    ['GET', `/objectives/${0}/siblings`],
    ['POST', '/full-access/cards/0/take-over'],
  ])('%s %s → 403 (board reads, other bot, other workspace, other routes)', async (method, p) => {
    const r = await call(method, p.replace('/0/', `/${owned.running}/`), { body: method === 'GET' ? undefined : {} })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
  })

  it('a wake still cannot write another card\'s memory, progress or disposition (PR 847 own-card list unchanged)', async () => {
    for (const [method, sub, body] of [
      ['PUT', 'memory/file', { path: 'NOTES.md', content: 'x' }],
      ['POST', 'progress', { step: 1, label: 'x' }],
      ['POST', 'job-disposition', { disposition: 'complete' }],
    ] as const) {
      const r = await call(method, `/objectives/${owned.running}/${sub}`, { body })
      expect(r.status, sub).toBe(403)
    }
  })

  it('the handlers refuse too when the gate is bypassed (defense in depth)', async () => {
    const bare = express()
    bare.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: JAIL, configurable: true })
      next()
    })
    bare.use(express.json())
    bare.use('/api/internal', internalRouter) // NO internalApiGate in front
    bare.use('/api/internal/supervisor', internalSupervisorRouter)
    const srv = http.createServer(bare)
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const a = srv.address()
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/internal`
    const h = { 'X-CC-Session-Token': wakeToken, 'Content-Type': 'application/json' }
    try {
      expect((await fetch(`${url}/objectives/${otherBot}/status`, { method: 'PATCH', headers: h, body: '{"status":"cancelled"}' })).status).toBe(403)
      expect((await fetch(`${url}/objectives/${unowned}/message`, { method: 'POST', headers: h, body: '{"message":"hi"}' })).status).toBe(403)
      expect((await fetch(`${url}/objectives/${foreign}`, { headers: h })).status).toBe(403)
      expect((await fetch(`${url}/objectives?owned_by_bot=sdr`, { headers: h })).status).toBe(403)
      expect((await fetch(`${url}/supervisor/flags?bot=sdr`, { headers: h })).status).toBe(403)
      expect((await fetch(`${url}/objectives/${owned.viaContext}`, { headers: h })).status).toBe(200)
      expect((await fetch(`${url}/supervisor/flags?bot=opsbot`, { headers: h })).status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
    expect(statusOf(otherBot)).toBe('queue')
  })
})

describe('criterion 3 — normal card sessions are still own-card-only', () => {
  it.each([
    ['an ordinary routine job worked by the same bot slug', () => jobToken],
    ['a hand-made card that looks like a wake (no wake routine)', () => lookAlikeToken],
    ['a card on the wake routine but worked by another bot', () => wrongBotWakeToken],
  ])('%s: the bot\'s cards, its list and its flags are 403', async (_label, tok) => {
    const t = tok()
    for (const [method, p, body] of [
      ['GET', `/objectives/${owned.viaContext}`, undefined],
      ['PATCH', `/objectives/${owned.viaContext}/status`, { status: 'cancelled' }],
      ['POST', `/objectives/${owned.viaContext}/message`, { message: 'hi' }],
      ['GET', `/objectives?owned_by_bot=opsbot&workspace=${WS}`, undefined],
      ['GET', '/supervisor/flags?bot=opsbot', undefined],
    ] as const) {
      const r = await call(method, p, { tok: t, body })
      expect(r.status, `${method} ${p}`).toBe(403)
      expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
    }
    expect(statusOf(owned.viaContext)).toBe('queue')
  })

  it('a normal session still reaches its OWN card row', async () => {
    const r = await call('GET', `/objectives/${jobCard}`, { tok: jobToken })
    expect(r.status).toBe(200)
  })

  it('no token / a bad token is still the gate refusal', async () => {
    for (const tok of [null, 'ccs_garbage']) {
      const r = await call('GET', '/objectives?owned_by_bot=opsbot', { tok })
      expect(r.status).toBe(403)
      expect(r.json.error).toBe(SANDBOX_PEER_REFUSAL)
    }
  })

  it('a wake whose bot lost the workspace loses the scope at once', async () => {
    const db = getDb()
    db.prepare("UPDATE agent_chat_high_agency SET workspace = 'ws-b' WHERE slug = 'opsbot'").run()
    try {
      const r = await call('GET', `/objectives/${owned.viaContext}`)
      expect(r.status).toBe(403)
    } finally {
      db.prepare("UPDATE agent_chat_high_agency SET workspace = ? WHERE slug = 'opsbot'").run(WS)
    }
  })
})

describe('criterion 4 — regression: orient > list own cards > file one > start it, no 403', () => {
  it('runs the wake brief\'s own commands end to end', async () => {
    const brief = buildHighAgencyBrief(
      { slug: 'opsbot', name: 'Ops Bot', description: 'operations', system_prompt: 'You own operations.', knowledge_folders: [] },
      { level: 3, workspace: WS, allow_cards: true, allow_workflows: false },
      'Operator',
    )
    // The list and flags URLs, exactly as the brief tells the bot to call them.
    const listUrl = /curl -s "http:\/\/localhost:3002\/api\/internal(\/objectives\?[^"]+)"/.exec(brief)?.[1]
    const flagsUrl = /curl -s "http:\/\/localhost:3002\/api\/internal(\/supervisor\/flags\?[^"]+)"/.exec(brief)?.[1]
    expect(listUrl).toBe(`/objectives?workspace=${WS}&include_terminal=0&fields=minimal&owned_by_bot=opsbot`)
    expect(flagsUrl).toBe('/supervisor/flags?bot=opsbot')

    // 1. Orient: its own wake card, its cards, its flags.
    expect((await call('GET', `/objectives/${wake}`)).status).toBe(200)
    const list = await call('GET', listUrl!)
    expect(list.status).toBe(200)
    expect((list.json as Array<{ id: number }>).length).toBeGreaterThan(0)
    for (const o of list.json as Array<{ id: number }>) expect((await call('GET', `/objectives/${o.id}`)).status, `read #${o.id}`).toBe(200)
    expect((await call('GET', flagsUrl!)).status).toBe(200)

    // 2. File one project (the brief's owner_bot form, linked by source_job_id) ...
    const ownerField = /"owner_bot":"([^"]+)"/.exec(brief)?.[1]
    expect(ownerField).toBe('Ops Bot')
    const filed = await call('POST', '/objectives', {
      body: [{ title: 'Ops: tidy the vendor list 901280', description: 'why + what', owner_bot: ownerField, workspace: WS, type: 'task', source_job_id: wake }],
    })
    expect(filed.status).toBe(201)
    const id = filed.json.objectives[0].id as number

    // 3. ... and start it.
    startSession.mockClear()
    const start = await call('PATCH', `/objectives/${id}/status`, { body: { status: 'working' } })
    expect(start.status).toBe(200)
    expect(statusOf(id)).toBe('working')
    expect(startSession).toHaveBeenCalledTimes(1)

    // The new card now shows in its list.
    const again = await call('GET', listUrl!)
    expect((again.json as Array<{ id: number }>).map((o) => o.id)).toContain(id)

    // 4. Report on its own card (unchanged PR 847 route).
    expect((await call('POST', `/objectives/${wake}/job-disposition`, { body: { disposition: 'complete', note: 'filed and started one project' } })).status).toBe(200)
  })
})

describe('the wake brief and the scope agree', () => {
  it('every /api/internal call in the brief is on the own-card list or the wake list, except Full access', () => {
    const brief = buildHighAgencyBrief(
      { slug: 'opsbot', name: 'Ops Bot', description: '', system_prompt: 'x', knowledge_folders: [] },
      { level: 3, workspace: WS, allow_cards: true, allow_workflows: true },
      'Operator',
    )
    const calls: string[] = []
    for (const raw of brief.split('\n')) {
      const line = raw.replace(/<new id>/g, '<id>')
      for (const m of line.matchAll(/(\/api\/internal\/[A-Za-z0-9_\-/<>$]*)/g)) {
        const before = line.slice(0, m.index)
        const seg = before.slice(Math.max(0, before.lastIndexOf('curl')))
        const methods = [...seg.matchAll(/-X (POST|PATCH|PUT|DELETE)/g)]
        const method = methods.length ? methods[methods.length - 1][1] : 'GET'
        const p = m[1].replace(/\$CC_OBJECTIVE_ID|<new id>|<id>/g, '1').replace(/\/+$/, '')
        calls.push(`${method} ${internalSubPath({ baseUrl: '', path: p })}`)
      }
    }
    expect(calls.length).toBeGreaterThan(5)
    const unreachable = [...new Set(calls)].filter((k) => {
      const [method, sub] = k.split(' ')
      return !matchCardSessionRoute(method, sub) && !matchWakeRoute(method, sub)
    })
    // Full access stays out of a jail (PR 847 / PR 807); it is a separate switch.
    expect(unreachable.sort()).toEqual(['GET /full-access', 'POST /full-access/cards/1/take-over'])
  })
})
