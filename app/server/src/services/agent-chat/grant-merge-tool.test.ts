/**
 * obj 901347 — a chat bot with an active merge grant merges a ready PR FROM CHAT.
 *
 * Through the real chat tool entry point (`runChatTool` / `toolSpecsForContext`),
 * a real temp SQLite DB, the real grant check (`decideChatBotApproval` →
 * `grantDecision`, shared with the card-message path), the real merge path
 * (`runGrantApprovedMerge` → `mergeUnderGrant`) and the real status handler,
 * with GitHub replaced by a fake `gh`:
 *
 *  1. happy path: own card, active merge grant, review + pass + CI green + clean
 *     → squash-merge pinned to the checked head commit, card done,
 *     `approval_used` + `grant_merge` card line;
 *  2. no grant / expired grant / revoked grant / a deploy-only grant / a grant
 *     from a different person → refused, nothing merged, `approval_denied`;
 *  3. failed or missing AI review, CI red / pending → refused, nothing merged;
 *  4. reserved PR 645 (seed) and a setting-reserved PR → refused before ANY
 *     GitHub call;
 *  5. another bot's card → refused (even with a grant);
 *  6. Full access without a merge grant → no tool offered, call refused;
 *  7. a card-wake turn and a bot-to-bot wake turn cannot reach the tool;
 *  8. `auto_merge_enabled` is never read or written.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grant-merge-tool-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
// obj 901372: these suites model an install whose SERVER has its own GitHub login,
// so the merge runs through the (faked) server `gh`. The no-credential case is in
// services/grant-merge-github-auth.test.ts.
process.env.GH_TOKEN = 'test-server-login'
process.env.JWT_SECRET = 'test-secret-grant-merge-tool'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grant-merge-tool-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grant-merge-tool-kb-'))

// ── fake GitHub (same shape as routes/grant-merge.test.ts) ───────────────────
interface FakePr {
  state: string
  mergeStateStatus: string
  headSha: string
  rollup: unknown[]
  required: string[]
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
    p.state = 'MERGED'
    return ''
  }
  throw new Error(`unexpected gh ${args.join(' ')}`)
}

vi.mock('../ci-green-gate-github.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defaultExec: (f: string, a: string[]) => fakeExec(f, a) }
})
vi.mock('../worktree-reaper.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, scheduleObjectiveWorktreeReap: () => {} }
})
const sendFollowUpMock = vi.fn((sessionId: string) => sessionId)
vi.mock('../session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (s: string) => sendFollowUpMock(s) }
})

const { initDb, getDb } = await import('../../db/index.js')
const { createGrant, revokeGrant } = await import('../delegated-approvals.js')
const { clearRequiredChecksCache } = await import('../ci-green-gate-github.js')
const { clearInstalledChatBotCache } = await import('../bots/card-owner.js')
const { runChatTool, toolSpecsForContext } = await import('./tools.js')
const { chatBotGrantName, GRANT_MERGE_FN } = await import('./grant-merge-tool.js')
const { seedExistingBotsOnce, grantBotWorkspace } = await import('./bot-workspaces.js')
const { setFullAccess } = await import('./bot-full-access.js')
const { createWorkspace } = await import('../workspaces.js')

type Agent = import('./agent-defs.js').ChatAgent
type Ctx = import('./tools.js').ToolContext
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const MEMBER = 2
const GROWTH = 'growth'

function bot(slug: string): Agent {
  return {
    slug, name: slug, description: '', avatar: '', colour: 'blue', system_prompt: 'You help.',
    knowledge_folders: [], tools: ['get_objective', 'list_objectives'], model: null, provider: null, schedules: [],
    version: null, author: null, how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
  }
}
const DEV = bot('dev')
const OTHER = bot('other-bot')
const FA = bot('fa-bot')

function ctx(agent: Agent, extra: Partial<Ctx> = {}): Ctx {
  return { userId: OWNER, username: 'operator', workspace: GROWTH, agent, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } as Loose, ...extra }
}

const GREEN = [
  { name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { context: 'harness/test-agent', state: 'PENDING' },
]

let seq = 0
function card(spec: { owner?: string; status?: string; verdict?: string | null; prNumber?: number; repo?: string; createdBy?: number } = {}): number {
  seq += 1
  const n = spec.prNumber ?? 300 + seq
  const repo = spec.repo ?? 'acme/app'
  const id = Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, ai_review_verdict, type, pr_url, pr_number)
     VALUES (?, ?, ?, ?, ?, ?, 'task', ?, ?)`,
  ).run(
    `chat merge fixture ${seq}`,
    spec.owner ?? 'dev',
    GROWTH,
    spec.createdBy ?? OWNER,
    spec.status ?? 'review',
    spec.verdict === undefined ? 'pass' : spec.verdict,
    `https://github.com/${repo}/pull/${n}`,
    n,
  ).lastInsertRowid)
  currentCard = id
  return id
}

const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const merges = () => fake.calls.filter(c => c[1] === 'pr' && c[2] === 'merge')
const lastAudit = (id: number) => getDb().prepare('SELECT * FROM delegation_audit WHERE objective_id = ? ORDER BY id DESC').get(id) as Loose
const autoMergeSetting = () => (getDb().prepare("SELECT value FROM settings WHERE key = 'auto_merge_enabled'").get() as { value: string } | undefined)?.value

function grant(agent: Agent = DEV, opts: { actions?: string[]; grantor?: { id: number; username: string }; now?: Date; expiresAt?: string } = {}) {
  const botName = chatBotGrantName(agent)
  if (!botName) throw new Error(`no grant identity for ${agent.slug}`)
  return createGrant(getDb(), {
    grantor: opts.grantor ?? { id: OWNER, username: 'operator' },
    botName,
    agentSlug: agent.slug,
    workspace: GROWTH,
    actions: opts.actions ?? ['merge'],
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
    allowedWorkspaces: [GROWTH],
    now: opts.now,
  })
}

const merge = (id: number, c: Ctx = ctx(DEV)) => runChatTool(c, GRANT_MERGE_FN, { id, note: 'Review passed and CI is green.' })
const offered = (c: Ctx) => toolSpecsForContext(c).some(s => s.function.name === GRANT_MERGE_FN)

async function expectRefused(id: number, code: string, c: Ctx = ctx(DEV)) {
  const out = await merge(id, c)
  const r = out.result as Loose
  expect(r.merged).toBe(false)
  expect(r.code).toBe(code)
  expect(typeof r.error).toBe('string')
  expect(merges()).toHaveLength(0)
  expect(statusOf(id)).not.toBe('done')
  return r
}

beforeAll(() => {
  for (const slug of ['dev', 'other-bot', 'fa-bot']) {
    fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
    fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${slug}\nsystem_prompt: You are ${slug}.\nknowledge_folders: []\ntools: [get_objective, list_objectives]\nversion: 1.0.0\nauthor: Test\n`)
  }
  clearInstalledChatBotCache()
  initDb()
  statusReader = statusOf
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(OWNER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'sam', 'x', 'member')`).run(MEMBER)
  createWorkspace({ slug: GROWTH, name: 'Growth', default_agent_pool: ['general'] })
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(MEMBER, GROWTH)
  seedExistingBotsOnce(['dev', 'other-bot', 'fa-bot'])
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

beforeEach(() => {
  sendFollowUpMock.mockClear()
  clearRequiredChecksCache()
  fake.pr = { state: 'OPEN', mergeStateStatus: 'CLEAN', headSha: 'abc1234', rollup: GREEN, required: ['gate'] }
  fake.calls = []
  fake.statusAtMerge = null
  getDb().prepare('DELETE FROM delegation_grants').run()
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_merge_enabled', '0')").run()
  getDb().prepare("DELETE FROM settings WHERE key = 'grant_merge_reserved_prs'").run()
  delete process.env.CC_GRANT_MERGE_RESERVED_PRS
})

describe('1. happy path: own card + active merge grant + pass + green + clean → merged from chat', () => {
  it('offers the tool, squash-merges pinned to the checked SHA, then marks done and audits', async () => {
    const g = grant()
    const id = card()
    expect(offered(ctx(DEV))).toBe(true)

    const out = await merge(id)
    const r = out.result as Loose
    expect(r).toMatchObject({ merged: true, done: true, pr_url: `https://github.com/acme/app/pull/${300 + seq}` })
    expect(out.objective_id).toBe(id)
    expect(out.summary).toContain(`under grant #${g.id}`)

    expect(merges()).toHaveLength(1)
    expect(merges()[0]).toEqual(expect.arrayContaining(['--squash', '--delete-branch', '--repo', 'acme/app', '--match-head-commit', 'abc1234']))
    expect(fake.statusAtMerge).toBe('review') // merged BEFORE the card moved
    expect(statusOf(id)).toBe('done')

    const used = lastAudit(id)
    expect(used).toMatchObject({ event: 'approval_used', grant_id: g.id, action: 'merge', bot_name: 'dev', agent_key_id: null, agent_key_label: 'chat:dev', actor: 'operator' })
    expect(used.reason).toContain('grant_merge:squash-merged acme/app#')

    const line = getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'grant_merge'").get(id) as Loose
    expect(line.title).toContain(`Squash-merged PR #${300 + seq}`)
    expect(line.title).toContain(`under grant #${g.id}`)

    const moved = getDb().prepare("SELECT * FROM objective_audit WHERE objective_id = ? AND to_status = 'done'").get(id) as Loose
    expect(moved.pathway).toBe(`grant-merge:#${g.id}`)
    expect(String(moved.actor)).toContain('bot:dev (chat:dev)')
    expect(autoMergeSetting()).toBe('0') // never touched
  })
})

describe('1b. the server has no GitHub credential (obj 901372)', () => {
  it('refuses in plain words, audits it, runs no gh and leaves the card in review', async () => {
    const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR }
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    process.env.GH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-no-gh-login-')) // no hosts.yml
    try {
      const g = grant()
      const id = card()
      const out = await merge(id)
      const r = out.result as Loose
      expect(r.merged).toBe(false)
      expect(r.code).toBe('github_credential_missing')
      expect(r.error).toContain('The server has no GitHub credential for merges')
      expect(r.error).not.toMatch(/gh auth login/)
      expect(fake.calls).toEqual([])
      expect(statusOf(id)).toBe('review')
      expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', grant_id: g.id, reason: 'grant_merge:github_credential_missing' })
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('2. no / expired / revoked / wrong grant → refused, nothing merged, approval_denied', () => {
  it('no grant at all: tool not offered, and a direct call is refused', async () => {
    const id = card()
    expect(offered(ctx(DEV))).toBe(false)
    await expectRefused(id, 'no_active_grant')
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'no_active_grant', agent_key_label: 'chat:dev' })
    expect(fake.calls).toHaveLength(0)
  })

  it('an expired grant never counts', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000)
    grant(DEV, { now: past, expiresAt: new Date(past.getTime() + 86_400_000).toISOString() })
    const id = card()
    expect(offered(ctx(DEV))).toBe(false)
    await expectRefused(id, 'no_active_grant')
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'no_active_grant' })
  })

  it('a revoked grant never counts', async () => {
    const g = grant()
    revokeGrant(getDb(), g.id, 'dev', 'operator')
    const id = card()
    expect(offered(ctx(DEV))).toBe(false)
    await expectRefused(id, 'no_active_grant')
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'no_active_grant' })
  })

  it('a grant that does not tick merge (deploy only) does not merge', async () => {
    grant(DEV, { actions: ['deploy'] })
    await expectRefused(card(), 'no_active_grant')
  })

  it("the owner's grant does not let a different person merge through the bot", async () => {
    grant()
    const id = card({ createdBy: MEMBER }) // the member can see it: this is the grant check, not visibility
    const asMember = ctx(DEV, { userId: MEMBER, username: 'sam' })
    expect(offered(asMember)).toBe(false)
    await expectRefused(id, 'no_active_grant', asMember)
  })
})

describe('3. failed / missing review, red or pending CI → refused', () => {
  for (const verdict of ['fail', 'blocked', null]) {
    it(`verdict ${verdict ?? 'none'}: no merge, refusal audited, GitHub never asked`, async () => {
      grant()
      const id = card({ verdict })
      await expectRefused(id, 'review_not_passed')
      expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'grant_merge:review_not_passed', agent_key_label: 'chat:dev' })
      expect(fake.calls).toHaveLength(0)
    })
  }

  it('card not in review', async () => {
    grant()
    await expectRefused(card({ status: 'working' }), 'not_in_review')
  })

  it('a required check failed', async () => {
    grant()
    fake.pr.rollup = [{ name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }]
    const id = card()
    await expectRefused(id, 'ci_not_green')
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'grant_merge:ci_not_green' })
  })

  it('a check is still running', async () => {
    grant()
    fake.pr.rollup = [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '' }]
    await expectRefused(card(), 'ci_not_green')
  })

  it('a PR that is dirty (conflict) is not merged', async () => {
    grant()
    fake.pr.mergeStateStatus = 'DIRTY'
    await expectRefused(card(), 'pr_not_mergeable')
  })

  // obj 901412: BEHIND is updated from main (GitHub update-branch), not merged.
  it('a PR that is behind: the branch is updated, nothing is merged, the card stays in review', async () => {
    grant()
    fake.pr.mergeStateStatus = 'BEHIND'
    const id = card()
    const r = await expectRefused(id, 'branch_updated_ci_pending')
    expect(r.error).toContain('CI is now running on the new head')
    expect(fake.calls.filter(c => c[1] === 'api' && c.some(a => a.endsWith('/update-branch')))).toHaveLength(1)
    expect(lastAudit(id)).toMatchObject({ event: 'approval_used', reason: 'grant_merge:branch_updated_ci_pending' })
  })
})

describe('4. reserved PRs stay blocked — before any GitHub call', () => {
  it('operationkit#645 (built-in seed)', async () => {
    grant()
    const id = card({ prNumber: 645, repo: 'your-org/operationkit' })
    const r = await expectRefused(id, 'reserved_pr')
    expect(r.error).toContain('645')
    expect(fake.calls).toHaveLength(0)
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'grant_merge:reserved_pr' })
  })

  it('a PR reserved by the server-side setting', async () => {
    grant()
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('grant_merge_reserved_prs', 'acme/app#777')").run()
    await expectRefused(card({ prNumber: 777 }), 'reserved_pr')
    expect(fake.calls).toHaveLength(0)
  })
})

describe("5. another bot's card → refused", () => {
  it('dev holds a merge grant but cannot merge a card other-bot owns', async () => {
    grant()
    const id = card({ owner: 'other-bot' })
    await expectRefused(id, 'not_owned')
    expect(lastAudit(id)).toMatchObject({ event: 'approval_denied', reason: 'grant_merge:not_owned', bot_name: 'dev' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('6. Full access is not a merge grant', () => {
  it('a bot with Full access in the workspace but no merge grant is not offered the tool and is refused', async () => {
    grantBotWorkspace('fa-bot', GROWTH, 'operator')
    setFullAccess('fa-bot', GROWTH, { enabled: true }, { id: OWNER, username: 'operator' })
    const id = card({ owner: 'fa-bot' })
    expect(offered(ctx(FA))).toBe(false)
    await expectRefused(id, 'no_active_grant', ctx(FA))
    expect(fake.calls).toHaveLength(0)
  })
})

describe('7. wake turns cannot reach the merge tool', () => {
  it('a card-wake turn is confined to the own-card tools', async () => {
    grant()
    const id = card()
    const wake = ctx(DEV, { cardWake: { wakeId: 1, objectiveId: id, workspace: GROWTH } })
    await expect(runChatTool(wake, GRANT_MERGE_FN, { id })).rejects.toThrow()
    expect(merges()).toHaveLength(0)
    expect(statusOf(id)).toBe('review')
  })

  it('a bot-to-bot wake turn is not offered the tool and is refused', async () => {
    grant()
    const id = card()
    const wake = ctx(DEV, { botWake: { conversationId: 1, depth: 1 } })
    expect(offered(wake)).toBe(false)
    await expect(runChatTool(wake, GRANT_MERGE_FN, { id })).rejects.toThrow(/wake/)
    expect(merges()).toHaveLength(0)
  })
})

describe('8. other bots are unaffected', () => {
  it('other-bot is not offered the tool because only dev holds a grant', () => {
    grant()
    expect(offered(ctx(OTHER))).toBe(false)
  })
})
