/**
 * obj 901492 — Operation Kit Dev "GitHub repo rights": merge a PR by repo and
 * number (no card needed, the public sync PR included) and update a branch in a
 * way that really starts CI. Driven through the real chat tool entry point
 * (`runChatTool` / `toolSpecsForContext`), a real temp SQLite DB and the real
 * status handler, with GitHub replaced by a fake `gh`.
 *
 *  1. the grant: OFF by default, per repo, only Operation Kit Dev, only an admin
 *     typing in the browser, never a wake; a repo that is not granted refuses;
 *  2. the merge path: no card linked → merged and a card is filed; a linked card
 *     is used and closed; pinned to the graded head; both repos;
 *  3. CI: not green refuses; "still running" is told apart from "never started";
 *  4. update + CI restart: update-branch pinned to the read head, the tick
 *     restarts a cancelled run, fails loudly when no run ever appears, and
 *     merges only GitHub's own update commit once green;
 *  5. walls: reserved PRs (never merged, updated or re-run, before any GitHub
 *     call), reserved content in a sync PR, CodeQL high outside test files, the
 *     AI-review rule on a linked card, forks / drafts, no admin bypass, a
 *     person's review conversation is never resolved;
 *  6. nothing else is touched: every GitHub call is on a short allow-list (no
 *     repo setting, no branch protection, no deploy);
 *  7. every merge and every refusal writes a dev_ops_audit row with a reason,
 *     and no credential value reaches a result or the audit table.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-repo-merge-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
const FAKE_TOKEN = 'envtok_9f8e7d6c5b4a39281706' // allow-listed fake in scripts/oss-gitleaks.toml
process.env.GH_TOKEN = FAKE_TOKEN
process.env.JWT_SECRET = 'test-secret-repo-merge'
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString('base64')
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-repo-merge-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-repo-merge-kb-'))

const PRIVATE = 'acme/app'
const UNGRANTED = 'acme/other'

// ── fake GitHub ──────────────────────────────────────────────────────────────
interface FakePr {
  state: string; mergeStateStatus: string; headSha: string; rollup: unknown[]; required: string[]
  title: string; body: string; headRef: string; draft: boolean; fork: boolean
  files: string[]; commits: string[]
  alerts: { sev: string; path: string; cls?: string[]; rule?: string }[] | Error
  resultChecks: string[]
  threads: { id: string; isResolved: boolean; path: string; login: string; type: string }[]
}
interface FakeRun { id: number; name: string; event: string; status: string; conclusion: string | null; run_attempt: number }
const fake: {
  prs: Record<string, FakePr>
  runs: Record<string, FakeRun[]>
  /** Files a PR ADDS, by `repo#n` (the reserved-content read). Missing = HTTP 404. */
  added: Record<string, string[] | Error>
  parents: Record<string, string[]>
  /** Per-commit overrides: who made it, and whether the non-PR parent is on the base. */
  commitMeta: Record<string, { verified?: boolean; committer?: string; otherOnBase?: boolean }>
  calls: string[][]
  onUpdate: ((p: FakePr) => void) | null
  onResolve: ((p: FakePr) => void) | null
} = { prs: {}, runs: {}, added: {}, parents: {}, commitMeta: {}, calls: [], onUpdate: null, onResolve: null }

function prOf(repo: string, n: string | number): FakePr {
  const p = fake.prs[`${repo}#${n}`]
  if (!p) throw new Error('HTTP 404: Not Found')
  return p
}

async function fakeExec(file: string, args: string[]): Promise<string> {
  fake.calls.push([file, ...args])
  if (file !== 'gh') throw new Error(`unexpected exec ${file}`)
  if (args[0] === 'pr' && args[1] === 'view') {
    const repo = args[args.indexOf('--repo') + 1]
    const p = prOf(repo, args[2])
    const fields = args[args.indexOf('--json') + 1]
    if (fields === 'mergeStateStatus,headRefOid') return JSON.stringify({ mergeStateStatus: p.mergeStateStatus, headRefOid: p.headSha })
    return JSON.stringify({
      number: Number(args[2]), url: `https://github.com/${repo}/pull/${args[2]}`, title: p.title, body: p.body, state: p.state,
      mergeStateStatus: p.mergeStateStatus, headRefOid: p.headSha, headRefName: p.headRef, baseRefName: 'main', isDraft: p.draft,
      isCrossRepository: p.fork, statusCheckRollup: p.rollup, commits: p.commits.map(h => ({ messageHeadline: h, messageBody: '' })),
    })
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    prOf(args[args.indexOf('--repo') + 1], args[2]).state = 'MERGED'
    return ''
  }
  if (args[0] === 'api' && args[1] === 'graphql') {
    const q = args.find(a => a.startsWith('query=')) ?? ''
    if (q.includes('resolveReviewThread')) {
      const id = (args.find(a => a.startsWith('id=')) ?? '').slice(3)
      for (const p of Object.values(fake.prs)) {
        const t = p.threads.find(x => x.id === id)
        if (t) { t.isResolved = true; fake.onResolve?.(p) }
      }
      return '{}'
    }
    const owner = (args.find(a => a.startsWith('owner=')) ?? '').slice(6)
    const name = (args.find(a => a.startsWith('name=')) ?? '').slice(5)
    const n = (args.find(a => a.startsWith('number=')) ?? '').slice(7)
    const p = prOf(`${owner}/${name}`, n)
    return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: p.threads.map(t => ({ id: t.id, isResolved: t.isResolved, path: t.path, comments: { nodes: [{ author: { login: t.login, __typename: t.type } }] } })) } } } } })
  }
  if (args[0] === 'api') {
    const url = args.find(a => a.startsWith('repos/')) ?? ''
    let m: RegExpExecArray | null
    if (args.includes('PUT') && (m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/update-branch$/.exec(url))) {
      const p = prOf(m[1], m[2])
      const before = p.headSha
      fake.onUpdate?.(p)
      if (p.headSha !== before) fake.parents[p.headSha] = [before, `ba5e${p.headSha}`]
      return '{"message":"Updating pull request branch."}'
    }
    if (args.includes('POST') && (m = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/(rerun|rerun-failed-jobs)$/.exec(url))) {
      for (const list of Object.values(fake.runs)) {
        const r = list.find(x => x.id === Number(m![2]))
        if (r) { r.status = 'queued'; r.conclusion = null; r.run_attempt += 1 }
      }
      return '{}'
    }
    if ((m = /^repos\/([^/]+\/[^/]+)\/actions\/runs\?head_sha=([0-9a-f]+)/.exec(url))) return JSON.stringify(fake.runs[m[2]] ?? [])
    if ((m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files/.exec(url))) {
      const jq = args[args.indexOf('--jq') + 1]
      if (jq.includes('added')) {
        const a = fake.added[`${m[1]}#${m[2]}`]
        if (!a) throw new Error('gh: Not Found (HTTP 404)')
        if (a instanceof Error) throw a
        return a.join('\n')
      }
      return prOf(m[1], m[2]).files.join('\n')
    }
    if ((m = /^repos\/([^/]+\/[^/]+)\/code-scanning\/alerts\?pr=(\d+)/.exec(url))) {
      const a = prOf(m[1], m[2]).alerts
      if (a instanceof Error) throw a
      return a.map(x => JSON.stringify({ sev: x.sev, path: x.path, cls: x.cls ?? [], rule: x.rule ?? 'js/some-rule' })).join('\n')
    }
    if ((m = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/check-runs/.exec(url))) {
      const p = Object.entries(fake.prs).find(([k, v]) => k.startsWith(`${m![1]}#`) && v.headSha === m![2])?.[1]
      return (p?.resultChecks ?? []).join('\n')
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)$/.exec(url))) {
      const meta = fake.commitMeta[m[1]] ?? {}
      return JSON.stringify({ parents: fake.parents[m[1]] ?? ['50de0000000', 'e15e0000000'], verified: meta.verified ?? true, committer: meta.committer ?? 'web-flow' })
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/compare\/main\.\.\.([0-9a-f]+)$/.exec(url))) {
      const head = Object.entries(fake.parents).find(([, ps]) => ps.includes(m![1]))?.[0] ?? ''
      return JSON.stringify((fake.commitMeta[head]?.otherOnBase ?? true) ? { status: 'behind', ahead_by: 0 } : { status: 'diverged', ahead_by: 3 })
    }
    if (url.endsWith('/protection')) throw new Error('HTTP 404 Not Found')
    if ((m = /^repos\/([^/]+\/[^/]+)\/rules\/branches\//.exec(url))) {
      const p = Object.entries(fake.prs).find(([k]) => k.startsWith(`${m![1]}#`))?.[1]
      const req = p?.required ?? ['gate']
      return JSON.stringify(req.length ? [{ type: 'required_status_checks', parameters: { required_status_checks: req.map(c => ({ context: c })) } }] : [])
    }
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
vi.mock('../session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (s: string) => s }
})

const { initDb, getDb } = await import('../../db/index.js')
const { clearRequiredChecksCache } = await import('../ci-green-gate-github.js')
const { clearInstalledChatBotCache } = await import('../bots/card-owner.js')
const { runChatTool, toolSpecsForContext } = await import('../agent-chat/tools.js')
const { seedExistingBotsOnce } = await import('../agent-chat/bot-workspaces.js')
const { createWorkspace } = await import('../workspaces.js')
const { setDevOpsSwitch, DEV_OPS_BOT_SLUG } = await import('./switch.js')
const { setRepoGrant, listRepoGrants, repoGrantActive, parseRepo } = await import('./repo-grant.js')
const { GRANT_MERGE_RESERVED_SEED } = await import('../grant-merge.js')
// The two repos PR 645 is seed-reserved in, read from the seed so this file never spells
// the private repo's name (the publish step renames it everywhere but in the seed).
const UPSTREAM = `acme/${GRANT_MERGE_RESERVED_SEED[0].repo}` // the private upstream: the reserved PR lives here
const PUBLIC = `acme/${GRANT_MERGE_RESERVED_SEED[1].repo}` // the public repo the sync PR lands in
const {
  processRepoPending, devRepoMerge, resolveRepoAuth, isTestPath, reservedPrInText, ciForRepoMerge, CI_START_LAG_MS, REPO_RIGHTS_SECRET_NAME,
} = await import('./repo-merge.js')
const { DEV_REPO_FNS, DEV_OPS_FNS } = await import('../agent-chat/dev-ops-tools.js')

type Agent = import('../agent-chat/agent-defs.js').ChatAgent
type Ctx = import('../agent-chat/tools.js').ToolContext
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const MEMBER = 2
const WS = 'operationkit'
const ADMIN = { id: OWNER, username: 'operator' }

function bot(slug: string): Agent {
  return {
    slug, name: slug, description: '', avatar: '', colour: 'blue', system_prompt: 'You help.',
    knowledge_folders: [], tools: ['get_objective', 'list_objectives'], model: null, provider: null, schedules: [],
    version: null, author: null, how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
  }
}
const DEV = bot(DEV_OPS_BOT_SLUG)
const OTHER = bot('other-bot')
function ctx(agent: Agent = DEV, extra: Partial<Ctx> = {}): Ctx {
  return { userId: OWNER, username: 'operator', workspace: WS, agent, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } as Loose, browserSession: true, ...extra }
}
const call = (name: string, args: Record<string, unknown> = {}, c: Ctx = ctx()) => runChatTool(c, name, args)
const merge = async (repo: string, number: number, c: Ctx = ctx()) => (await call('dev_merge_repo_pr', { repo, number }, c)).result as Loose
const refresh = async (repo: string, number: number, c: Ctx = ctx()) => (await call('dev_refresh_pr_ci', { repo, number }, c)).result as Loose
const offered = (c: Ctx) => toolSpecsForContext(c).map(s => s.function.name).filter(n => DEV_REPO_FNS.has(n))

const GREEN = [
  { name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'gate' },
  { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'gate' },
]
const PENDING = [{ name: 'unit', status: 'IN_PROGRESS', conclusion: '', workflowName: 'gate' }]
const RED = [{ name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'gate' }]
const CODEQL_RESULT_RED = { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: '' }

function pr(repo: string, n: number, over: Partial<FakePr> = {}): FakePr {
  const p: FakePr = {
    state: 'OPEN', mergeStateStatus: 'CLEAN', headSha: 'abc1234', rollup: GREEN, required: ['gate'],
    title: `Change ${n}`, body: 'A change.', headRef: `feature/${n}`, draft: false, fork: false,
    files: ['app/server/src/thing.ts'], commits: ['a commit'], alerts: new Error('gh: Code Security must be enabled for this repository to use code scanning. (HTTP 403)'),
    resultChecks: [], threads: [], ...over,
  }
  fake.prs[`${repo}#${n}`] = p
  return p
}
function syncPr(n: number, over: Partial<FakePr> = {}): FakePr {
  return pr(PUBLIC, n, {
    title: 'Sync from upstream', headRef: 'sync/from-upstream', commits: ['chore: sync from upstream (gated)'],
    body: 'Automated one-way sync.\n\nTriggered by merged upstream PR **#889** — Standing merge.', alerts: [], ...over,
  })
}

let seq = 0
function card(repo: string, n: number, spec: { status?: string; verdict?: string | null; strategy?: boolean; title?: string; owner?: string } = {}): number {
  seq += 1
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, ai_review_verdict, type, pr_url, pr_number, is_strategy)
     VALUES (?, ?, ?, ?, ?, ?, 'task', ?, ?, ?)`,
  ).run(spec.title ?? `repo merge fixture ${seq}`, spec.owner ?? DEV_OPS_BOT_SLUG, WS, OWNER, spec.status ?? 'review', spec.verdict === undefined ? 'pass' : spec.verdict, `https://github.com/${repo}/pull/${n}`, n, spec.strategy ? 1 : 0).lastInsertRowid)
}
const row = (id: number) => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Loose
const merges = () => fake.calls.filter(c => c[1] === 'pr' && c[2] === 'merge')
const updates = () => fake.calls.filter(c => c.some(a => String(a).endsWith('/update-branch')))
const reruns = () => fake.calls.filter(c => c.some(a => /\/actions\/runs\/\d+\/rerun/.test(String(a))))
const writes = () => fake.calls.filter(c => (c[1] === 'pr' && c[2] === 'merge') || c.includes('PUT') || c.includes('POST') || c.includes('PATCH') || c.includes('DELETE') || c.some(a => String(a).includes('resolveReviewThread')))
const auditCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM dev_ops_audit').get() as { n: number }).n
const lastAudit = () => getDb().prepare('SELECT * FROM dev_ops_audit ORDER BY id DESC LIMIT 1').get() as Loose
const noSleep = { sleep: async () => {} }
const actor = { userId: OWNER, username: 'operator', botSlug: DEV_OPS_BOT_SLUG }

beforeAll(() => {
  for (const slug of [DEV_OPS_BOT_SLUG, 'other-bot']) {
    fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
    fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${slug}\nsystem_prompt: You are ${slug}.\nknowledge_folders: []\ntools: [get_objective, list_objectives]\nversion: 1.0.0\nauthor: Test\n`)
  }
  clearInstalledChatBotCache()
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role, email) VALUES (?, 'operator', 'x', 'admin', 'admin-user@example.test')`).run(OWNER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'sam', 'x', 'member')`).run(MEMBER)
  createWorkspace({ slug: WS, name: 'Operation Kit', default_agent_pool: ['general'] })
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(MEMBER, WS)
  seedExistingBotsOnce([DEV_OPS_BOT_SLUG, 'other-bot'])
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

beforeEach(() => {
  clearRequiredChecksCache()
  fake.prs = {}
  fake.runs = {}
  // The reserved PR exists upstream (private repo) and adds one file of its own.
  fake.added = { [`${UPSTREAM}#645`]: ['app/server/src/reserved/casey-sheet.ts'] }
  fake.parents = {}
  fake.commitMeta = {}
  fake.calls = []
  fake.onUpdate = null
  fake.onResolve = null
  const db = getDb()
  db.prepare('DELETE FROM agent_chat_dev_ops').run()
  db.prepare('DELETE FROM dev_ops_repo_grants').run()
  db.prepare("DELETE FROM settings WHERE key = 'grant_merge_reserved_prs'").run()
  db.prepare("UPDATE dev_ops_repo_pending SET status = 'failed' WHERE status = 'waiting'").run()
  db.prepare("UPDATE objectives SET status = 'cancelled' WHERE pr_number IS NOT NULL").run()
  setRepoGrant(DEV_OPS_BOT_SLUG, PRIVATE, true, ADMIN)
  setRepoGrant(DEV_OPS_BOT_SLUG, PUBLIC, true, ADMIN)
})

describe('1. the grant: off by default, per repo, admin only', () => {
  it('with no grant the tools are not offered and a direct call is refused before any GitHub call', async () => {
    getDb().prepare('DELETE FROM dev_ops_repo_grants').run()
    expect(listRepoGrants(DEV_OPS_BOT_SLUG)).toEqual([])
    expect(offered(ctx())).toEqual([])
    // The ordinary operator tools are unaffected by this grant.
    expect(toolSpecsForContext(ctx()).map(s => s.function.name).filter(n => DEV_OPS_FNS.has(n)).sort()).toEqual([...DEV_OPS_FNS].sort())
    pr(PRIVATE, 10)
    const before = auditCount()
    const r = await merge(PRIVATE, 10)
    expect(r).toMatchObject({ ok: false, code: 'repo_not_granted' })
    expect(fake.calls).toHaveLength(0)
    expect(auditCount()).toBe(before + 1)
    expect(lastAudit()).toMatchObject({ action: 'repo_merge', outcome: 'refused', code: 'repo_not_granted', target: `${PRIVATE}#10` })
  })

  it('is listed per repo: a granted repo works, another repo of the same owner does not', async () => {
    expect(offered(ctx()).sort()).toEqual([...DEV_REPO_FNS].sort())
    expect(repoGrantActive(DEV_OPS_BOT_SLUG, PRIVATE)).toBe(true)
    expect(repoGrantActive(DEV_OPS_BOT_SLUG, 'ACME/App')).toBe(true) // GitHub names are case-insensitive
    expect(repoGrantActive(DEV_OPS_BOT_SLUG, UNGRANTED)).toBe(false)
    pr(UNGRANTED, 3)
    expect((await merge(UNGRANTED, 3)).code).toBe('repo_not_granted')
    expect((await refresh(UNGRANTED, 3)).code).toBe('repo_not_granted')
    expect(fake.calls).toHaveLength(0)
  })

  it('a revoke takes effect at once, and the row is kept', async () => {
    expect(setRepoGrant(DEV_OPS_BOT_SLUG, PRIVATE, false, ADMIN).change).toBe('revoked')
    pr(PRIVATE, 11)
    expect((await merge(PRIVATE, 11)).code).toBe('repo_not_granted')
    expect(merges()).toHaveLength(0)
    const kept = getDb().prepare('SELECT COUNT(*) AS n FROM dev_ops_repo_grants WHERE repo = ? AND revoked_at IS NOT NULL').get(PRIVATE) as { n: number }
    expect(kept.n).toBe(1)
  })

  it('only Operation Kit Dev can hold it, and only one exact repo per row', () => {
    expect(setRepoGrant('other-bot', PRIVATE, true, ADMIN).change).toBe('bot_not_eligible')
    expect(repoGrantActive('other-bot', PRIVATE)).toBe(false)
    for (const bad of ['acme/*', '*', 'acme', 'acme/app/extra', '../etc', 'acme/..', 'https://evil.example/acme/app', '']) {
      expect(parseRepo(bad)).toBeNull()
      expect(setRepoGrant(DEV_OPS_BOT_SLUG, bad, true, ADMIN).change).toBe('bad_repo')
    }
    expect(parseRepo('https://github.com/Acme/App/pull/12')).toBe('acme/app')
    expect(parseRepo('acme/app.git')).toBe('acme/app')
    // Parsing is idempotent: a name that would change on a second parse is refused.
    expect(parseRepo('acme/app.git.git')).toBeNull()
  })

  it('needs the owner typing in the browser: never another bot, a member, a token, a wake or a switched-off bot', async () => {
    pr(PRIVATE, 12)
    expect(offered(ctx(OTHER))).toEqual([])
    expect(offered(ctx(DEV, { userId: MEMBER, username: 'sam' }))).toEqual([])
    expect(offered(ctx(DEV, { browserSession: false }))).toEqual([])
    expect(offered(ctx(DEV, { botWake: { conversationId: 1, depth: 1 } }))).toEqual([])
    expect((await merge(PRIVATE, 12, ctx(DEV, { userId: MEMBER, username: 'sam' }))).code).toBe('not_admin')
    expect((await merge(PRIVATE, 12, ctx(DEV, { browserSession: false }))).code).toBe('not_browser')
    expect((await merge(PRIVATE, 12, ctx(OTHER))).code).toBe('bot_not_eligible')
    await expect(call('dev_merge_repo_pr', { repo: PRIVATE, number: 12 }, ctx(DEV, { cardWake: { workspace: WS } as Loose }))).rejects.toThrow()
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'wake_turn' })
    setDevOpsSwitch(DEV_OPS_BOT_SLUG, false, OWNER)
    expect(offered(ctx())).toEqual([])
    expect((await merge(PRIVATE, 12)).code).toBe('switch_off')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('2. merge by repo and number', () => {
  it('no card linked: merges pinned to the graded head, and files a done card as the record', async () => {
    pr(PRIVATE, 20, { title: 'Fix the widget' })
    const r = await merge(PRIVATE, 20)
    expect(r).toMatchObject({ ok: true, code: 'merged', card_filed: true, repo: PRIVATE, pr_number: 20 })
    expect(merges()).toHaveLength(1)
    expect(merges()[0]).toEqual(expect.arrayContaining(['--squash', '--delete-branch', '--repo', PRIVATE, '--match-head-commit', 'abc1234']))
    expect(merges()[0]).not.toContain('--admin')
    const c = row(r.objective_id)
    expect(c).toMatchObject({ status: 'done', workspace: WS, pr_number: 20, pr_url: `https://github.com/${PRIVATE}/pull/20`, agent_context: DEV_OPS_BOT_SLUG })
    expect(c.title).toContain('Fix the widget')
    expect(lastAudit()).toMatchObject({ action: 'repo_merge', outcome: 'done', code: 'merged', target: `${PRIVATE}#20`, objective_id: r.objective_id, username: 'operator' })
    const line = getDb().prepare("SELECT title FROM activity_log WHERE objective_id = ? ORDER BY id DESC LIMIT 1").get(r.objective_id) as { title: string }
    expect(line.title).toContain('squash-merged PR #20')
  })

  it('a linked card is used and closed, not duplicated', async () => {
    pr(PRIVATE, 21)
    const id = card(PRIVATE, 21, { owner: 'other-bot' }) // not Dev's card: the grant, not ownership, is the authority
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n
    const r = await merge(PRIVATE, 21)
    expect(r).toMatchObject({ ok: true, code: 'merged', card_filed: false, objective_id: id, card_done: true })
    expect(row(id).status).toBe('done')
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n).toBe(before)
  })

  it('covers the public repo: a clean sync PR merges, and the rolling sync branch is not deleted', async () => {
    syncPr(135)
    const r = await merge(PUBLIC, 135)
    expect(r).toMatchObject({ ok: true, code: 'merged', card_filed: true })
    expect(merges()[0]).toEqual(expect.arrayContaining(['--squash', '--repo', PUBLIC, '--match-head-commit', 'abc1234']))
    expect(merges()[0]).not.toContain('--delete-branch')
  })

  it('an already merged PR merges nothing and closes its card', async () => {
    pr(PRIVATE, 22, { state: 'MERGED' })
    const id = card(PRIVATE, 22)
    const r = await merge(PRIVATE, 22)
    expect(r).toMatchObject({ ok: true, code: 'already_merged', objective_id: id })
    expect(merges()).toHaveLength(0)
    expect(row(id).status).toBe('done')
  })

  it('a closed PR, a draft and a PR from a fork refuse', async () => {
    pr(PRIVATE, 23, { state: 'CLOSED' })
    pr(PRIVATE, 24, { draft: true })
    pr(PUBLIC, 25, { fork: true, alerts: [] })
    expect((await merge(PRIVATE, 23)).code).toBe('pr_not_open')
    expect((await merge(PRIVATE, 24)).code).toBe('pr_draft')
    expect((await merge(PUBLIC, 25)).code).toBe('fork_pr')
    expect((await refresh(PUBLIC, 25)).code).toBe('fork_pr')
    expect(writes()).toHaveLength(0)
  })

  it('not cleanly mergeable refuses: conflicts, a blocking rule, an unpinnable head', async () => {
    pr(PRIVATE, 26, { mergeStateStatus: 'DIRTY' })
    pr(PRIVATE, 27, { mergeStateStatus: 'BLOCKED' })
    pr(PRIVATE, 28, { mergeStateStatus: 'UNSTABLE' }) // red check that is not a code-scanning result
    pr(PRIVATE, 29, { headSha: '' })
    expect((await merge(PRIVATE, 26)).code).toBe('pr_not_mergeable')
    expect((await merge(PRIVATE, 27)).code).toBe('pr_not_mergeable')
    expect((await merge(PRIVATE, 28)).code).toBe('pr_not_mergeable')
    expect((await merge(PRIVATE, 29)).code).toBe('head_sha_unreadable')
    expect(merges()).toHaveLength(0)
  })
})

describe('3. CI must be green', () => {
  it('red, running and absent CI refuse; a required check that never reported refuses', async () => {
    pr(PRIVATE, 30, { rollup: RED })
    pr(PRIVATE, 31, { rollup: [] })
    pr(PRIVATE, 32, { rollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'gate' }] }) // required `gate` missing
    for (const n of [30, 31, 32]) expect((await merge(PRIVATE, n)).code).toBe('ci_not_green')
    expect(merges()).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'ci_not_green' })
  })

  it('"gate has not reported" says CI is still running when a run is in progress, not "never scheduled"', async () => {
    pr(PRIVATE, 33, { rollup: PENDING })
    fake.runs.abc1234 = [{ id: 7, name: 'gate', event: 'pull_request', status: 'in_progress', conclusion: null, run_attempt: 1 }]
    const r = await merge(PRIVATE, 33)
    expect(r).toMatchObject({ code: 'ci_not_green', pending: true })
    expect(r.message).toContain('CI is still running on this head')
    expect(reruns()).toHaveLength(0)
  })

  it('a merge request restarts a cancelled run but never re-runs a failed one', async () => {
    pr(PRIVATE, 34, { rollup: [] })
    fake.runs.abc1234 = [{ id: 8, name: 'gate', event: 'pull_request', status: 'completed', conclusion: 'cancelled', run_attempt: 1 }]
    expect((await merge(PRIVATE, 34)).message).toContain('a cancelled CI run was restarted')
    expect(reruns()).toHaveLength(1)
    expect(reruns()[0].some(a => a.endsWith('/actions/runs/8/rerun'))).toBe(true)
    expect(merges()).toHaveLength(0)
  })
})

describe('4. update a branch and really start CI', () => {
  it('refresh: a behind branch is updated pinned to the read head, then the tick confirms a run exists', async () => {
    pr(PRIVATE, 40, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'def5678'; p.mergeStateStatus = 'BLOCKED'; p.rollup = [] }
    const r = await refresh(PRIVATE, 40)
    expect(r).toMatchObject({ ok: true, code: 'branch_updated_waiting_for_ci' })
    expect(updates()).toHaveLength(1)
    expect(updates()[0]).toEqual(expect.arrayContaining(['expected_head_sha=abc1234']))
    expect(lastAudit()).toMatchObject({ action: 'repo_branch_update', outcome: 'waiting' })

    // No run yet: wait (inside the lag window).
    expect((await processRepoPending())[0]).toMatchObject({ outcome: 'waiting' })
    // GitHub creates the run: the row is settled as "CI started". Nothing is merged in ci_only mode.
    fake.runs.def5678 = [{ id: 41, name: 'gate', event: 'pull_request', status: 'in_progress', conclusion: null, run_attempt: 1 }]
    expect((await processRepoPending())[0]).toMatchObject({ outcome: 'ci_started' })
    expect(lastAudit()).toMatchObject({ action: 'repo_ci_started', outcome: 'done', code: 'ci_running' })
    expect(merges()).toHaveLength(0)
  })

  it('the tick restarts a run that was cancelled on the updated head (Actions re-run API)', async () => {
    pr(PRIVATE, 42, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'def5678'; p.mergeStateStatus = 'BLOCKED'; p.rollup = [] }
    await refresh(PRIVATE, 42)
    fake.runs.def5678 = [{ id: 43, name: 'gate', event: 'pull_request', status: 'completed', conclusion: 'cancelled', run_attempt: 1 }]
    expect((await processRepoPending())[0]).toMatchObject({ outcome: 'waiting' })
    expect(reruns()).toHaveLength(1)
    expect(reruns()[0]).toEqual(expect.arrayContaining(['--method', 'POST', `repos/${PRIVATE}/actions/runs/43/rerun`]))
    expect(lastAudit()).toMatchObject({ action: 'repo_ci_rerun', code: 'ci_rerun_requested' })
    // The restarted run is now queued: settled as started.
    expect((await processRepoPending())[0]).toMatchObject({ outcome: 'ci_started' })
  })

  it('no CI run ever appears: fails loudly with the cause and the credential NAME, never silently', async () => {
    pr(PRIVATE, 44, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'def5678'; p.mergeStateStatus = 'BLOCKED'; p.rollup = [] }
    await refresh(PRIVATE, 44)
    const later = Date.now() + CI_START_LAG_MS + 60_000
    const out = await processRepoPending({ now: () => later })
    expect(out[0]).toMatchObject({ outcome: 'failed' })
    expect(lastAudit()).toMatchObject({ outcome: 'failed', code: 'ci_never_started' })
    expect(lastAudit().detail).toContain(REPO_RIGHTS_SECRET_NAME)
  })

  it('refresh on an up-to-date head: re-runs failed jobs, reports running, and says so when there is no run at all', async () => {
    pr(PRIVATE, 45, { rollup: RED })
    fake.runs.abc1234 = [{ id: 46, name: 'gate', event: 'pull_request', status: 'completed', conclusion: 'failure', run_attempt: 1 }]
    expect(await refresh(PRIVATE, 45)).toMatchObject({ ok: true, code: 'ci_rerun_requested' })
    expect(reruns()[0].some(a => a.endsWith('/actions/runs/46/rerun-failed-jobs'))).toBe(true)
    expect(await refresh(PRIVATE, 45)).toMatchObject({ ok: true, code: 'ci_running' })

    // Attempts are capped: a run that already used 3 attempts is not started a 4th time.
    fake.runs.abc1234 = [{ id: 46, name: 'gate', event: 'pull_request', status: 'completed', conclusion: 'failure', run_attempt: 3 }]
    fake.calls = []
    expect((await refresh(PRIVATE, 45)).code).toBe('ci_red')
    expect(reruns()).toHaveLength(0)

    pr(PRIVATE, 47, { rollup: [], headSha: 'fed9876' })
    expect(await refresh(PRIVATE, 47)).toMatchObject({ ok: false, code: 'ci_never_started' })
    pr(PRIVATE, 48, { mergeStateStatus: 'DIRTY', rollup: [] })
    const dirty = await refresh(PRIVATE, 48)
    expect(dirty.code).toBe('pr_not_mergeable')
    expect(dirty.message).toContain('conflict')
    expect(updates()).toHaveLength(0)
  })

  it('merge: behind → update → merges ONLY the update commit, pinned to the new head, once green', async () => {
    pr(PRIVATE, 49, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'def5678'; p.mergeStateStatus = 'BLOCKED'; p.rollup = PENDING }
    const r = await merge(PRIVATE, 49)
    expect(r).toMatchObject({ ok: true, code: 'branch_updated_waiting_for_ci' })
    expect(merges()).toHaveLength(0)
    fake.runs.def5678 = [{ id: 50, name: 'gate', event: 'pull_request', status: 'in_progress', conclusion: null, run_attempt: 1 }]
    expect((await processRepoPending(noSleep))[0]).toMatchObject({ outcome: 'waiting' })
    const p = fake.prs[`${PRIVATE}#49`]
    p.rollup = GREEN
    p.mergeStateStatus = 'CLEAN'
    const out = await processRepoPending(noSleep)
    expect(out[0]).toMatchObject({ outcome: 'merged' })
    expect(merges()).toHaveLength(1)
    expect(merges()[0]).toEqual(expect.arrayContaining(['--match-head-commit', 'def5678']))
    expect(lastAudit()).toMatchObject({ action: 'repo_merge_on_green', outcome: 'done', code: 'merged' })
    expect(row(lastAudit().objective_id).status).toBe('done')
  })

  it('a hand-made merge commit on top of the graded head is NOT the update commit: never merged', async () => {
    // Two parents, one of them the graded head, CI green: but not made by GitHub.
    pr(PRIVATE, 55, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'c0ffee1'; p.mergeStateStatus = 'CLEAN'; p.rollup = GREEN }
    await merge(PRIVATE, 55)
    fake.commitMeta.c0ffee1 = { verified: false, committer: 'someone' }
    expect((await processRepoPending(noSleep))[0]).toMatchObject({ outcome: 'failed' })
    expect(lastAudit().code).toBe('head_not_update_commit')

    // Made through GitHub, but its other parent is NOT on the base (another branch merged in).
    pr(PRIVATE, 56, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'c0ffee2'; p.mergeStateStatus = 'CLEAN'; p.rollup = GREEN }
    await merge(PRIVATE, 56)
    fake.commitMeta.c0ffee2 = { otherOnBase: false }
    expect((await processRepoPending(noSleep))[0]).toMatchObject({ outcome: 'failed' })
    expect(lastAudit().code).toBe('head_not_update_commit')
    expect(merges()).toHaveLength(0)
  })

  it('asking twice never updates the branch twice (a second update would cancel the first CI run)', async () => {
    pr(PRIVATE, 54, { mergeStateStatus: 'BEHIND' })
    const first = await refresh(PRIVATE, 54) // GitHub has not applied the update yet: still BEHIND
    const again = await refresh(PRIVATE, 54)
    const asMerge = await merge(PRIVATE, 54)
    expect(updates()).toHaveLength(1)
    expect(again.pending_id).toBe(first.pending_id)
    expect(asMerge).toMatchObject({ ok: true, code: 'branch_updated_waiting_for_ci', pending_id: first.pending_id })
    // The merge request upgraded the waiting row: it now merges on green.
    expect(getDb().prepare('SELECT mode FROM dev_ops_repo_pending WHERE id = ?').get(first.pending_id)).toMatchObject({ mode: 'merge' })
  })

  it('a different new commit, red CI on the new head, or a revoked grant while waiting never merges', async () => {
    pr(PRIVATE, 51, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'def5678'; p.mergeStateStatus = 'CLEAN'; p.rollup = GREEN }
    await merge(PRIVATE, 51)
    fake.parents.def5678 = ['50de0000000'] // a pushed commit, not GitHub's update merge
    expect((await processRepoPending(noSleep))[0]).toMatchObject({ outcome: 'failed' })
    expect(lastAudit().code).toBe('head_not_update_commit')

    pr(PRIVATE, 52, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'aaa1111'; p.mergeStateStatus = 'BLOCKED'; p.rollup = RED }
    await merge(PRIVATE, 52)
    expect((await processRepoPending(noSleep))[0]).toMatchObject({ outcome: 'failed' })
    expect(lastAudit().code).toBe('ci_failed')

    pr(PRIVATE, 53, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'bbb2222'; p.mergeStateStatus = 'CLEAN'; p.rollup = GREEN }
    await merge(PRIVATE, 53)
    setRepoGrant(DEV_OPS_BOT_SLUG, PRIVATE, false, ADMIN)
    expect((await processRepoPending(noSleep))[0]).toMatchObject({ outcome: 'failed' })
    expect(lastAudit().code).toBe('repo_not_granted')
    expect(merges()).toHaveLength(0)
  })
})

describe('5a. wall: reserved pull requests and reserved content', () => {
  it('PR 645 on either repo is never merged, updated or re-run, and is refused before any GitHub call', async () => {
    const infra = UPSTREAM
    setRepoGrant(DEV_OPS_BOT_SLUG, infra, true, ADMIN)
    for (const repo of [infra, PUBLIC, PRIVATE]) {
      pr(repo, 645, { mergeStateStatus: 'BEHIND' })
      expect(await merge(repo, 645)).toMatchObject({ ok: false, code: 'reserved_pr' })
      expect(await refresh(repo, 645)).toMatchObject({ ok: false, code: 'reserved_pr' })
    }
    expect(fake.calls).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ action: 'repo_ci_refresh', outcome: 'refused', code: 'reserved_pr' })
  })

  it('a PR reserved by the server-side setting is refused the same way', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('grant_merge_reserved_prs', ?)").run(`${PRIVATE}#60`)
    pr(PRIVATE, 60)
    expect((await merge(PRIVATE, 60)).code).toBe('reserved_pr')
    expect(fake.calls).toHaveLength(0)
  })

  it('a sync PR that names the reserved PR as its source is refused', async () => {
    syncPr(136, { body: 'Automated one-way sync.\n\nTriggered by merged upstream PR **#645** — Casey content to sheet.' })
    const r = await merge(PUBLIC, 136)
    expect(r).toMatchObject({ ok: false, code: 'reserved_content' })
    expect((await refresh(PUBLIC, 136)).code).toBe('reserved_content')
    expect(writes()).toHaveLength(0)
    expect(reservedPrInText('see pull/645 and PR 6450', [{ repo: null, number: 645 }])).toBe(645)
    expect(reservedPrInText('PR 6450 and #1645', [{ repo: null, number: 645 }])).toBeNull()
    for (const t of ['PR-645', 'PR: 645', 'pulls/645', 'pull requests 645', 'pull-request #645', 'GH-645', 'PRs #645']) expect(reservedPrInText(t, [{ repo: null, number: 645 }])).toBe(645)
  })

  it('a sync PR that carries a file the reserved PR adds is refused, even when its text does not say so', async () => {
    syncPr(137, { files: ['app/server/src/thing.ts', 'app/server/src/reserved/casey-sheet.ts'] })
    const r = await merge(PUBLIC, 137)
    expect(r).toMatchObject({ ok: false, code: 'reserved_content' })
    expect(r.message).toContain('casey-sheet.ts')
    expect(writes()).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'reserved_content' })
  })

  it('a sync PR is refused when the upstream reserved PR cannot be read (fail closed)', async () => {
    fake.added = {} // every upstream lookup is a 404: the credential cannot see the private repo
    syncPr(138)
    expect((await merge(PUBLIC, 138)).code).toBe('reserved_content_unreadable')
    fake.added = { [`${UPSTREAM}#645`]: new Error('HTTP 502: Bad Gateway') }
    expect((await merge(PUBLIC, 138)).code).toBe('reserved_content_unreadable')
    expect(merges()).toHaveLength(0)
  })
})

describe('5b. wall: CodeQL high findings', () => {
  it('a high finding outside test files blocks the merge', async () => {
    syncPr(140, {
      rollup: [...GREEN, CODEQL_RESULT_RED], resultChecks: ['CodeQL'], mergeStateStatus: 'UNSTABLE',
      alerts: [
        { sev: 'high', path: 'app/server/src/routes/a.test.ts', rule: 'js/missing-token-validation' },
        { sev: 'high', path: 'app/server/src/index.ts', rule: 'js/missing-token-validation' },
      ],
    })
    const r = await merge(PUBLIC, 140)
    expect(r).toMatchObject({ ok: false, code: 'codeql_high' })
    expect(r.message).toContain('app/server/src/index.ts')
    expect(merges()).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'codeql_high' })
  })

  it('high findings ONLY in test files do not block: the red CodeQL result check is set aside and the PR merges', async () => {
    syncPr(141, {
      rollup: [...GREEN, CODEQL_RESULT_RED], resultChecks: ['CodeQL'], mergeStateStatus: 'UNSTABLE',
      alerts: [
        { sev: 'high', path: 'app/server/src/routes/a.test.ts' },
        { sev: 'critical', path: 'app/client/src/__tests__/b.tsx' },
        { sev: 'high', path: 'scripts/odd-name.ts', cls: ['test'] },
        { sev: 'medium', path: 'app/server/src/index.ts' },
      ],
    })
    const r = await merge(PUBLIC, 141)
    expect(r).toMatchObject({ ok: true, code: 'merged' })
    expect(r.message).toContain('3 high CodeQL finding(s), all in test files')
  })

  it('findings that cannot be read block; "code scanning is off" passes only when the head has no result check', async () => {
    syncPr(142, { alerts: new Error('HTTP 403: Resource not accessible by personal access token') })
    expect((await merge(PUBLIC, 142)).code).toBe('codeql_unreadable')
    syncPr(143, { headSha: 'c0de143', rollup: [...GREEN, CODEQL_RESULT_RED], resultChecks: ['CodeQL'], mergeStateStatus: 'UNSTABLE', alerts: new Error('Code Security must be enabled for this repository to use code scanning.') })
    expect((await merge(PUBLIC, 143)).code).toBe('codeql_unreadable')
    expect(merges()).toHaveLength(0)
    pr(PRIVATE, 144) // code scanning off, no result check: the wall has nothing to judge
    expect((await merge(PRIVATE, 144)).code).toBe('merged')
  })

  it('a red code-scanning check that no high finding explains is a red check, not a cleared one', async () => {
    // Failed on a lower threshold or an analysis error: the alerts list has nothing high.
    syncPr(147, { headSha: 'c0de147', rollup: [...GREEN, CODEQL_RESULT_RED], resultChecks: ['CodeQL'], mergeStateStatus: 'UNSTABLE', alerts: [{ sev: 'medium', path: 'app/server/src/index.ts' }] })
    expect((await merge(PUBLIC, 147)).code).toBe('codeql_unreadable')
    // Cancelled / timed out is never set aside at all.
    syncPr(148, { headSha: 'c0de148', rollup: [...GREEN, { ...CODEQL_RESULT_RED, conclusion: 'CANCELLED' }], resultChecks: ['CodeQL'], mergeStateStatus: 'UNSTABLE', alerts: [{ sev: 'high', path: 'a/b.test.ts' }] })
    expect((await merge(PUBLIC, 148)).code).toBe('ci_not_green')
    // Test-only findings, but something ELSE on the head is red (a harness status CI ignores): UNSTABLE is not accepted.
    syncPr(149, {
      headSha: 'c0de149', resultChecks: ['CodeQL'], mergeStateStatus: 'UNSTABLE', alerts: [{ sev: 'high', path: 'a/b.test.ts' }],
      rollup: [...GREEN, CODEQL_RESULT_RED, { context: 'harness/test-agent', state: 'FAILURE' }],
    })
    expect((await merge(PUBLIC, 149)).code).toBe('pr_not_mergeable')
    // A GREEN result check explains no UNSTABLE.
    syncPr(139, { headSha: 'c0de139', rollup: [...GREEN, { ...CODEQL_RESULT_RED, conclusion: 'SUCCESS' }], resultChecks: ['CodeQL'], mergeStateStatus: 'UNSTABLE', alerts: [] })
    expect((await merge(PUBLIC, 139)).code).toBe('pr_not_mergeable')
    expect(merges()).toHaveLength(0)
  })

  it('only the code-scanning RESULT check is set aside: an Analyze job, a pending result or a required check stays strict', async () => {
    const required = { contexts: ['gate'], source: 'ruleset' as const }
    const result = new Set(['CodeQL'])
    expect(ciForRepoMerge(required, [...GREEN, CODEQL_RESULT_RED] as Loose, result).ci.green).toBe(true)
    expect(ciForRepoMerge(required, [...GREEN, { name: 'Analyze (python)', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CodeQL' }] as Loose, result).ci.green).toBe(false)
    expect(ciForRepoMerge(required, [...GREEN, { name: 'CodeQL', status: 'IN_PROGRESS', conclusion: '', workflowName: '' }] as Loose, result).ci.green).toBe(false)
    expect(ciForRepoMerge(required, [...GREEN, { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CodeQL' }] as Loose, result).ci.green).toBe(false)
    expect(ciForRepoMerge({ contexts: ['gate', 'CodeQL'], source: 'ruleset' }, [...GREEN, CODEQL_RESULT_RED] as Loose, result).ci.green).toBe(false)
    expect(ciForRepoMerge(required, [...GREEN, { ...CODEQL_RESULT_RED, conclusion: 'TIMED_OUT' }] as Loose, result).ci.green).toBe(false)
    for (const p of ['a/b.test.ts', 'x/y.spec.tsx', 'tests/smoke/a.ts', 'app/client/src/__tests__/b.tsx', 'pkg/test_thing.py', 'pkg/thing_test.go']) expect(isTestPath(p)).toBe(true)
    // Shipped code can live in a folder called fixtures, e2e or a nested tests: not test files.
    for (const p of ['', 'app/server/src/index.ts', 'app/server/src/latest.ts', 'app/contest/a.ts', 'app/server/src/testing-helpers.ts', 'src/fixtures/prod.ts', 'scripts/tests/deploy.sh', 'app/server/src/routes/e2e/index.ts']) expect(isTestPath(p)).toBe(false)
  })

  it('a code-scanning bot thread on a test file is resolved; a person\'s conversation never is, and no admin bypass is used', async () => {
    syncPr(145, {
      mergeStateStatus: 'BLOCKED', alerts: [{ sev: 'high', path: 'app/server/src/routes/a.test.ts' }],
      threads: [{ id: 'T1', isResolved: false, path: 'app/server/src/routes/a.test.ts', login: 'github-advanced-security', type: 'Bot' }],
    })
    fake.onResolve = p => { p.mergeStateStatus = 'CLEAN' }
    const ok = await devRepoMerge({ repo: PUBLIC, number: 145, workspace: WS }, actor, noSleep)
    expect(ok).toMatchObject({ ok: true, code: 'merged' })
    expect(ok.message).toContain('resolved 1 code-scanning bot thread')

    syncPr(146, {
      mergeStateStatus: 'BLOCKED', alerts: [],
      threads: [
        { id: 'T2', isResolved: false, path: 'app/server/src/routes/a.test.ts', login: 'a-person', type: 'User' },
        { id: 'T3', isResolved: false, path: 'app/server/src/index.ts', login: 'github-advanced-security', type: 'Bot' },
        // A bot thread on a test file would be resolvable alone; next to the two above it is left too.
        { id: 'T4', isResolved: false, path: 'app/server/src/routes/b.test.ts', login: 'github-advanced-security', type: 'Bot' },
      ],
    })
    fake.calls = []
    const blocked = await devRepoMerge({ repo: PUBLIC, number: 146, workspace: WS }, actor, noSleep)
    expect(blocked).toMatchObject({ ok: false, code: 'pr_not_mergeable' })
    expect(blocked.message).toContain('2 open review conversation(s)')
    expect(fake.prs[`${PUBLIC}#146`].threads.every(t => !t.isResolved)).toBe(true)
    expect(writes()).toHaveLength(0)
    expect(fake.calls.flat()).not.toContain('--admin')
  })
})

describe('5c. wall: a linked card keeps its rules', () => {
  it('the AI-review rule stays: a failed or blocked review on the linked card refuses before any GitHub call', async () => {
    pr(PRIVATE, 70)
    const failed = card(PRIVATE, 70, { verdict: 'fail' })
    expect(await merge(PRIVATE, 70)).toMatchObject({ ok: false, code: 'review_failed', objective_id: failed })
    getDb().prepare("UPDATE objectives SET ai_review_verdict = 'blocked' WHERE id = ?").run(failed)
    expect((await merge(PRIVATE, 70)).code).toBe('review_failed')
    expect(fake.calls).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'review_failed', objective_id: failed })
    // A passed review, or none yet, goes on (the operator-tools rule, unchanged).
    getDb().prepare('UPDATE objectives SET ai_review_verdict = NULL WHERE id = ?').run(failed)
    expect((await merge(PRIVATE, 70)).code).toBe('merged')
  })

  it('a worker still running, a Strategy and a money-path card refuse', async () => {
    pr(PRIVATE, 71); card(PRIVATE, 71, { status: 'working' })
    pr(PRIVATE, 72); card(PRIVATE, 72, { strategy: true })
    pr(PRIVATE, 73); card(PRIVATE, 73, { title: 'Stripe billing: charge the card on renewal' })
    expect((await merge(PRIVATE, 71)).code).toBe('card_still_running')
    expect((await merge(PRIVATE, 72)).code).toBe('strategy')
    expect((await merge(PRIVATE, 73)).code).toBe('money_path')
    expect(fake.calls).toHaveLength(0)
  })

  it('a card for the same number in ANOTHER repo is not a link', async () => {
    pr(PRIVATE, 74)
    card(UNGRANTED, 74, { verdict: 'fail' })
    expect(await merge(PRIVATE, 74)).toMatchObject({ code: 'merged', card_filed: true })
  })
})

describe('6. nothing else is touched', () => {
  it('every GitHub call is on the allow-list: no repo setting, no branch protection write, no deploy, no force', async () => {
    syncPr(150, {
      rollup: [...GREEN, CODEQL_RESULT_RED], resultChecks: ['CodeQL'], mergeStateStatus: 'BLOCKED', alerts: [{ sev: 'high', path: 'a/b.test.ts' }],
      threads: [{ id: 'T9', isResolved: false, path: 'a/b.test.ts', login: 'github-advanced-security', type: 'Bot' }],
    })
    fake.onResolve = p => { p.mergeStateStatus = 'UNSTABLE' }
    await devRepoMerge({ repo: PUBLIC, number: 150, workspace: WS }, actor, noSleep)
    pr(PRIVATE, 151, { mergeStateStatus: 'BEHIND' })
    fake.onUpdate = p => { p.headSha = 'def5678'; p.mergeStateStatus = 'BLOCKED'; p.rollup = [] }
    await merge(PRIVATE, 151)
    fake.runs.def5678 = [{ id: 152, name: 'gate', event: 'pull_request', status: 'completed', conclusion: 'cancelled', run_attempt: 1 }]
    await processRepoPending(noSleep)
    pr(PRIVATE, 153, { rollup: RED })
    fake.runs.abc1234 = [{ id: 154, name: 'gate', event: 'pull_request', status: 'completed', conclusion: 'failure', run_attempt: 1 }]
    await refresh(PRIVATE, 153)

    expect(merges().length).toBeGreaterThan(0)
    const WRITE_OK = [
      /^gh pr merge \d+ --squash --repo \S+ --match-head-commit [0-9a-f]+( --delete-branch)?$/,
      /^gh api --method PUT -H Accept: application\/vnd\.github\+json repos\/\S+\/pulls\/\d+\/update-branch -f expected_head_sha=[0-9a-f]+$/,
      /^gh api --method POST repos\/\S+\/actions\/runs\/\d+\/(rerun|rerun-failed-jobs)$/,
      /^gh api graphql -f query=mutation\(\$id:ID!\)\{resolveReviewThread\(.*\}\}\} -f id=\S+$/,
    ]
    for (const c of writes()) expect(WRITE_OK.some(re => re.test(c.join(' '))), c.join(' ')).toBe(true)
    const READ_OK = /^gh (pr view \d+ --repo \S+ --json \S+|api (--paginate )?repos\/\S+ --jq .+|api repos\/\S+( --jq .+)?|api graphql -f query=query\(.+)$/
    for (const c of fake.calls.filter(x => !writes().includes(x))) expect(READ_OK.test(c.join(' ')), c.join(' ')).toBe(true)
    const all = fake.calls.map(c => c.join(' ')).join('\n')
    for (const never of ['--admin', '--force', 'rebase', '/protection --method', 'rulesets', '/branches/main/protection -', 'update.sh', 'deploy', 'migrat', 'PATCH', 'DELETE']) expect(all).not.toContain(never)
  })

  it('a deploy is still its own tool behind its own word: a repo merge starts none', async () => {
    pr(PRIVATE, 155)
    await merge(PRIVATE, 155)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM dev_ops_deploys').get() as { n: number }).n).toBe(0)
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM dev_ops_audit WHERE action LIKE 'deploy%'").get()).toMatchObject({ n: 0 })
  })
})

describe('7. the audit trail', () => {
  it('every merge and every refusal is one row with who, what, the outcome and a reason', async () => {
    pr(PRIVATE, 160)
    pr(PRIVATE, 161, { rollup: RED })
    syncPr(162, { alerts: [{ sev: 'high', path: 'app/server/src/index.ts' }] })
    const before = auditCount()
    await merge(PRIVATE, 160)
    await merge(PRIVATE, 161)
    await merge(PUBLIC, 162)
    await merge(PRIVATE, 645)
    await merge(UNGRANTED, 1)
    await call('dev_merge_repo_pr', { repo: 'not a repo', number: 1 })
    const rows = getDb().prepare('SELECT * FROM dev_ops_audit WHERE id > (SELECT MAX(id) FROM dev_ops_audit) - ? ORDER BY id').all(auditCount() - before) as Loose[]
    expect(rows.map(r => [r.outcome, r.code])).toEqual([
      ['done', 'merged'], ['refused', 'ci_not_green'], ['refused', 'codeql_high'], ['refused', 'reserved_pr'], ['refused', 'repo_not_granted'], ['refused', 'bad_request'],
    ])
    for (const r of rows) {
      expect(r).toMatchObject({ action: 'repo_merge', bot_slug: DEV_OPS_BOT_SLUG, user_id: OWNER, username: 'operator' })
      expect(String(r.detail).length).toBeGreaterThan(20)
    }
    expect(rows.slice(0, 5).map(r => r.target)).toEqual([`${PRIVATE}#160`, `${PRIVATE}#161`, `${PUBLIC}#162`, `${PRIVATE}#645`, `${UNGRANTED}#1`])
  })

  it('no credential value reaches a tool result, a card or the audit table', async () => {
    pr(PRIVATE, 163)
    const r = await merge(PRIVATE, 163)
    const everything = JSON.stringify(r) + JSON.stringify(getDb().prepare('SELECT * FROM dev_ops_audit').all()) + JSON.stringify(row(r.objective_id)) + fake.calls.flat().join(' ')
    expect(everything).not.toContain(FAKE_TOKEN)
    expect(REPO_RIGHTS_SECRET_NAME).toBe('DEV_BOT_GITHUB_TOKEN')
  })

  it('the credential is found by NAME: the dedicated secret when one is stored, else the shared server login', async () => {
    const q = { workspace: WS, grantorUserId: OWNER, agent: DEV_OPS_BOT_SLUG }
    expect(resolveRepoAuth(q)?.source).toBe('server_env')
    const { setSecret, deleteSecret } = await import('../secrets-store.js') as Loose
    setSecret({ scope: { scopeType: 'global' }, key: REPO_RIGHTS_SECRET_NAME, value: 'envtok_9f8e7d6c5b4a39281706', actorUserId: OWNER })
    try {
      const auth = resolveRepoAuth(q)
      expect(auth?.source).toBe('named_secret')
      expect(JSON.stringify(auth)).not.toContain('envtok_')
      // The read is in the secrets audit log, by name.
      const read = getDb().prepare("SELECT COUNT(*) AS n FROM secret_access_log WHERE action = 'read' AND key = ?").get(REPO_RIGHTS_SECRET_NAME) as { n: number }
      expect(read.n).toBeGreaterThan(0)
    } finally {
      deleteSecret({ scopeType: 'global' }, REPO_RIGHTS_SECRET_NAME, OWNER)
    }
    expect(resolveRepoAuth(q)?.source).toBe('server_env')
  })
})
