// obj 901387 — the Bots page "Needs you" numbers over HTTP.
//
// Before: every card parked in `review` counted as "needs you", so a bot read
// "47 need you · 47 in review". Now the count is only cards a person has to act
// on, "N in review" stays a plain stage count, and the same rule drives the
// per-bot row / chat header (GET /agents/:slug/work), the header total
// (GET /bot-status) and the chat `board_briefing` "waiting on you" list.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-needs-you-review-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-needs-you-review-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59949'
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-needs-you-review-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { setBotWorkspaces } = await import('../services/agent-chat/bot-workspaces.js')
const { raiseDecision, recordChoice } = await import('../services/decisions.js')
const { boardBriefing } = await import('../services/agent-chat/tools.js')
const { buildAttention } = await import('../lib/agent-control.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string

async function call(p: string) {
  const token = jwt.sign({ id: 1, username: 'user1', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, { headers: { Cookie: `token=${token}` } })
  return { status: res.status, json: (await res.json()) as Loose }
}

interface Spec {
  status: string
  bot?: string
  session_id?: string | null
  pr?: boolean
  verdict?: 'pass' | 'fail' | 'blocked' | null
  has_blockers?: number
  skip_ai_review?: number
  needs_secret?: string | null
}

let seq = 0
function card(s: Spec): number {
  seq += 1
  return Number(
    getDb()
      .prepare(
        `INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id, has_blockers, pr_url, pr_number,
           ai_review_verdict, skip_ai_review, needs_secret)
         VALUES (?, ?, 'ops', 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `card ${seq}`,
        s.bot ?? 'cto',
        s.status,
        s.session_id ?? null,
        s.has_blockers ?? 0,
        s.pr ? `https://github.com/acme/repo/pull/${seq}` : null,
        s.pr ? seq : null,
        s.verdict ?? null,
        s.skip_ai_review ?? 0,
        s.needs_secret ?? null,
      ).lastInsertRowid,
  )
}

const briefing = {
  context: 'The importer is built and its pull request is open. Merging is the last step.',
  question: 'Should the importer pull request be merged today?',
  options: [
    { key: 'A', label: 'Merge today', pros: ['Ships now'], cons: ['No second look'], next: 'I merge it.' },
    { key: 'B', label: 'Hold', pros: ['More review time'], cons: ['Ships later'], next: 'I wait.' },
  ],
  recommended: 'A',
  recommended_why: 'Checks are green.',
}

const ids: Record<string, number> = {}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ops', 'Ops')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'ops', 'admin')`).run()
  for (const [slug, name] of [['cto', 'CTO'], ['gtm', 'GTM']]) {
    fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
    fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${name}\nsystem_prompt: You work.\n`)
    setBotWorkspaces(slug, ['ops'], 'test')
  }

  // In review, NOT the person's turn.
  ids.noAiReviewYet = card({ status: 'review', pr: true }) // PR open, no AI review has run (also how #901381 cards look)
  ids.aiReviewRunning = card({ status: 'ai_review', session_id: 'rev-1', pr: true })
  ids.workerOnBounce = card({ status: 'review', session_id: 'live-1', pr: true, verdict: 'fail' })
  ids.answered = card({ status: 'review', pr: true })
  // In review, the person's turn.
  ids.passed = card({ status: 'review', pr: true, verdict: 'pass' })
  ids.failedParked = card({ status: 'review', pr: true, verdict: 'fail' })
  ids.noPr = card({ status: 'review' })
  ids.openDecision = card({ status: 'review', pr: true })
  ids.secret = card({ status: 'review', pr: true, needs_secret: JSON.stringify([{ name: 'ACME_API_KEY', reason: 'call the vendor' }]) })
  // Not in review at all.
  ids.blocked = card({ status: 'working', session_id: 'live-2', has_blockers: 1 })
  ids.fine = card({ status: 'working', session_id: 'live-3' })
  // A second bot whose review cards all still wait on their AI review.
  ids.gtm1 = card({ status: 'review', bot: 'gtm', pr: true })
  ids.gtm2 = card({ status: 'review', bot: 'gtm', pr: true })

  const open = raiseDecision(db, { objective_id: ids.openDecision, workspace: 'ops', source: 'worker', briefing })
  if (!open.ok) throw new Error(open.errors.join('; '))
  const done = raiseDecision(db, { objective_id: ids.answered, workspace: 'ops', source: 'worker', briefing })
  if (!done.ok) throw new Error(done.errors.join('; '))
  recordChoice(db, done.decision.id, { choice: 'A', by: 'user:1' })

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

describe('Bots page "Needs you" (obj 901387)', () => {
  it('per card: only cards a person has to act on are flagged', async () => {
    const r = await call('/agents/cto/work')
    expect(r.status).toBe(200)
    const all: Loose[] = [...r.json.groups.running, ...r.json.groups.review, ...r.json.groups.queued]
    const reasons = Object.fromEntries(all.map(c => [c.id, c.needs_you]))
    const stage = Object.fromEntries(all.map(c => [c.id, c.review_stage]))

    // a review card with no AI review yet: not counted
    expect(reasons[ids.noAiReviewYet]).toEqual([])
    expect(stage[ids.noAiReviewYet]).toBe('awaiting_ai_review')
    expect(reasons[ids.aiReviewRunning]).toEqual([])
    expect(reasons[ids.workerOnBounce]).toEqual([])
    expect(stage[ids.workerOnBounce]).toBe('agent_running')
    // an answered decision: not counted
    expect(reasons[ids.answered]).toEqual([])

    // a review card with a passed AI review: counted
    expect(reasons[ids.passed]).toEqual(['decision'])
    expect(stage[ids.passed]).toBe('sign_off')
    expect(reasons[ids.failedParked]).toEqual(['decision'])
    expect(reasons[ids.noPr]).toEqual(['decision'])
    // an open, unanswered decision: counted
    expect(reasons[ids.openDecision]).toEqual(['decision'])
    // a secret a worker waits for, and a blocker waiting on the person: counted
    expect(reasons[ids.secret]).toEqual(['blocker'])
    expect(reasons[ids.blocked]).toEqual(['blocker'])
    expect(reasons[ids.fine]).toEqual([])
  })

  it('the row and chat header: "need you" and "in review" are two different numbers', async () => {
    const r = await call('/agents/cto/work')
    // 9 cards in the review stage; 5 of them (plus the blocked running card) need the person.
    expect(r.json.counts).toMatchObject({ running: 2, review: 9, needs_you: 6 })
    expect(r.json.line).toBe('6 need you · 2 running · 9 in review')
  })

  it('a bot whose review cards all wait on AI review needs nobody, and still shows them in review', async () => {
    const r = await call('/agents/gtm/work')
    expect(r.json.counts).toMatchObject({ review: 2, needs_you: 0 })
    expect(r.json.state).toBe('idle')
    expect(r.json.line).toBe('Idle · 2 in review')
  })

  it('the header total uses the same rule', async () => {
    const r = await call('/bot-status')
    expect(r.json.needs_you_total).toBe(6)
    expect(r.json.bots.cto.counts.needs_you).toBe(6)
    expect(r.json.bots.gtm.counts.needs_you).toBe(0)
    expect(r.json.bots.gtm.counts.review).toBe(2)
  })

  it('answering the decision takes the card out of "needs you"', async () => {
    const db = getDb()
    const id = card({ status: 'review', pr: true })
    try {
      const raised = raiseDecision(db, { objective_id: id, workspace: 'ops', source: 'worker', briefing })
      if (!raised.ok) throw new Error('raise failed')
      expect((await call('/bot-status')).json.needs_you_total).toBe(7)
      recordChoice(db, raised.decision.id, { choice: 'B', by: 'user:1' })
      expect((await call('/bot-status')).json.needs_you_total).toBe(6)
    } finally {
      db.prepare('DELETE FROM decisions WHERE objective_id = ?').run(id)
      db.prepare('DELETE FROM objectives WHERE id = ?').run(id)
    }
  })

  it('board_briefing "waiting on you" lists the same review cards', () => {
    const brief = boardBriefing({ userId: 1, agent: { slug: 'cto' } } as Loose, { limit: 50 })
    const listed = new Set(brief.waiting_on_you.map((i: Loose) => i.id))
    for (const k of ['passed', 'failedParked', 'noPr', 'openDecision', 'secret', 'blocked']) expect(listed.has(ids[k]), k).toBe(true)
    for (const k of ['noAiReviewYet', 'aiReviewRunning', 'workerOnBounce', 'answered', 'gtm1', 'gtm2']) expect(listed.has(ids[k]), k).toBe(false)
  })

  it('the attention brief keeps its kinds: passed = review, parked fail = failed_review, open decision = review', () => {
    const brief = buildAttention(getDb(), { id: 1, role: 'admin' }, { limit: 50 })
    const byId = Object.fromEntries(brief.items.map(i => [i.id, i]))
    expect(byId[ids.passed].kind).toBe('review')
    expect(byId[ids.passed].why).toMatch(/^AI review passed/)
    expect(byId[ids.failedParked].kind).toBe('failed_review')
    expect(byId[ids.openDecision].kind).toBe('review')
    expect(byId[ids.openDecision].why).toMatch(/^Decision waiting on you/)
    expect(byId[ids.noAiReviewYet]).toBeUndefined()
    expect(brief.counts).toMatchObject({ needs_secret: 1, failed_review: 1, review: 3, blocked: 1 })
  })
})
