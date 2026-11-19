/**
 * obj 901454 — a PR merged by hand on GitHub closes its card.
 *
 * The signed `pull_request` closed+merged delivery moves the card whose OWN PR
 * this is from review / ai_review to done, through the real status handler.
 * It leaves alone: a closed-unmerged PR, a card in any other status, a card
 * whose PR is the same number in another repo, a Strategy, and a reserved PR.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'

process.env.HARNESS_REPO = process.env.HARNESS_REPO || 'your-org/operationkit'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ghwebhook-merged-close-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-ghwebhook-merged-close'
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret'
process.env.PREVIEW_SPOOL_DIR = path.join(TMP, 'spool')
process.env.PREVIEW_SPOOL_HOST_KICK = '0'
delete process.env.ANTHROPIC_API_KEY

// The done move runs the CI-green completion gate; GitHub is a fake that says green.
vi.mock('../services/ci-green-gate-github.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defaultExec: async (_f: string, args: string[]) => {
      if (args[0] === 'api') return '[]'
      return JSON.stringify({
        number: Number(args[2]), url: '', headRefOid: 'abc1234', baseRefName: 'main', state: 'MERGED',
        statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      })
    },
  }
})
vi.mock('../services/worktree-reaper.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, scheduleObjectiveWorktreeReap: () => {} }
})
vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (s: string) => s }
})

const { initDb, getDb } = await import('../db/index.js')
const { default: githubWebhookRouter, resetDeliveryDedupe } = await import('./github-webhook.js')
const { closeCardsForMergedPr } = await import('../services/merged-pr-close.js')

let server: http.Server
let baseUrl: string
const REPO = 'acme/app'

beforeAll(async () => {
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  const app = express()
  app.use('/api/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }), githubWebhookRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec('DELETE FROM objective_prs')
  getDb().exec('DELETE FROM objectives')
  getDb().exec("DELETE FROM settings WHERE key = 'grant_merge_reserved_prs'")
  resetDeliveryDedupe()
})

let seq = 0
async function deliver(payload: unknown): Promise<number> {
  const raw = JSON.stringify(payload)
  const sig = 'sha256=' + crypto.createHmac('sha256', 'test-webhook-secret').update(Buffer.from(raw, 'utf8')).digest('hex')
  const res = await fetch(`${baseUrl}/api/webhooks/github`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': `d-${++seq}`, 'x-hub-signature-256': sig },
    body: raw,
  })
  await res.text()
  return res.status
}

function closedPayload(number: number, merged: boolean, repo = REPO) {
  return {
    action: 'closed',
    number,
    pull_request: {
      merged,
      html_url: `https://github.com/${repo}/pull/${number}`,
      merge_commit_sha: 'abc123',
      merged_at: merged ? '2026-11-18T09:30:00Z' : null,
      title: 'fix: the thing',
      body: '',
      user: { login: 'octocat' },
      labels: [],
      base: { ref: 'feature-base' },
      head: { ref: 'cc/obj-1-thing' },
    },
    repository: { full_name: repo },
  }
}

function card(spec: { status?: string; pr: number; repo?: string; strategy?: boolean }): number {
  const repo = spec.repo ?? REPO
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, type, pr_url, pr_number, is_strategy)
     VALUES (?, 'general', 'growth', 1, ?, 'task', ?, ?, ?)`,
  ).run(`card for ${repo}#${spec.pr}`, spec.status ?? 'review', `https://github.com/${repo}/pull/${spec.pr}`, spec.pr, spec.strategy ? 1 : 0).lastInsertRowid)
}

const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status

/** The close runs after the 200 (fire-and-forget); wait for it to land. */
async function settle(id: number, want: string): Promise<string> {
  for (let i = 0; i < 100 && statusOf(id) !== want; i++) await new Promise(r => setTimeout(r, 20))
  return statusOf(id)
}

describe('merged-PR webhook closes the card (obj 901454)', () => {
  it('a review card whose PR was merged by hand ends up done, with an audit row naming the webhook', async () => {
    const id = card({ pr: 846 })
    expect(await deliver(closedPayload(846, true))).toBe(200)
    expect(await settle(id, 'done')).toBe('done')
    const audit = getDb().prepare(
      "SELECT * FROM objective_audit WHERE objective_id = ? AND event_type = 'status_change' ORDER BY id DESC",
    ).get(id) as { to_status: string; pathway: string; actor: string } | undefined
    expect(audit).toMatchObject({ to_status: 'done', pathway: 'github-webhook:pr-merged' })
  })

  it('an ai_review card closes too', async () => {
    const id = card({ pr: 847, status: 'ai_review' })
    await deliver(closedPayload(847, true))
    expect(await settle(id, 'done')).toBe('done')
  })

  it('a PR closed WITHOUT merging leaves the card alone', async () => {
    const id = card({ pr: 848 })
    await deliver(closedPayload(848, false))
    await new Promise(r => setTimeout(r, 200))
    expect(statusOf(id)).toBe('review')
  })

  it('a card whose worker is still running is not closed', async () => {
    const id = card({ pr: 849, status: 'working' })
    const r = await closeCardsForMergedPr({ repo: REPO, prNumber: 849 })
    expect(r).toEqual([{ objectiveId: id, outcome: 'skipped', reason: 'card is working' }])
    expect(statusOf(id)).toBe('working')
  })

  it('the same PR number in another repo does not close the card', async () => {
    const id = card({ pr: 850, repo: 'acme/other' })
    const r = await closeCardsForMergedPr({ repo: REPO, prNumber: 850 })
    expect(r).toEqual([])
    expect(statusOf(id)).toBe('review')
  })

  it('a Strategy and a reserved PR are never closed', async () => {
    const strat = card({ pr: 851, strategy: true })
    expect((await closeCardsForMergedPr({ repo: REPO, prNumber: 851 }))[0]).toMatchObject({ objectiveId: strat, outcome: 'skipped', reason: 'strategy' })
    expect(statusOf(strat)).toBe('review')

    const reserved = card({ pr: 645, repo: 'your-org/operationkit' })
    const r = await closeCardsForMergedPr({ repo: 'your-org/operationkit', prNumber: 645 })
    expect(r[0]).toMatchObject({ objectiveId: reserved, outcome: 'skipped', reason: 'reserved PR' })
    expect(statusOf(reserved)).toBe('review')
  })

  it('a replayed delivery on an already-done card is a no-op', async () => {
    const id = card({ pr: 852, status: 'done' })
    const r = await closeCardsForMergedPr({ repo: REPO, prNumber: 852 })
    expect(r).toEqual([{ objectiveId: id, outcome: 'skipped', reason: 'card is done' }])
  })
})
