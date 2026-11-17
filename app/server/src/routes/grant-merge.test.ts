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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grant-merge-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-grant-merge'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grant-merge-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

// ── fake GitHub ──────────────────────────────────────────────────────────────
interface FakePr {
  state: string
  mergeStateStatus: string
  headSha: string
  rollup: unknown[]
  required: string[] | 'unreadable'
  mergeError?: string
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
  if (args[0] === 'api') {
    if (p.required === 'unreadable') throw new Error('HTTP 500 boom')
    if (String(args[1]).endsWith('/protection')) throw new Error('HTTP 404 Not Found')
    return JSON.stringify(p.required.length ? [{ type: 'required_status_checks', parameters: { required_status_checks: p.required.map(c => ({ context: c })) } }] : [])
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const fields = args[args.indexOf('--json') + 1]
    if (fields === 'state,mergeStateStatus') return JSON.stringify({ state: p.state, mergeStateStatus: p.mergeStateStatus })
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
vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (s: string) => sendFollowUpMock(s) }
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
function card(spec: { title?: string; status?: string; verdict?: string | null; type?: string; pr?: boolean; workspace?: string; prNumber?: number; repo?: string } = {}): number {
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
  currentCard = id
  return id
}

const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const merges = () => fake.calls.filter(c => c[1] === 'pr' && c[2] === 'merge')
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

  for (const state of ['BEHIND', 'DIRTY', 'BLOCKED', 'UNKNOWN']) {
    it(`PR mergeStateStatus ${state}`, async () => {
      grant()
      fake.pr.mergeStateStatus = state
      const r = await expectRefused(card(), 409, 'pr_not_mergeable')
      expect(r.json.error).toContain(state)
    })
  }

  it('a PR that is already closed', async () => {
    grant()
    fake.pr.state = 'CLOSED'
    await expectRefused(card(), 409, 'pr_not_open')
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
