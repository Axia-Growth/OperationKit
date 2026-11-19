/**
 * obj 901231 — grant-approved merge, end to end over the real routers and the
 * real agent-key guard, with GitHub replaced by a fake `gh`.
 *
 *  1. approval: merge + active grant + verdict pass + CI green + clean PR →
 *     squash-merged (pinned to the checked head commit), THEN the card is done;
 *     the grant use and the merge are audited.
 *  2. verdict not pass → no merge, card not done, clear refusal.
 *  3. CI not green (red, running, unreadable ruleset) → no merge, not done.
 *  4. no active grant → 403, no merge, GitHub never called.
 *  5. auto_merge_enabled stays off; a passing review on its own merges nothing.
 *  6. money-path, project-type and behind/dirty PRs are not merged.
 *  Hardening: a reserved PR (seed: operationkit#645) is refused before
 *  any GitHub call; an empty/unreadable head SHA refuses instead of merging
 *  without --match-head-commit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import type { ReservedPr } from '../services/grant-merge.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grant-merge-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-grant-merge'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grant-merge-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'
// obj 901372: these suites model an install whose SERVER has its own GitHub login,
// so the merge runs through the (faked) server `gh`. The no-credential case is in
// services/grant-merge-github-auth.test.ts.
process.env.GH_TOKEN = 'test-server-login'

// ── fake GitHub ──────────────────────────────────────────────────────────────
interface FakePr {
  state: string
  mergeStateStatus: string
  headSha: string
  rollup: unknown[]
  required: string[] | 'unreadable'
  mergeError?: string
  /** Changed files `gh pr view --json files` returns (obj 901389); 'unreadable' = gh fails. */
  files?: string[] | 'unreadable'
  /** obj 901412: update-branch fails with this message when set. */
  updateError?: string
  /** obj 901412: the head GitHub moves the branch to after an update-branch. */
  updatedHeadSha?: string
  /** obj 901455: commits by sha, as `gh api repos/:repo/commits/:sha` returns them. */
  commits?: Record<string, unknown>
}
const fake: { pr: FakePr; calls: string[][]; statusAtMerge: string | null } = {
  pr: { state: 'OPEN', mergeStateStatus: 'CLEAN', headSha: 'abc1234', rollup: [], required: [] },
  calls: [],
  statusAtMerge: null,
}
let currentCard = 0
let statusReader: (id: number) => string = () => ''

async function fakeExec(file: string, args: string[]): Promise<string> {
  fake.calls.push([file, ...args])
  if (file !== 'gh') throw new Error(`unexpected exec ${file}`)
  const p = fake.pr
  if (args[0] === 'api' && args.some(a => String(a).endsWith('/update-branch'))) {
    if (p.updateError) throw new Error(p.updateError)
    // GitHub merges the base into the branch: a new head, CI not run on it yet.
    p.headSha = p.updatedHeadSha ?? 'def5678'
    p.rollup = [{ name: 'gate', status: 'QUEUED', conclusion: '' }]
    p.mergeStateStatus = 'BLOCKED'
    return JSON.stringify({ message: 'Updating pull request branch.', url: 'https://github.com/acme/app/pull/1' })
  }
  const commitPath = args[0] === 'api' ? /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)$/.exec(String(args[1])) : null
  if (commitPath) {
    const c = p.commits?.[commitPath[1]]
    if (!c) throw new Error('HTTP 404 Not Found')
    return JSON.stringify(c)
  }
  if (args[0] === 'api') {
    if (p.required === 'unreadable') throw new Error('HTTP 500 boom')
    if (String(args[1]).endsWith('/protection')) throw new Error('HTTP 404 Not Found')
    return JSON.stringify(p.required.length ? [{ type: 'required_status_checks', parameters: { required_status_checks: p.required.map(c => ({ context: c })) } }] : [])
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const fields = args[args.indexOf('--json') + 1]
    if (fields === 'state') return p.state
    if (fields === 'headRefOid') return JSON.stringify({ headRefOid: p.headSha })
    if (fields === 'state,mergeStateStatus') return JSON.stringify({ state: p.state, mergeStateStatus: p.mergeStateStatus })
    if (fields === 'files') {
      if (p.files === 'unreadable') throw new Error('HTTP 502')
      return JSON.stringify({ files: (p.files ?? []).map(f => ({ path: f })) })
    }
    return JSON.stringify({ number: Number(args[2]), url: `https://github.com/acme/app/pull/${args[2]}`, headRefOid: p.headSha, baseRefName: 'main', statusCheckRollup: p.rollup, state: p.state })
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    fake.statusAtMerge = statusReader(currentCard)
    if (p.mergeError) throw new Error(p.mergeError)
    p.state = 'MERGED'
    return ''
  }
  throw new Error(`unexpected gh ${args.join(' ')}`)
}

vi.mock('../services/ci-green-gate-github.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defaultExec: (f: string, a: string[]) => fakeExec(f, a) }
})
vi.mock('../services/worktree-reaper.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, scheduleObjectiveWorktreeReap: () => {} }
})
const sendFollowUpMock = vi.fn((sessionId: string) => sessionId)
const spawnReviewerMock = vi.fn(async (_o: unknown) => `reviewer-${Date.now()}`)
vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (s: string) => sendFollowUpMock(s), spawnReviewerSession: (o: unknown) => spawnReviewerMock(o), stopSession: async () => {} }
})
vi.mock('../services/files-touched.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, realGhExec: (args: string[]) => fakeExec('gh', args) }
})

const { initDb, getDb } = await import('../db/index.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { createGrant } = await import('../services/delegated-approvals.js')
const { clearRequiredChecksCache } = await import('../services/ci-green-gate-github.js')
const { isAutoMergeEnabled, decideAutoMerge } = await import('../services/auto-merge.js')
const { ciGreenForMerge, precheckGrantMerge, parseReservedPrs, reservedPrMatch, loadReservedPrs, GRANT_MERGE_RESERVED_SEED } = await import('../services/grant-merge.js')
const { default: objectivesRouter } = await import('./objectives.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const BOT = 'Operation Kit'
let server: http.Server
let baseUrl: string
let botKey = ''

const GREEN = [
  { name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { context: 'harness/test-agent', state: 'PENDING' }, // the harness's own status is never graded
]

async function asBot(p: string, body: unknown) {
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${botKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json }
}

let seq = 0
function card(spec: { title?: string; status?: string; verdict?: string | null; type?: string; pr?: boolean; workspace?: string; prNumber?: number; repo?: string; reviewedSha?: string | null } = {}): number {
  seq += 1
  const n = spec.prNumber ?? 100 + seq
  const repo = spec.repo ?? 'acme/app'
  const id = Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, owner_bot, ai_review_verdict, type, pr_url, pr_number)
     VALUES (?, 'general', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    spec.title ?? `fixture card ${seq}`,
    spec.workspace ?? 'growth',
    OWNER,
    spec.status ?? 'review',
    BOT,
    spec.verdict === undefined ? 'pass' : spec.verdict,
    spec.type ?? 'task',
    spec.pr === false ? null : `https://github.com/${repo}/pull/${n}`,
    spec.pr === false ? null : n,
  ).lastInsertRowid)
  if (spec.reviewedSha) getDb().prepare('UPDATE objectives SET ai_review_head_sha = ? WHERE id = ?').run(spec.reviewedSha, id)
  currentCard = id
  return id
}

const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const merges = () => fake.calls.filter(c => c[1] === 'pr' && c[2] === 'merge')
const updates = () => fake.calls.filter(c => c[1] === 'api' && c.some(a => a.endsWith('/update-branch')))
const lastAudit = (id: number) => getDb().prepare('SELECT * FROM delegation_audit WHERE objective_id = ? ORDER BY id DESC').get(id) as Loose

function grant(actions: string[] = ['merge'], workspace = 'growth') {
  return createGrant(getDb(), {
    grantor: { id: OWNER, username: 'operator' },
    botName: BOT,
    agentSlug: null,
    workspace,
    actions,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    allowedWorkspaces: ['growth', 'other'],
  })
}

const approve = (id: number, extra: Record<string, unknown> = {}) =>
  asBot(`/api/objectives/${id}/message`, { message: 'Review passed and CI is green. Merge it.', approval: 'merge', owner_bot: BOT, ...extra })

async function expectRefused(id: number, status: number, code: string) {
  const r = await approve(id)
  expect(r.status).toBe(status)
  expect(r.json.code).toBe(code)
  expect(r.json.merged === undefined || r.json.merged === false).toBe(true)
  expect(typeof r.json.error).toBe('string')
  expect(merges()).toHaveLength(0)
  expect(statusOf(id)).not.toBe('done')
  expect(sendFollowUpMock).not.toHaveBeenCalled()
  return r
}

beforeAll(async () => {
  initDb()
  statusReader = statusOf
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('growth', 'Growth'), ('other', 'Other')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'growth', 'admin'), (1, 'other', 'admin')`).run()
  const k = createAgentKey({ id: OWNER, role: 'admin' }, { label: 'OpKit', scopes: ['board:read', 'board:write'] })
  if (!k.ok) throw new Error(k.error)
  botKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/objectives', objectivesRouter)
  server = http.createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(() => {
  sendFollowUpMock.mockClear()
  spawnReviewerMock.mockClear()
  clearRequiredChecksCache()
  fake.pr = { state: 'OPEN', mergeStateStatus: 'CLEAN', headSha: 'abc1234', rollup: GREEN, required: ['gate'] }
  fake.calls = []
  fake.statusAtMerge = null
  getDb().prepare('DELETE FROM delegation_grants').run()
  // The live install runs with the background auto-merge switch OFF (card
  // 901231). A fresh schema seeds it '1' (db/schema/gates.ts), so pin it off:
  // every grant merge below has to work with it off and leave it off.
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_merge_enabled', '0')").run()
  getDb().prepare("DELETE FROM settings WHERE key = 'grant_merge_reserved_prs'").run()
  delete process.env.CC_GRANT_MERGE_RESERVED_PRS
})

describe('1. happy path: grant + pass + green + clean → squash-merge, then done', () => {
  it('merges first (card still in review at merge time), then marks done, and audits both', async () => {
    const g = grant()
    const id = card()
    const r = await approve(id)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ merged: true, status: 'done', pr_url: `https://github.com/acme/app/pull/${100 + seq}` })

    expect(merges()).toHaveLength(1)
    const m = merges()[0]
    expect(m).toEqual(expect.arrayContaining(['--squash', '--delete-branch', '--repo', 'acme/app', '--match-head-commit', 'abc1234']))
    expect(fake.statusAtMerge).toBe('review') // merged BEFORE the card moved
    expect(statusOf(id)).toBe('done')
    expect(sendFollowUpMock).not.toHaveBeenCalled() // a closed card is not respawned

    const used = lastAudit(id)
    expect(used).toMatchObject({ event: 'approval_used', grant_id: g.id, action: 'merge', bot_name: BOT, agent_key_label: 'OpKit' })
    expect(used.reason).toContain('squash-merged acme/app#')
    expect(used.reason).toContain('abc1234')

    const line = getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'grant_merge'").get(id) as Loose
    expect(line.title).toContain(`Squash-merged PR #${100 + seq}`)
    expect(line.title).toContain(`under grant #${g.id}`)

    const moved = getDb().prepare("SELECT * FROM objective_audit WHERE objective_id = ? AND to_status = 'done'").get(id) as Loose
    expect(moved.pathway).toBe(`grant-merge:#${g.id}`)
    expect(String(moved.actor)).toContain(`bot:${BOT}`)
    expect((getDb().prepare('SELECT terminal_by_human FROM objectives WHERE id = ?').get(id) as Loose).terminal_by_human).toBe(0)
  })

  it('obj 901389: the card line says the merge is not live until deployed, and nothing auto-deploys it', async () => {
    const g = grant()
    const id = card()
    fake.pr.files = ['app/client/src/Thing.tsx']
    const r = await approve(id)
    expect(r.status).toBe(200)
    expect(r.json.merge_line).toContain('Merged, not live until deployed: the owner deploys.')
    expect(r.json.merge_line).not.toMatch(/migration/i)
    const line = getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'grant_merge'").get(id) as Loose
    expect(line.title).toContain('Merged, not live until deployed')
    expect(JSON.parse(line.metadata)).toMatchObject({ live: false, migration_paths: [] })
    // The merge is marked as a grant merge, so the merged-PR webhook will not auto-deploy it.
    const { decideMergeAutoDeploy } = await import('../services/merge-deploy-gate.js')
    expect(decideMergeAutoDeploy(getDb(), 'acme/app', 100 + seq)).toMatchObject({ deploy: false, grantMerge: { grantId: g.id, objectiveId: id } })
  })

  it('obj 901389: names the database migration when the PR changes a schema / migrations path', async () => {
    grant()
    const id = card()
    fake.pr.files = ['app/server/src/db/schema/things.ts', 'app/server/src/db/schema/things.test.ts', 'README.md']
    const r = await approve(id)
    expect(r.status).toBe(200)
    expect(r.json.merge_line).toContain('Merged, not live until deployed')
    expect(r.json.merge_line).toContain('⚠ Database migration: this PR changes app/server/src/db/schema/things.ts.')
    const line = getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'grant_merge'").get(id) as Loose
    expect(line.title).toContain('Database migration')
    expect(JSON.parse(line.metadata).migration_paths).toEqual(['app/server/src/db/schema/things.ts'])
  })

  it('obj 901389: says so when the PR files could not be read (never "no migration")', async () => {
    grant()
    const id = card()
    fake.pr.files = 'unreadable'
    const r = await approve(id)
    expect(r.status).toBe(200)
    expect(r.json.merge_line).toContain("Could not read the PR's files to check for a database migration.")
  })

  it('a card with no PR keeps the old behaviour: the DELEGATED message is delivered, nothing is merged', async () => {
    grant()
    const id = card({ pr: false })
    const r = await approve(id)
    expect(r.status).toBe(200)
    expect(merges()).toHaveLength(0)
    expect(statusOf(id)).not.toBe('done')
  })
})

describe('2. verdict not pass → refused', () => {
  for (const verdict of ['fail', 'blocked', null]) {
    it(`verdict ${verdict ?? 'none'}: no merge, card not done, refusal audited`, async () => {
      grant()
      const id = card({ verdict })
      const r = await expectRefused(id, 409, 'review_not_passed')
      expect(r.json.error).toContain('no passing AI review')
      expect(statusOf(id)).toBe('review')
      expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'grant_merge:review_not_passed' })
      expect(fake.calls).toHaveLength(0) // decided before GitHub is even asked
    })
  }
})

describe('3. CI not green → refused', () => {
  it('a required check failed', async () => {
    grant()
    fake.pr.rollup = [{ name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }]
    const id = card()
    const r = await expectRefused(id, 409, 'ci_not_green')
    expect(r.json.error).toContain('gate')
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'grant_merge:ci_not_green' })
  })

  it('a required check is still running', async () => {
    grant()
    fake.pr.rollup = [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '' }]
    await expectRefused(card(), 409, 'ci_not_green')
  })

  it('a required check never ran (no fail-open wait window here)', async () => {
    grant()
    fake.pr.rollup = [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    await expectRefused(card(), 409, 'ci_not_green')
  })

  it('an advisory check is red', async () => {
    grant()
    fake.pr.rollup = [...GREEN, { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }]
    await expectRefused(card(), 409, 'ci_not_green')
  })

  it('the branch ruleset cannot be read (the completion gate would fail open; a merge does not)', async () => {
    grant()
    fake.pr.required = 'unreadable'
    await expectRefused(card(), 409, 'ci_not_green')
  })
})

describe('4. no active grant → 403, no merge', () => {
  it('no grant at all', async () => {
    const id = card()
    await expectRefused(id, 403, 'no_active_grant')
    expect(fake.calls).toHaveLength(0)
  })

  it('a grant for another workspace, or for deploy only, does not count', async () => {
    grant(['merge'], 'other')
    grant(['deploy'])
    await expectRefused(card(), 403, 'no_active_grant')
    expect(fake.calls).toHaveLength(0)
  })

  it('an expired grant does not count', async () => {
    const g = grant()
    getDb().prepare("UPDATE delegation_grants SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(g.id)
    await expectRefused(card(), 403, 'no_active_grant')
  })
})

describe('5. auto_merge_enabled stays off; a passing review alone merges nothing', () => {
  it('the switch is off and is not turned on by a grant merge', async () => {
    expect(isAutoMergeEnabled()).toBe(false)
    grant()
    expect((await approve(card())).status).toBe(200)
    expect(isAutoMergeEnabled()).toBe(false)
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'auto_merge_enabled'").get() as Loose
    expect(row.value).toBe('0')
  })

  it('with the switch off, the background policy for a passing, green PR is a dry-run, not a merge', () => {
    const d = decideAutoMerge({ enabled: isAutoMergeEnabled(), hasPr: true, prNumber: 1, harnessStatus: 'success', reviewVerdict: 'pass', objectiveType: 'task' })
    expect(d.action).toBe('dry-run')
  })

  it('a bot message without approval: merge on a passing, green card does not merge or close it', async () => {
    grant()
    const id = card()
    const r = await asBot(`/api/objectives/${id}/message`, { message: 'Looks good to me.' })
    expect(r.status).toBe(200)
    expect(merges()).toHaveLength(0)
    expect(statusOf(id)).not.toBe('done')
  })
})

describe('6. money-path, project and unsafe PRs are not merged', () => {
  it('money path', async () => {
    grant()
    const id = card({ title: 'Fix Stripe payout rounding' })
    await expectRefused(id, 409, 'money_path')
    expect(fake.calls).toHaveLength(0)
  })

  it('project-type card', async () => {
    grant()
    await expectRefused(card({ type: 'project' }), 409, 'project_card')
  })

  // BEHIND is no longer refused outright: obj 901412 updates the branch (see below).
  for (const state of ['DIRTY', 'BLOCKED', 'UNKNOWN']) {
    it(`PR mergeStateStatus ${state}`, async () => {
      grant()
      fake.pr.mergeStateStatus = state
      const r = await expectRefused(card(), 409, 'pr_not_mergeable')
      expect(r.json.error).toContain(state)
      expect(updates()).toHaveLength(0) // obj 901412: only BEHIND updates the branch
    })
  }

  it('a PR that is already closed', async () => {
    grant()
    fake.pr.state = 'CLOSED'
    await expectRefused(card(), 409, 'pr_not_open')
  })

  it('a PR merged by hand on GitHub → nothing is merged, the card is closed (obj 901454)', async () => {
    grant()
    fake.pr.state = 'MERGED'
    fake.pr.mergeStateStatus = 'UNKNOWN'
    fake.pr.mergeError = 'must not be called: the PR is already merged'
    const id = card()
    const r = await approve(id)
    expect(r.json.code, JSON.stringify(r.json)).toBeUndefined()
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ merged: true, already_merged: true })
    expect(r.json.merge_line).toContain('already merged on GitHub')
    expect(merges()).toHaveLength(0)
    expect(statusOf(id)).toBe('done')
    expect(lastAudit(id)).toMatchObject({ event: 'approval_used', reason: expect.stringContaining('grant_merge:already_merged') })
    const audit = getDb().prepare("SELECT pathway FROM objective_audit WHERE objective_id = ? AND to_status = 'done'").get(id) as Loose
    expect(audit?.pathway).toMatch(/^grant-merge:#/)
  })

  it('a card whose worker is still running', async () => {
    grant()
    await expectRefused(card({ status: 'working' }), 409, 'not_in_review')
  })

  it('GitHub refuses the merge (e.g. a push moved the head) → the card is not closed', async () => {
    grant()
    fake.pr.mergeError = 'Head branch was modified'
    const id = card()
    const r = await approve(id)
    expect(r.status).toBe(502)
    expect(r.json.code).toBe('merge_failed')
    expect(statusOf(id)).toBe('review')
  })
})

describe('reserved PRs are never merged under a grant', () => {
  it('operationkit PR 645 with an active grant, a pass verdict and green CI is still refused, before any GitHub call', async () => {
    grant()
    const id = card({ prNumber: 645, repo: 'your-org/operationkit' })
    const r = await expectRefused(id, 409, 'reserved_pr')
    expect(r.json.error).toContain('645')
    expect(r.json.error).toContain('reserved')
    expect(fake.calls).toHaveLength(0)
    expect(statusOf(id)).toBe('review')
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'grant_merge:reserved_pr' })
  })

  it('the server-side setting adds reserved PRs; the 645 seed cannot be configured away', async () => {
    grant()
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('grant_merge_reserved_prs', 'acme/app#777')").run()
    await expectRefused(card({ prNumber: 777 }), 409, 'reserved_pr')
    expect(fake.calls).toHaveLength(0)
    // An empty setting does not drop the seed.
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('grant_merge_reserved_prs', '')").run()
    expect(loadReservedPrs()).toEqual(expect.arrayContaining([...GRANT_MERGE_RESERVED_SEED]))
    await expectRefused(card({ prNumber: 645, repo: 'your-org/operationkit' }), 409, 'reserved_pr')
  })

  it('the env adds reserved PRs too', async () => {
    grant()
    process.env.CC_GRANT_MERGE_RESERVED_PRS = 'app#778'
    await expectRefused(card({ prNumber: 778 }), 409, 'reserved_pr')
  })

  it('PR 645 in an unrelated repo is not caught by the repo-scoped seed', () => {
    expect(reservedPrMatch({ pr_url: 'https://github.com/acme/app/pull/645', pr_number: 645 }, GRANT_MERGE_RESERVED_SEED)).toBeNull()
    expect(reservedPrMatch({ pr_url: 'https://github.com/your-org/operationkit/pull/645', pr_number: 645 }, GRANT_MERGE_RESERVED_SEED)).not.toBeNull()
    // pr_url and pr_number disagree → either being reserved is enough.
    expect(reservedPrMatch({ pr_url: 'https://github.com/your-org/operationkit/pull/645', pr_number: 12 }, GRANT_MERGE_RESERVED_SEED)).not.toBeNull()
    // No readable repo → fail closed on the number.
    expect(reservedPrMatch({ pr_url: null, pr_number: 645 }, GRANT_MERGE_RESERVED_SEED)).not.toBeNull()
  })

  // obj 901326: the published tree (which the live host runs) must still block the
  // PRIVATE repo's PR 645. The literal on the next line is shielded from the publish
  // transform (scripts/oss-reserved-pr-shield.txt), so this assertion ships verbatim
  // and fails in the public tree if the private form is ever rewritten again.
  const PRIVATE_645: ReservedPr = { repo: 'command-center-infra', number: 645 }
  it('the seed reserves PR 645 in BOTH the private repo and operationkit, by URL', () => {
    expect(GRANT_MERGE_RESERVED_SEED).toContainEqual(PRIVATE_645)
    expect(GRANT_MERGE_RESERVED_SEED).toContainEqual({ repo: 'operationkit', number: 645 })
    expect(PRIVATE_645.repo).not.toBe('operationkit')
    for (const owner of ['some-org', 'm1keluka']) {
      const priv = `https://github.com/${owner}/${PRIVATE_645.repo}/pull/645`
      expect(reservedPrMatch({ pr_url: priv, pr_number: 645 }, GRANT_MERGE_RESERVED_SEED)).toEqual(PRIVATE_645)
      expect(reservedPrMatch({ pr_url: priv, pr_number: null }, GRANT_MERGE_RESERVED_SEED)).toEqual(PRIVATE_645)
      const pub = `https://github.com/${owner}/OperationKit/pull/645`
      expect(reservedPrMatch({ pr_url: pub, pr_number: 645 }, GRANT_MERGE_RESERVED_SEED)).not.toBeNull()
    }
  })

  it('parseReservedPrs accepts owner/repo#N, repo#N, #N, N and ignores junk', () => {
    expect(parseReservedPrs('Acme/App#1, app#2 #3 4; nope, x#y')).toEqual([
      { repo: 'acme/app', number: 1 }, { repo: 'app', number: 2 }, { repo: null, number: 3 }, { repo: null, number: 4 },
    ])
  })
})

describe('an empty or unreadable head SHA refuses the merge', () => {
  for (const sha of ['', '   ', 'not-a-sha']) {
    it(`head SHA ${JSON.stringify(sha)}: no merge (never without --match-head-commit), card not done`, async () => {
      grant()
      fake.pr.headSha = sha
      const id = card()
      const r = await expectRefused(id, 502, 'head_sha_unreadable')
      expect(r.json.error).toContain('head commit')
      expect(statusOf(id)).toBe('review')
      expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'grant_merge:head_sha_unreadable' })
    })
  }

  it('a missing headRefOid field also refuses', async () => {
    grant()
    fake.pr.headSha = undefined as unknown as string
    await expectRefused(card(), 502, 'head_sha_unreadable')
  })
})

describe('pure pieces', () => {
  it('ciGreenForMerge: zero checks and harness-only are not green', () => {
    expect(ciGreenForMerge({ contexts: [], source: 'none' }, []).green).toBe(false)
    expect(ciGreenForMerge({ contexts: [], source: 'none' }, [{ context: 'harness/test-agent', state: 'SUCCESS' }]).green).toBe(false)
    expect(ciGreenForMerge({ contexts: ['gate'], source: 'ruleset' }, GREEN as Loose).green).toBe(true)
    expect(ciGreenForMerge({ contexts: [], source: 'none' }, GREEN as Loose).green).toBe(true)
  })

  it('precheckGrantMerge: strategy and missing PR refuse', () => {
    const base = { id: 1, title: 't', description: '', status: 'review', type: 'task', workspace: 'growth', project: 'p', pr_url: 'https://github.com/a/b/pull/1', pr_number: 1, is_strategy: 0, ai_review_verdict: 'pass' } as Loose
    expect(precheckGrantMerge(base)).toBeNull()
    expect(precheckGrantMerge({ ...base, is_strategy: 1 })?.code).toBe('strategy')
    expect(precheckGrantMerge({ ...base, pr_number: null })?.code).toBe('no_pr')
  })
})

describe('7. BEHIND: the tool updates the branch itself, then merges only a green, CLEAN new head (obj 901412)', () => {
  it('calls GitHub update-branch pinned to the head it read, never merges the old head, and returns branch_updated_ci_pending', async () => {
    const g = grant()
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.pr.headSha = 'abc1234'
    const id = card()
    const r = await approve(id)
    expect(r.status).toBe(202)
    expect(r.json.code).toBe('branch_updated_ci_pending')
    expect(r.json.merged).toBe(false)
    expect(r.json.error).toContain('was behind main')
    expect(r.json.error).toContain('Nothing was merged')

    expect(updates()).toHaveLength(1)
    const u = updates()[0]
    expect(u).toEqual(expect.arrayContaining(['--method', 'PUT', `repos/acme/app/pulls/${100 + seq}/update-branch`, '-f', 'expected_head_sha=abc1234']))
    expect(u.join(' ')).not.toMatch(/rebase|force/)
    expect(merges()).toHaveLength(0) // the old head is never merged
    expect(statusOf(id)).toBe('review') // card not closed
    expect(sendFollowUpMock).not.toHaveBeenCalled()

    // The same audit trail the merge uses: delegation_audit + a card line.
    expect(lastAudit(id)).toMatchObject({ event: 'approval_used', grant_id: g.id, action: 'merge', reason: 'grant_merge:branch_updated_ci_pending' })
    const line = getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'grant_merge_branch_update'").get(id) as Loose
    expect(line.title).toContain(`Updated PR #${100 + seq}`)
    expect(JSON.parse(line.metadata)).toMatchObject({ repo: 'acme/app', previous_head_sha: 'abc1234', base_ref: 'main' })
  })

  it('a second approval while CI runs on the new head merges nothing; once green and CLEAN it merges pinned to the NEW head', async () => {
    grant()
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.pr.headSha = 'abc1234'
    fake.pr.updatedHeadSha = 'fedcba987654'
    // obj 901455: the pass read abc1234; the only commit after it is GitHub's update-branch merge.
    fake.pr.commits = { fedcba987654: updateBranchMerge('fedcba987654', 'abc1234') }
    const id = card({ reviewedSha: 'abc1234' })
    expect((await approve(id)).status).toBe(202)
    expect(fake.pr.headSha).toBe('fedcba987654')

    // CI on the new head has not passed yet → refused, no merge, no second update.
    const pending = await approve(id)
    expect(pending.status).toBe(409)
    expect(pending.json.code).toBe('ci_not_green')
    expect(merges()).toHaveLength(0)
    expect(updates()).toHaveLength(1)
    expect(statusOf(id)).toBe('review')

    // CI green on the new head and GitHub says CLEAN → merge, pinned to it.
    fake.pr.rollup = GREEN
    fake.pr.mergeStateStatus = 'CLEAN'
    const ok = await approve(id)
    expect(ok.status).toBe(200)
    expect(ok.json.merged).toBe(true)
    expect(merges()).toHaveLength(1)
    const m = merges()[0]
    expect(m[m.indexOf('--match-head-commit') + 1]).toBe('fedcba987654')
    expect(m).not.toContain('abc1234')
    expect(statusOf(id)).toBe('done')
  })

  it('BEHIND with CI red on the current head is refused as ci_not_green, with no update', async () => {
    grant()
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.pr.rollup = [{ name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }]
    await expectRefused(card(), 409, 'ci_not_green')
    expect(updates()).toHaveLength(0)
  })

  it('a failed update-branch call is refused with a clear reason, nothing merged, card not moved', async () => {
    grant()
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.pr.updateError = 'HTTP 422: expected head sha didn’t match current head ref.'
    const id = card()
    const r = await expectRefused(id, 502, 'branch_update_failed')
    expect(r.json.error).toContain('GitHub refused to update the branch')
    expect(r.json.error).toContain('expected head sha')
    expect(updates()).toHaveLength(1)
    expect(statusOf(id)).toBe('review')
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'grant_merge:branch_update_failed' })
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'grant_merge_branch_update'").get(id)).toMatchObject({ n: 0 })
  })

  it('BEHIND with an unreadable head SHA never sends the update unpinned', async () => {
    grant()
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.pr.headSha = ''
    await expectRefused(card(), 502, 'head_sha_unreadable')
    expect(updates()).toHaveLength(0)
  })
})

// ── obj 901455: a pass is tied to the commit the reviewer read ───────────────
function updateBranchMerge(sha: string, firstParent: string, opts: { base?: string; login?: string } = {}) {
  return {
    sha,
    parents: [{ sha: firstParent }, { sha: '0a1b2c3d4e5f' }],
    commit: { message: `Merge branch '${opts.base ?? 'main'}' into cc/obj-1-feature`, committer: { name: 'GitHub', email: 'noreply@github.com' } },
    committer: { login: opts.login ?? 'web-flow' },
  }
}
function workerCommit(sha: string, parent: string) {
  return {
    sha,
    parents: [{ sha: parent }],
    commit: { message: 'fix: change after review', committer: { name: 'worker', email: 'worker@example.com' } },
    committer: { login: 'm1keluka' },
  }
}
const verdictOf = (id: number) => (getDb().prepare('SELECT ai_review_verdict, status, ai_review_session_id FROM objectives WHERE id = ?').get(id) as Loose)

describe('8. the pass must be for the commit being merged (obj 901455)', () => {
  it('pass on the current head commit → merges', async () => {
    grant()
    fake.pr.headSha = 'abc1234'
    const id = card({ reviewedSha: 'abc1234' })
    const r = await approve(id)
    expect(r.status).toBe(200)
    expect(merges()).toHaveLength(1)
    expect(statusOf(id)).toBe('done')
  })

  it('pass on an OLD commit, PR changed by a push since → refused review_stale, pass cleared, fresh review started', async () => {
    const g = grant()
    fake.pr.headSha = 'bad9999'
    fake.pr.commits = { bad9999: workerCommit('bad9999', 'abc1234') }
    const id = card({ reviewedSha: 'abc1234' })
    const r = await expectRefused(id, 409, 'review_stale')
    expect(r.json.error).toContain('abc1234')
    expect(r.json.error).toContain('bad9999')
    expect(r.json.error).toContain('fresh AI review')
    expect(spawnReviewerMock).toHaveBeenCalledTimes(1)
    const row = verdictOf(id)
    expect(row.status).toBe('ai_review')
    expect(row.ai_review_verdict).toBeNull()
    expect(row.ai_review_session_id).toMatch(/^reviewer-/)
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', grant_id: g.id, reason: 'grant_merge:review_stale' })
    const stale = getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'ai_review_stale'").get(id) as Loose
    expect(JSON.parse(stale.metadata)).toMatchObject({ reviewed_head_sha: 'abc1234', pr_head_sha: 'bad9999' })
    // A second approval cannot merge on the cleared pass.
    const again = await approve(id)
    expect(again.status).toBe(409)
    expect(merges()).toHaveLength(0)
  })

  it('pass followed ONLY by GitHub update-branch merges (two of them) → merges, pinned to the new head', async () => {
    grant()
    fake.pr.headSha = 'cafe0002'
    fake.pr.commits = {
      cafe0002: updateBranchMerge('cafe0002', 'cafe0001'),
      cafe0001: updateBranchMerge('cafe0001', 'abc1234'),
    }
    const id = card({ reviewedSha: 'abc1234' })
    const r = await approve(id)
    expect(r.status).toBe(200)
    expect(r.json.merged).toBe(true)
    const m = merges()[0]
    expect(m[m.indexOf('--match-head-commit') + 1]).toBe('cafe0002')
    expect(spawnReviewerMock).not.toHaveBeenCalled()
  })

  it('a worker push ON TOP of an update-branch merge is still stale', async () => {
    grant()
    fake.pr.headSha = 'bad7777'
    fake.pr.commits = {
      bad7777: workerCommit('bad7777', 'cafe0001'),
      cafe0001: updateBranchMerge('cafe0001', 'abc1234'),
    }
    await expectRefused(card({ reviewedSha: 'abc1234' }), 409, 'review_stale')
  })

  it('a merge from another branch, or a merge not made by GitHub, is stale', async () => {
    grant()
    fake.pr.headSha = 'cafe0003'
    fake.pr.commits = { cafe0003: updateBranchMerge('cafe0003', 'abc1234', { base: 'experiment' }) }
    await expectRefused(card({ reviewedSha: 'abc1234' }), 409, 'review_stale')
    fake.pr.commits = { cafe0003: { ...updateBranchMerge('cafe0003', 'abc1234', { login: 'someone' }), commit: { message: "Merge branch 'main' into x", committer: { email: 'someone@example.com' } } } }
    await expectRefused(card({ reviewedSha: 'abc1234' }), 409, 'review_stale')
  })

  it('a commit GitHub will not return counts as moved (fail closed)', async () => {
    grant()
    fake.pr.headSha = 'feed0001'
    fake.pr.commits = {}
    const r = await expectRefused(card({ reviewedSha: 'abc1234' }), 409, 'review_stale')
    expect(r.json.error).toContain('could not be read')
  })

  it('a pass with no recorded commit (from before this check) merges as before', async () => {
    grant()
    fake.pr.headSha = 'bad9999'
    const id = card({ reviewedSha: null })
    expect((await approve(id)).status).toBe(200)
    expect(merges()).toHaveLength(1)
  })
})

describe('8b. recording the reviewed commit (obj 901455)', () => {
  it('captureReviewHeadSha stores the PR head for the CURRENT reviewer only, and the verdict-time fallback never overwrites', async () => {
    const { captureReviewHeadSha } = await import('../services/review-head.js')
    const db = getDb()
    const id = card({ verdict: null, status: 'ai_review' })
    db.prepare("UPDATE objectives SET ai_review_session_id = 'rev-A' WHERE id = ?").run(id)
    const exec = (f: string, a: string[]) => fakeExec(f, a)
    fake.pr.headSha = 'aaaa1111'
    expect(await captureReviewHeadSha(db, { id, pr_url: `https://github.com/acme/app/pull/${100 + seq}`, pr_number: 100 + seq }, 'rev-A', exec)).toBe('aaaa1111')
    // A stale reviewer session cannot stamp the card.
    fake.pr.headSha = 'bbbb2222'
    expect(await captureReviewHeadSha(db, { id, pr_url: `https://github.com/acme/app/pull/${100 + seq}`, pr_number: 100 + seq }, 'rev-OLD', exec)).toBeNull()
    // The verdict-time fallback only fills an empty column.
    expect(await captureReviewHeadSha(db, { id, pr_url: `https://github.com/acme/app/pull/${100 + seq}`, pr_number: 100 + seq }, 'rev-A', exec, { onlyIfEmpty: true })).toBeNull()
    expect((db.prepare('SELECT ai_review_head_sha AS s FROM objectives WHERE id = ?').get(id) as Loose).s).toBe('aaaa1111')
  })

  it('requesting a review resets the recorded commit, then records the new head', async () => {
    const { requestAiReview } = await import('../services/ai-review-backfill.js')
    const db = getDb()
    const id = card({ verdict: null, reviewedSha: 'ddd0000' })
    fake.pr.headSha = 'eee1111'
    const r = await requestAiReview(db, id, { spawnReviewer: async () => 'rev-new', headExec: (f, a) => fakeExec(f, a) })
    expect(r.ok).toBe(true)
    await vi.waitFor(() => expect((db.prepare('SELECT ai_review_head_sha AS s FROM objectives WHERE id = ?').get(id) as Loose).s).toBe('eee1111'))
  })
})
