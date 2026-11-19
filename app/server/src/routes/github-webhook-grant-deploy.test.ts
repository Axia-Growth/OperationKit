/**
 * obj 901389 — a merge a bot made under a MERGE grant never auto-deploys itself.
 *
 * The real merged-PR webhook route, a real SQLite DB, real grants. Only the
 * spawn of the self-deploy (triggerAutoDeploy) is replaced by a spy.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'

process.env.HARNESS_REPO = 'your-org/operationkit'
const TMP_DB = path.join(os.tmpdir(), `cc-ghwebhook-grant-deploy-${process.pid}-${Date.now()}.db`)
const TMP_SPOOL = path.join(os.tmpdir(), `cc-ghwebhook-grant-deploy-spool-${process.pid}-${Date.now()}`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-ghwebhook-grant-deploy'
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret'
process.env.PREVIEW_SPOOL_DIR = TMP_SPOOL
process.env.PREVIEW_SPOOL_HOST_KICK = '0'
delete process.env.ANTHROPIC_API_KEY
delete process.env.CC_AUTO_DEPLOY

const triggerSpy = vi.fn((reason: string) => ({ triggered: true, reason }))
vi.mock('../services/auto-deploy.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, triggerAutoDeploy: (reason: string) => triggerSpy(reason) }
})

const { initDb, getDb } = await import('../db/index.js')
const { default: githubWebhookRouter, resetDeliveryDedupe } = await import('./github-webhook.js')
const { createGrant, writeDelegationAudit, revokeGrant } = await import('../services/delegated-approvals.js')
const { noteGrantMergeInFlight, resetGrantMergeMarkers, decideMergeAutoDeploy, grantMergeReasonPrefix } = await import('../services/merge-deploy-gate.js')

const REPO = 'your-org/operationkit'
const ADMIN = { id: 1, username: 'operator' }
const OTHER_ADMIN = { id: 2, username: 'pat' }
const BOT = 'Operation Kit Dev'
const WS = 'operationkit'

let server: http.Server
let baseUrl: string
let seq = 7000
let logSpy: ReturnType<typeof vi.spyOn>

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'admin')`).run(ADMIN.id, ADMIN.username)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'admin')`).run(OTHER_ADMIN.id, OTHER_ADMIN.username)
  const app = express()
  app.use('/api/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }), githubWebhookRouter)
  await new Promise<void>(r => { server = app.listen(0, () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_SPOOL, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  for (const t of ['delegation_grants', 'delegation_audit', 'changelog_entries', 'objectives']) db.prepare(`DELETE FROM ${t}`).run()
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_deploy_enabled', '1')").run()
  resetDeliveryDedupe()
  resetGrantMergeMarkers()
  triggerSpy.mockClear()
  logSpy?.mockRestore()
  logSpy = vi.spyOn(console, 'log')
})

const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString()

function grant(actions: string[], grantor = ADMIN, bot = BOT, workspace = WS) {
  return createGrant(getDb(), { grantor, botName: bot, agentSlug: 'operation-kit-dev', workspace, actions, expiresAt: inAWeek(), allowedWorkspaces: [workspace] })
}

/** What runGrantApprovedMerge writes after a successful grant merge. */
function grantMergeAudit(grantId: number, pr: number, cardId = 901400) {
  writeDelegationAudit(getDb(), {
    event: 'approval_used', grant_id: grantId, objective_id: cardId, workspace: WS, bot_name: BOT, action: 'merge',
    actor: 'operator', agent_key_id: null, agent_key_label: 'chat:operation-kit-dev',
    reason: `${grantMergeReasonPrefix(REPO, pr)}at abc1234; all 3 check(s) green`,
  })
}

async function merged(pr: number, opts: { mergedBy?: string; baseRef?: string } = {}) {
  const payload = {
    action: 'closed',
    number: pr,
    pull_request: {
      merged: true,
      html_url: `https://github.com/${REPO}/pull/${pr}`,
      merge_commit_sha: 'abc123',
      merged_at: '2026-11-18T09:30:00Z',
      title: 'Ship the thing',
      body: '',
      user: { login: 'm1keluka' },
      merged_by: { login: opts.mergedBy ?? 'm1keluka' },
      labels: [],
      base: { ref: opts.baseRef ?? 'main' },
      head: { ref: 'cc/obj-1-x' },
    },
    repository: { full_name: REPO },
  }
  const raw = JSON.stringify(payload)
  const sig = 'sha256=' + crypto.createHmac('sha256', 'test-webhook-secret').update(Buffer.from(raw, 'utf8')).digest('hex')
  const res = await fetch(`${baseUrl}/api/webhooks/github`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': `d-${pr}-${Math.random()}`, 'x-hub-signature-256': sig },
    body: raw,
  })
  expect(res.status).toBe(200)
}

const logged = (re: RegExp) => logSpy.mock.calls.some((c: unknown[]) => re.test(String(c[0])))

describe('auto-deploy ON', () => {
  it('a PR merged under a merge grant with NO deploy grant does not deploy, and says why', async () => {
    const g = grant(['merge'])
    const pr = ++seq
    grantMergeAudit(g.id, pr)
    await merged(pr)
    expect(triggerSpy).not.toHaveBeenCalled()
    expect(logged(new RegExp(`\\[auto-deploy\\] SKIPPED — ${REPO}#${pr} was merged by bot "${BOT}" under merge grant #${g.id} \\(card #901400\\); no active deploy grant`))).toBe(true)
    expect(logged(/not live until the owner deploys/)).toBe(true)
  })

  it('also when the webhook beats the audit row: the in-flight marker set before `gh pr merge` is enough', async () => {
    const g = grant(['merge'])
    const pr = ++seq
    noteGrantMergeInFlight(REPO, pr, g.id, 901401)
    await merged(pr)
    expect(triggerSpy).not.toHaveBeenCalled()
    expect(logged(/SKIPPED/)).toBe(true)
  })

  it('a PR merged under a merge grant WITH an active deploy grant (same admin, bot, workspace) deploys as today', async () => {
    const g = grant(['merge'])
    const d = grant(['deploy'])
    const pr = ++seq
    grantMergeAudit(g.id, pr)
    await merged(pr)
    expect(triggerSpy).toHaveBeenCalledTimes(1)
    expect(triggerSpy.mock.calls[0][0]).toBe(`PR #${pr} merged to main under merge grant #${g.id}; deploy grant #${d.id}`)
  })

  it('one grant ticking both merge and deploy covers it too', async () => {
    const g = grant(['merge', 'deploy'])
    const pr = ++seq
    grantMergeAudit(g.id, pr)
    await merged(pr)
    expect(triggerSpy).toHaveBeenCalledTimes(1)
  })

  it('a deploy grant that does not match does not count: other admin, other bot, other workspace, revoked', async () => {
    const g = grant(['merge'])
    grant(['deploy'], OTHER_ADMIN)
    grant(['deploy'], ADMIN, 'Some Other Bot')
    grant(['deploy'], ADMIN, BOT, 'your-org')
    const revoked = grant(['deploy'])
    revokeGrant(getDb(), revoked.id, BOT, 'operator')
    const pr = ++seq
    grantMergeAudit(g.id, pr)
    await merged(pr)
    expect(triggerSpy).not.toHaveBeenCalled()
    expect(decideMergeAutoDeploy(getDb(), REPO, pr)).toMatchObject({ deploy: false, reason: 'grant_merge_without_deploy_grant' })
  })

  it('an expired deploy grant does not count', async () => {
    const g = grant(['merge'])
    grant(['deploy'])
    const pr = ++seq
    grantMergeAudit(g.id, pr)
    const later = new Date(Date.now() + 8 * 86_400_000)
    expect(decideMergeAutoDeploy(getDb(), REPO, pr, later)).toMatchObject({ deploy: false })
  })

  it('a PR merged by a person deploys exactly as today (and records who merged it)', async () => {
    grant(['merge']) // a grant existing somewhere changes nothing for a person's merge
    const pr = ++seq
    await merged(pr, { mergedBy: 'operator-human' })
    expect(triggerSpy).toHaveBeenCalledTimes(1)
    expect(triggerSpy.mock.calls[0][0]).toBe(`PR #${pr} merged to main`)
    const row = getDb().prepare('SELECT merged_by FROM changelog_entries WHERE repo = ? AND pr_number = ?').get(REPO, pr) as { merged_by: string }
    expect(row.merged_by).toBe('operator-human')
  })

  it('a grant audit row for ANOTHER PR or repo does not leak onto this one', async () => {
    const g = grant(['merge'])
    const pr = ++seq
    grantMergeAudit(g.id, pr + 1000)
    await merged(pr)
    expect(triggerSpy).toHaveBeenCalledTimes(1)
  })
})

describe('auto-deploy OFF', () => {
  it('is the unchanged dry-run for every merge, grant or not', async () => {
    getDb().prepare("UPDATE settings SET value = '0' WHERE key = 'auto_deploy_enabled'").run()
    const g = grant(['merge'])
    const a = ++seq
    grantMergeAudit(g.id, a)
    await merged(a)
    const b = ++seq
    await merged(b)
    expect(triggerSpy).not.toHaveBeenCalled()
    expect(logged(new RegExp(`\\[auto-deploy\\] DRY-RUN — WOULD auto-deploy \\(PR #${a} → main\\)`))).toBe(true)
    expect(logged(new RegExp(`\\[auto-deploy\\] DRY-RUN — WOULD auto-deploy \\(PR #${b} → main\\)`))).toBe(true)
    expect(logged(/SKIPPED/)).toBe(false)
  })
})
