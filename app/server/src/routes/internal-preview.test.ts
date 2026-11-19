import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express, { Router } from 'express'

// obj 901228 — POST /api/internal/pr-created no longer files a `[Review]` child
// card. It still records the PR on the parent, appends the PR log and enqueues
// the preview deploy. The parent's own AI review (state-poller) is what gates.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pr-created-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-pr-created-901228'

const enqueuePreviewDeploy = vi.fn((_pr: number, _branch: string | undefined, _id: number) => true)
const kickHostDrain = vi.fn()
vi.mock('../services/preview-spool.js', () => ({
  enqueuePreviewDeploy: (pr: number, branch: string | undefined, id: number) => enqueuePreviewDeploy(pr, branch, id),
  kickHostDrain: () => kickHostDrain(),
}))

const { getDb, initDb } = await import('../db/index.js')
const { registerInternalPreviewRoutes } = await import('./internal-preview.js')

let server: http.Server
let baseUrl: string
let parent: number

const REPO = 'your-org/operationkit'

function children(id: number) {
  return getDb().prepare('SELECT id, title, workflow_hint FROM objectives WHERE parent_id = ?').all(id) as Array<{ id: number; title: string; workflow_hint: string | null }>
}

function reviewLikeRows() {
  return getDb().prepare("SELECT id FROM objectives WHERE title LIKE '[Review]%' OR workflow_hint = 'adversarial'").all()
}

async function prCreated(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/internal/pr-created`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  initDb()
  parent = Number(
    getDb()
      .prepare("INSERT INTO objectives (title, description, status, agent_context, workspace, project) VALUES ('Ship the thing', '', 'working', 'general', 'ws-a', 'operationkit')")
      .run().lastInsertRowid,
  )
  const router = Router()
  registerInternalPreviewRoutes(router)
  const app = express()
  app.use(express.json())
  app.use('/api/internal', router)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('POST /api/internal/pr-created (obj 901228)', () => {
  it('records the PR on the parent, logs it, enqueues the preview — and files NO [Review] child', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n
    const r = await prCreated({ objective_id: parent, branch_name: 'cc/obj-x', pr_url: `https://github.com/${REPO}/pull/4242` })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true })

    const row = getDb().prepare('SELECT branch_name, pr_url, pr_number FROM objectives WHERE id = ?').get(parent) as Record<string, unknown>
    expect(row).toEqual({ branch_name: 'cc/obj-x', pr_url: `https://github.com/${REPO}/pull/4242`, pr_number: 4242 })
    const logged = getDb().prepare('SELECT pr_number FROM objective_prs WHERE objective_id = ?').all(parent) as Array<{ pr_number: number }>
    expect(logged.map(l => l.pr_number)).toEqual([4242])
    expect(enqueuePreviewDeploy).toHaveBeenCalledWith(4242, 'cc/obj-x', parent)
    expect(kickHostDrain).toHaveBeenCalledTimes(1)

    expect(children(parent)).toEqual([])
    expect(reviewLikeRows()).toEqual([])
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n).toBe(before)
  })

  it('a second report of the same PR still creates no review child', async () => {
    const r = await prCreated({ objective_id: parent, branch_name: 'cc/obj-x', pr_url: `https://github.com/${REPO}/pull/4242` })
    expect(r.status).toBe(200)
    expect(children(parent)).toEqual([])
    expect(reviewLikeRows()).toEqual([])
    // Re-reported PR upserts the same log row.
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objective_prs WHERE objective_id = ?').get(parent) as { n: number }).n).toBe(1)
  })

  it('a new PR on the same card still files nothing', async () => {
    const r = await prCreated({ objective_id: parent, branch_name: 'cc/obj-x', pr_url: `https://github.com/${REPO}/pull/4243` })
    expect(r.status).toBe(200)
    expect(children(parent)).toEqual([])
    expect(reviewLikeRows()).toEqual([])
  })

  it('still requires objective_id', async () => {
    expect((await prCreated({ pr_url: `https://github.com/${REPO}/pull/1` })).status).toBe(400)
  })
})

// obj 901542 — branch_name is attacker-influenced (any worker session can call this
// route for its own card) and is later put into shell/argv git commands. The route
// must refuse and store nothing for a value that could break out of a shell string.
describe('POST /api/internal/pr-created rejects unsafe branch_name (obj 901542)', () => {
  it.each([
    'cc/obj-1-$(whoami)',
    'cc/obj-1-`id`',
    'cc/obj-1-"quoted"',
    'cc/obj-1-;rm -rf /',
    'cc/obj-1 with space',
    'cc/obj-1-with\nnewline',
  ])('rejects %j with 400 and stores nothing', async (branch_name) => {
    const before = getDb().prepare('SELECT branch_name, pr_url FROM objectives WHERE id = ?').get(parent)
    const r = await prCreated({ objective_id: parent, branch_name, pr_url: `https://github.com/${REPO}/pull/9001` })
    expect(r.status).toBe(400)
    const after = getDb().prepare('SELECT branch_name, pr_url FROM objectives WHERE id = ?').get(parent)
    expect(after).toEqual(before)
  })

  it('accepts a normal worker/<id>-slug branch name', async () => {
    const r = await prCreated({ objective_id: parent, branch_name: 'worker/901541-some-slug', pr_url: `https://github.com/${REPO}/pull/9002` })
    expect(r.status).toBe(200)
    const row = getDb().prepare('SELECT branch_name FROM objectives WHERE id = ?').get(parent) as { branch_name: string }
    expect(row.branch_name).toBe('worker/901541-some-slug')
  })
})
