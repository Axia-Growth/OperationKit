/**
 * obj 901771 — a card filed from a production signal (origin
 * 'production-issue') is merged by a PERSON and never auto-deploys:
 *
 *  - background auto-merge skips it,
 *  - a grant merge (chat tool, `approval: merge`, standing merge — all go
 *    through precheckGrantMerge) refuses it,
 *  - the Dev bot's dev_merge_pr and dev_merge_repo_pr refuse it,
 *  - the merged-PR webhook does not auto-deploy its PR, whoever merged it,
 *  - the worker-end route always sends it to the independent AI reviewer
 *    (never the green lane, and skip_ai_review is ignored).
 * The same cards with any other origin behave exactly as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-production-merge-guards-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-production-merge-guards'

const { initDb, getDb } = await import('../db/index.js')
const { decideAutoMerge } = await import('./auto-merge.js')
const { precheckGrantMerge } = await import('./grant-merge.js')
const { precheckDevMerge } = await import('./dev-ops/merge.js')
const { linkedCardRefusal } = await import('./dev-ops/repo-merge.js')
const { decideMergeAutoDeploy, productionIssueCardForPr } = await import('./merge-deploy-gate.js')
const { decideWorkerEndRoute } = await import('./poller-decisions.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

beforeAll(() => {
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${TMP_DB}${s}`) } catch { /* gone */ }
  }
})

const reviewCard = (origin: string): Loose => ({
  id: 77, title: 'Production issue: checkout 500', description: 'fix it', status: 'review', type: 'bug',
  workspace: 'acme', project: 'storefront', pr_number: 12, pr_url: 'https://github.com/acme/storefront/pull/12',
  is_strategy: 0, ai_review_verdict: 'pass', origin,
})

describe('auto-merge', () => {
  const base = { enabled: true, hasPr: true, prNumber: 12, harnessStatus: 'success' as const, reviewVerdict: 'pass' as const, objectiveType: 'bug', unsafe: false, moneyPath: false }
  it('skips a production-issue fix even when everything is green', () => {
    const d = decideAutoMerge({ ...base, productionIssue: true })
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/a person merges/)
  })
  it('is unchanged for any other card', () => {
    expect(decideAutoMerge(base).action).toBe('merge')
  })
})

describe('grant merge (approval: merge, chat merge tool, standing merge)', () => {
  it('refuses a production-issue card before any GitHub call', () => {
    const r = precheckGrantMerge(reviewCard('production-issue'), [])
    expect(r).toMatchObject({ ok: false, code: 'production_issue', status: 409 })
  })
  it('passes the same card with another origin', () => {
    expect(precheckGrantMerge(reviewCard('agent_chat'), [])).toBeNull()
  })
})

describe('Dev bot merge tools', () => {
  it('dev_merge_pr refuses a production-issue card', () => {
    const r = precheckDevMerge({ ...reviewCard('production-issue'), owner_bot: 'operation-kit-dev' }, [])
    expect(r).toMatchObject({ ok: false, code: 'production_issue' })
  })
  it('dev_merge_repo_pr refuses a PR a production-issue card links', () => {
    expect(linkedCardRefusal([reviewCard('production-issue')])).toMatchObject({ ok: false, code: 'production_issue', objective_id: 77 })
    expect(linkedCardRefusal([reviewCard('manual')])).toBeNull()
  })
})

describe('merged-PR auto-deploy', () => {
  it('never auto-deploys the PR of a production-issue card; other PRs are unchanged', () => {
    const db = getDb()
    const ins = db.prepare("INSERT INTO objectives (title, agent_context, workspace, status, origin, pr_number, pr_url) VALUES (?, 'general', 'acme', 'review', ?, ?, ?)")
    const pi = Number(ins.run('prod fix', 'production-issue', 31, 'https://github.com/Acme/Shop/pull/31').lastInsertRowid)
    ins.run('ordinary', 'manual', 32, 'https://github.com/Acme/Shop/pull/32')

    expect(decideMergeAutoDeploy(db as Loose, 'acme/shop', 31)).toEqual({ deploy: false, reason: 'production_issue_fix', objectiveId: pi })
    expect(decideMergeAutoDeploy(db as Loose, 'acme/shop', 32)).toEqual({ deploy: true, reason: 'not_grant_merge' })
    // Same number in ANOTHER repo is not that card's PR.
    expect(productionIssueCardForPr(db as Loose, 'acme/other', 31)).toBeNull()
    // A card with the number but no URL to tell repos apart fails closed.
    const noUrl = Number(ins.run('prod fix, no url', 'production-issue', 33, null).lastInsertRowid)
    expect(productionIssueCardForPr(db as Loose, 'acme/anything', 33)).toBe(noUrl)
  })
})

describe('worker-end route: the independent review always runs', () => {
  const ctx = { redPath: false, filesKnown: true, uiTouched: false, hasDelegatorParent: false }
  const row = (origin: string, skip = 0): Loose => ({ type: 'bug', create_pr: 1, delegate_mode: 0, pr_number: 12, pr_url: 'https://github.com/a/b/pull/12', routine_id: null, skip_ai_review: skip, origin })

  it('a backend-only production fix goes to ai_review, not the green lane', () => {
    expect(decideWorkerEndRoute(row('manual'), ctx)).toMatchObject({ lane: 'green', status: 'review' })
    expect(decideWorkerEndRoute(row('production-issue'), ctx)).toMatchObject({ lane: 'red', status: 'ai_review' })
  })
  it('skip_ai_review is ignored on a production fix', () => {
    expect(decideWorkerEndRoute(row('production-issue', 1), ctx).status).toBe('ai_review')
  })
})
