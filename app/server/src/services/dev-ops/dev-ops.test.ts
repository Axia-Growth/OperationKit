/**
 * obj 901424 — Operation Kit Dev operator tools, through the real chat tool entry
 * point (`runChatTool` / `toolSpecsForContext`), a real temp SQLite DB and the
 * real status handler, with GitHub replaced by a fake `gh` and the host replaced
 * by a fake runner:
 *
 *  1. gate: only operation-kit-dev, only with its switch on (default on), only an
 *     admin, never a wake turn; a refused call is audited;
 *  2. merge relaxations: a DONE card and a card with NO AI review merge on green;
 *     a FAILED review, a running card and another bot's card refuse;
 *  3. behind branch: update-branch pinned to the read head → waits → merges on
 *     green pinned to the NEW head; red CI on the new head never merges;
 *  4. PR 645 (both repos) and a setting-reserved PR refuse before any GitHub call;
 *  5. close: done only when GitHub says MERGED (no admin sign-off needed); cancel
 *     only Dev's own cards; never 645;
 *  6. deploy: the exact update.sh command, detached, never a skip/force flag, one
 *     at a time; settles deployed / rolled_back from the host's outcome file;
 *  7. Cloudflare: no domain / wildcard allow, protected addresses never removed,
 *     DNS only inside the zone and never the install's own record;
 *  8. secrets: a token in host output never reaches the tool result, the audit
 *     table or the docker argv; protected addresses are never echoed back;
 *  9. every call above writes a dev_ops_audit row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dev-ops-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.GH_TOKEN = 'test-server-login'
process.env.JWT_SECRET = 'test-secret-dev-ops'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dev-ops-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dev-ops-kb-'))
const DATA_DIR = path.join(TMP, 'data')
fs.mkdirSync(path.join(DATA_DIR, 'dev-ops'), { recursive: true })
process.env.CC_DEV_OPS_DATA_DIR = DATA_DIR
process.env.CC_DEV_OPS_HOST_DATA_DIR = '/srv/ok/state/data'
process.env.CC_DEV_OPS_HEALTH_URL = 'https://ai.example.test/api/health'
process.env.OK_DOMAIN = 'ai.example.test'
process.env.CC_DEV_OPS_ZONE = 'example.test'
// The owner's sign-in address is held in a SECRET env var; tests use a stand-in.
const OWNER_SIGNIN = 'owner-signin@example.test'
process.env.EMAILGUARD_EMAIL = OWNER_SIGNIN
process.env.OK_CF_ACCESS_PROTECTED_EMAILS = 'installer@example.test'
const FAKE_CF_TOKEN = 'envtok_9f8e7d6c5b4a39281706' // allow-listed fake in scripts/oss-gitleaks.toml
// The built-in seed is two SHA-256 hashes of the owner's real addresses (never in
// source). Tests add a stand-in address by hash through the same env door.
const SEEDED = 'seeded-owner@example.test'
const sha = (e: string) => createHash('sha256').update(e.trim().toLowerCase()).digest('hex')
process.env.CC_DEV_OPS_PROTECTED_SHA256 = sha(SEEDED)

// ── fake GitHub ──────────────────────────────────────────────────────────────
interface FakePr { state: string; mergeStateStatus: string; headSha: string; rollup: unknown[]; required: string[] }
const fake: { pr: FakePr; calls: string[][]; onUpdate: ((p: FakePr) => void) | null; parents: Record<string, string[]> } = {
  pr: { state: 'OPEN', mergeStateStatus: 'CLEAN', headSha: 'abc1234', rollup: [], required: [] },
  calls: [],
  onUpdate: null,
  parents: {},
}
async function fakeExec(file: string, args: string[]): Promise<string> {
  fake.calls.push([file, ...args])
  if (file !== 'gh') throw new Error(`unexpected exec ${file}`)
  const p = fake.pr
  if (args[0] === 'api') {
    if (args.includes('PUT') && args.some(a => a.endsWith('/update-branch'))) {
      const before = p.headSha
      fake.onUpdate?.(p)
      // GitHub's update commit: a merge of the old head and the base.
      if (p.headSha !== before) fake.parents[p.headSha] = [before, 'base0000000000']
      return '{"message":"Updating pull request branch."}'
    }
    const cm = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)$/.exec(String(args[1]))
    if (cm) return JSON.stringify(fake.parents[cm[1]] ?? ['someone0000', 'else0000000'])
    if (String(args[1]).endsWith('/protection')) throw new Error('HTTP 404 Not Found')
    return JSON.stringify(p.required.length ? [{ type: 'required_status_checks', parameters: { required_status_checks: p.required.map(c => ({ context: c })) } }] : [])
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const fields = args[args.indexOf('--json') + 1]
    if (fields === 'state,mergeStateStatus') return JSON.stringify({ state: p.state, mergeStateStatus: p.mergeStateStatus })
    return JSON.stringify({ number: Number(args[2]), url: `https://github.com/acme/app/pull/${args[2]}`, headRefOid: p.headSha, baseRefName: 'main', statusCheckRollup: p.rollup, state: p.state })
  }
  if (args[0] === 'pr' && args[1] === 'merge') { p.state = 'MERGED'; return '' }
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
const { setDevOpsSwitch, getDevOpsSwitch, DEV_OPS_BOT_SLUG } = await import('./switch.js')
const { processPendingMerges } = await import('./merge.js')
const { setHostRunnerForTests, hostDockerArgs } = await import('./host-exec.js')
const { accessGuard, dnsGuard, protectedAccessEmails, protectedAccessHashes, ACCESS_PROTECTED_SEED_SHA256 } = await import('./cloudflare.js')
const { registerKnownSecret, clearRegisteredSecretsForTests } = await import('../secret-redaction.js')
const { DEV_OPS_FNS } = await import('../agent-chat/dev-ops-tools.js')

type Agent = import('../agent-chat/agent-defs.js').ChatAgent
type Ctx = import('../agent-chat/tools.js').ToolContext
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const MEMBER = 2
const WS = 'operationkit'

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
const offered = (c: Ctx) => toolSpecsForContext(c).map(s => s.function.name).filter(n => DEV_OPS_FNS.has(n))

const GREEN = [
  { name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
]
const PENDING = [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '' }]
const RED = [{ name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }]

let seq = 0
function card(spec: { owner?: string; status?: string; verdict?: string | null; prNumber?: number | null; repo?: string; strategy?: boolean; createdBy?: number } = {}): number {
  seq += 1
  const n = spec.prNumber === null ? null : spec.prNumber ?? 500 + seq
  const repo = spec.repo ?? 'acme/app'
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, ai_review_verdict, type, pr_url, pr_number, is_strategy)
     VALUES (?, ?, ?, ?, ?, ?, 'task', ?, ?, ?)`,
  ).run(
    `dev ops fixture ${seq}`, spec.owner ?? DEV_OPS_BOT_SLUG, WS, spec.createdBy ?? OWNER, spec.status ?? 'review',
    spec.verdict === undefined ? 'pass' : spec.verdict,
    n == null ? null : `https://github.com/${repo}/pull/${n}`, n, spec.strategy ? 1 : 0,
  ).lastInsertRowid)
}
const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const merges = () => fake.calls.filter(c => c[1] === 'pr' && c[2] === 'merge')
const updates = () => fake.calls.filter(c => c[1] === 'api' && c.some(a => String(a).endsWith('/update-branch')))
const auditCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM dev_ops_audit').get() as { n: number }).n
const lastAudit = () => getDb().prepare('SELECT * FROM dev_ops_audit ORDER BY id DESC LIMIT 1').get() as Loose
const allAuditText = () => JSON.stringify(getDb().prepare('SELECT * FROM dev_ops_audit').all())

// ── fake host ────────────────────────────────────────────────────────────────
interface HostCall { image: string; args: string[]; opts: Loose }
const host: { calls: HostCall[]; reply: (c: HostCall) => { code: number; stdout: string; stderr: string } } = {
  calls: [],
  reply: () => ({ code: 0, stdout: '{"ok":true,"code":"ok"}\n', stderr: '' }),
}

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
  setHostRunnerForTests(async (image, args, opts) => {
    const c = { image, args, opts }
    host.calls.push(c)
    return host.reply(c)
  })
})

afterAll(() => {
  setHostRunnerForTests(null)
  clearRegisteredSecretsForTests()
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

beforeEach(() => {
  clearRequiredChecksCache()
  fake.pr = { state: 'OPEN', mergeStateStatus: 'CLEAN', headSha: 'abc1234', rollup: GREEN, required: ['gate'] }
  fake.calls = []
  fake.onUpdate = null
  fake.parents = {}
  host.calls = []
  host.reply = () => ({ code: 0, stdout: '{"ok":true,"code":"ok"}\n', stderr: '' })
  getDb().prepare('DELETE FROM agent_chat_dev_ops').run()
  getDb().prepare("DELETE FROM settings WHERE key IN ('grant_merge_reserved_prs', 'dev_ops_protected_access_emails')").run()
  getDb().prepare('DELETE FROM dev_ops_deploys').run()
  getDb().prepare("UPDATE dev_ops_pending_merges SET status = 'failed' WHERE status = 'waiting'").run()
})

describe('1. the one admin switch and the gate', () => {
  it('offers every tool to Operation Kit Dev, for an admin, in a live chat, by default', () => {
    expect(getDevOpsSwitch(DEV_OPS_BOT_SLUG)).toMatchObject({ eligible: true, enabled: true, is_default: true })
    expect(offered(ctx()).sort()).toEqual([...DEV_OPS_FNS].sort())
  })

  it('never offers them to another bot, a member, a card wake or a bot-to-bot wake', () => {
    expect(offered(ctx(OTHER))).toEqual([])
    expect(offered(ctx(DEV, { userId: MEMBER, username: 'sam' }))).toEqual([])
    expect(offered(ctx(DEV, { botWake: { conversationId: 1, depth: 1 } }))).toEqual([])
    expect(setDevOpsSwitch('other-bot', true, OWNER)).toBe(false)
    expect(getDevOpsSwitch('other-bot').enabled).toBe(false)
  })

  it('switched off: no tools, and a direct call is refused and audited', async () => {
    setDevOpsSwitch(DEV_OPS_BOT_SLUG, false, OWNER)
    expect(offered(ctx())).toEqual([])
    const before = auditCount()
    const out = await call('dev_merge_pr', { id: card() })
    expect((out.result as Loose).code).toBe('switch_off')
    expect(merges()).toHaveLength(0)
    expect(auditCount()).toBe(before + 1)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'switch_off', action: 'dev_merge_pr' })
  })

  it('an admin NOT typing in the browser (API key / bearer token / queued drain) gets no tools and is refused', async () => {
    expect(offered(ctx(DEV, { browserSession: false }))).toEqual([])
    const out = await call('dev_deploy', {}, ctx(DEV, { browserSession: false }))
    expect((out.result as Loose).code).toBe('not_browser')
    expect(host.calls).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'not_browser' })
  })

  it('an operator tool asked for in a card wake is refused and audited', async () => {
    const before = auditCount()
    await expect(call('dev_deploy', {}, ctx(DEV, { cardWake: { workspace: WS } as Loose }))).rejects.toThrow()
    expect(host.calls).toHaveLength(0)
    expect(auditCount()).toBe(before + 1)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'wake_turn' })
  })

  it('a member calling directly is refused and audited', async () => {
    const out = await call('dev_deploy', {}, ctx(DEV, { userId: MEMBER, username: 'sam' }))
    expect((out.result as Loose).code).toBe('not_admin')
    expect(host.calls).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'not_admin' })
  })
})

describe('2. merge relaxations', () => {
  it('merges a card that is already DONE once CI is green, pinned to the checked head', async () => {
    const id = card({ status: 'done' })
    const r = (await call('dev_merge_pr', { id })).result as Loose
    expect(r).toMatchObject({ ok: true, code: 'merged', card_done: true })
    expect(merges()).toHaveLength(1)
    expect(merges()[0]).toEqual(expect.arrayContaining(['--squash', '--match-head-commit', 'abc1234']))
    expect(statusOf(id)).toBe('done')
    expect(lastAudit()).toMatchObject({ action: 'merge', outcome: 'done', code: 'merged', objective_id: id })
  })

  it('merges a card with NO AI review yet, then marks it done', async () => {
    const id = card({ verdict: null })
    const r = (await call('dev_merge_pr', { id })).result as Loose
    expect(r).toMatchObject({ ok: true, code: 'merged', card_done: true })
    expect(statusOf(id)).toBe('done')
  })

  it('a FAILED review still refuses', async () => {
    const id = card({ verdict: 'fail' })
    const r = (await call('dev_merge_pr', { id })).result as Loose
    expect(r.code).toBe('review_failed')
    expect(fake.calls).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'review_failed' })
  })

  it('a card whose worker is still running, and another bot\'s card, refuse', async () => {
    expect(((await call('dev_merge_pr', { id: card({ status: 'working' }) })).result as Loose).code).toBe('card_still_running')
    expect(((await call('dev_merge_pr', { id: card({ owner: 'other-bot' }) })).result as Loose).code).toBe('not_dev_card')
    expect(merges()).toHaveLength(0)
  })

  it('a MEMBER\'s card that merely names Dev as owner is not a Dev card', async () => {
    const id = card({ createdBy: MEMBER })
    expect(((await call('dev_merge_pr', { id })).result as Loose).code).toBe('not_dev_card')
    expect(fake.calls).toHaveLength(0)
  })

  it('a card Dev FILED from chat counts as Dev-authored', async () => {
    const id = card({ owner: 'general' })
    getDb().prepare('INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, ?)').run(id, OWNER, DEV_OPS_BOT_SLUG)
    expect(((await call('dev_merge_pr', { id })).result as Loose).code).toBe('merged')
  })

  it('CI not green refuses with nothing merged', async () => {
    fake.pr.rollup = PENDING
    expect(((await call('dev_merge_pr', { id: card() })).result as Loose).code).toBe('ci_not_green')
    fake.pr.rollup = RED
    expect(((await call('dev_merge_pr', { id: card() })).result as Loose).code).toBe('ci_not_green')
    expect(merges()).toHaveLength(0)
  })
})

describe('3. a behind branch is updated, then merged when CI is green on the NEW head', () => {
  it('update-branch pinned to the read head → waits → merges pinned to the new head', async () => {
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.onUpdate = p => { p.headSha = 'def5678'; p.mergeStateStatus = 'BLOCKED'; p.rollup = PENDING }
    const id = card()
    const r = (await call('dev_merge_pr', { id })).result as Loose
    expect(r).toMatchObject({ ok: true, code: 'branch_updated_waiting_for_ci' })
    expect(updates()).toHaveLength(1)
    expect(updates()[0]).toEqual(expect.arrayContaining(['expected_head_sha=abc1234']))
    expect(merges()).toHaveLength(0)
    expect(statusOf(id)).toBe('review')
    expect(lastAudit()).toMatchObject({ action: 'branch_update', outcome: 'waiting' })

    // CI still running on the new head: nothing merges.
    let tick = await processPendingMerges()
    expect(tick.find(t => t.id === r.pending_id)?.outcome).toBe('waiting')
    expect(merges()).toHaveLength(0)

    // CI green on the new head, GitHub CLEAN: merged pinned to def5678, card done.
    fake.pr.rollup = GREEN
    fake.pr.mergeStateStatus = 'CLEAN'
    tick = await processPendingMerges()
    expect(tick.find(t => t.id === r.pending_id)?.outcome).toBe('merged')
    expect(merges()).toHaveLength(1)
    expect(merges()[0]).toEqual(expect.arrayContaining(['--match-head-commit', 'def5678']))
    expect(statusOf(id)).toBe('done')
    expect(lastAudit()).toMatchObject({ action: 'merge_on_green', outcome: 'done', code: 'merged' })
  })

  it('red CI on the updated head never merges', async () => {
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.onUpdate = p => { p.headSha = 'aaa9999'; p.mergeStateStatus = 'BLOCKED'; p.rollup = RED }
    const id = card()
    const r = (await call('dev_merge_pr', { id })).result as Loose
    const tick = await processPendingMerges()
    expect(tick.find(t => t.id === r.pending_id)?.outcome).toBe('failed')
    expect(merges()).toHaveLength(0)
    expect(statusOf(id)).toBe('review')
    expect(lastAudit()).toMatchObject({ action: 'merge_on_green', outcome: 'failed', code: 'ci_failed' })
  })

  it('a head that is NOT the update commit (someone pushed while waiting) is never merged', async () => {
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.onUpdate = p => { p.headSha = 'ccc2222'; p.mergeStateStatus = 'BLOCKED'; p.rollup = PENDING }
    const id = card()
    const r = (await call('dev_merge_pr', { id })).result as Loose
    // Someone pushes a different commit; CI goes green on it.
    fake.pr.headSha = 'eee4444'
    fake.pr.rollup = GREEN
    fake.pr.mergeStateStatus = 'CLEAN'
    const tick = await processPendingMerges()
    expect(tick.find(t => t.id === r.pending_id)?.outcome).toBe('failed')
    expect(merges()).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ action: 'merge_on_green', code: 'head_not_update_commit' })
  })

  it('a waiting merge is dropped when the card now links a different PR, or the PR becomes reserved', async () => {
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.onUpdate = p => { p.headSha = 'ddd3333'; p.mergeStateStatus = 'CLEAN'; p.rollup = GREEN }
    const a = card()
    const ra = (await call('dev_merge_pr', { id: a })).result as Loose
    getDb().prepare("UPDATE objectives SET pr_number = 9999, pr_url = 'https://github.com/acme/app/pull/9999' WHERE id = ?").run(a)
    let tick = await processPendingMerges()
    expect(tick.find(t => t.id === ra.pending_id)?.outcome).toBe('failed')

    fake.pr = { state: 'OPEN', mergeStateStatus: 'BEHIND', headSha: 'abc1234', rollup: GREEN, required: ['gate'] }
    const b = card({ prNumber: 4242 })
    const rb = (await call('dev_merge_pr', { id: b })).result as Loose
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('grant_merge_reserved_prs', 'acme/app#4242')").run()
    tick = await processPendingMerges()
    expect(tick.find(t => t.id === rb.pending_id)?.outcome).toBe('failed')
    expect(merges()).toHaveLength(0)
  })

  it('a waiting merge is dropped when the switch goes off', async () => {
    fake.pr.mergeStateStatus = 'BEHIND'
    fake.onUpdate = p => { p.headSha = 'bbb1111'; p.mergeStateStatus = 'CLEAN'; p.rollup = GREEN }
    const r = (await call('dev_merge_pr', { id: card() })).result as Loose
    setDevOpsSwitch(DEV_OPS_BOT_SLUG, false, OWNER)
    const tick = await processPendingMerges()
    expect(tick.find(t => t.id === r.pending_id)?.outcome).toBe('failed')
    expect(merges()).toHaveLength(0)
  })
})

describe('4. PR 645 stays reserved', () => {
  it.each(['your-org/operationkit', 'your-org/operationkit'])('refuses %s#645 before any GitHub call, even done / unreviewed', async repo => {
    const id = card({ prNumber: 645, repo, status: 'done', verdict: null })
    const r = (await call('dev_merge_pr', { id })).result as Loose
    expect(r.code).toBe('reserved_pr')
    expect(fake.calls).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'reserved_pr' })
  })

  it('refuses a PR the server-side setting reserves', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('grant_merge_reserved_prs', 'acme/app#777')").run()
    const r = (await call('dev_merge_pr', { id: card({ prNumber: 777 }) })).result as Loose
    expect(r.code).toBe('reserved_pr')
    expect(fake.calls).toHaveLength(0)
  })

  it('a card carrying 645 is never closed either', async () => {
    const id = card({ prNumber: 645, repo: 'your-org/operationkit' })
    fake.pr.state = 'MERGED'
    const r = (await call('dev_close_card', { id, status: 'done' })).result as Loose
    expect(r.code).toBe('reserved_pr')
    expect(statusOf(id)).toBe('review')
  })
})

describe('5. close cards the owner merged by hand', () => {
  it('done when GitHub says MERGED — no passing review or override needed', async () => {
    const id = card({ verdict: null, owner: 'other-bot' })
    fake.pr.state = 'MERGED'
    const r = (await call('dev_close_card', { id, status: 'done', note: 'Operator merged it' })).result as Loose
    expect(r).toMatchObject({ ok: true, code: 'closed' })
    expect(statusOf(id)).toBe('done')
    expect(lastAudit()).toMatchObject({ action: 'close_done', outcome: 'done' })
    const audit = getDb().prepare("SELECT actor, pathway FROM objective_audit WHERE objective_id = ? ORDER BY id DESC LIMIT 1").get(id) as Loose
    expect(audit?.pathway).toBe('dev-ops:close-done')
  })

  it('refuses done while the PR is still open', async () => {
    const id = card()
    const r = (await call('dev_close_card', { id, status: 'done' })).result as Loose
    expect(r.code).toBe('pr_not_merged')
    expect(statusOf(id)).toBe('review')
  })

  it('cancel: Dev\'s own card yes, another bot\'s card no', async () => {
    const mine = card({ prNumber: null })
    expect(((await call('dev_close_card', { id: mine, status: 'cancelled' })).result as Loose).code).toBe('closed')
    expect(statusOf(mine)).toBe('cancelled')
    const theirs = card({ prNumber: null, owner: 'other-bot' })
    expect(((await call('dev_close_card', { id: theirs, status: 'cancelled' })).result as Loose).code).toBe('not_dev_card')
    expect(statusOf(theirs)).toBe('review')
  })

  it('never a Strategy', async () => {
    fake.pr.state = 'MERGED'
    const id = card({ strategy: true })
    expect(((await call('dev_close_card', { id, status: 'done' })).result as Loose).code).toBe('strategy')
  })
})

describe('6. deploy: the standard update.sh flow', () => {
  it('starts the host runner detached with the exact paths; message names the exact command; no skip/force flag', async () => {
    const r = (await call('dev_deploy', { note: 'ship #880' })).result as Loose
    expect(r).toMatchObject({ ok: true, code: 'started' })
    expect(host.calls).toHaveLength(1)
    const c = host.calls[0]
    expect(c.opts.detached).toBe(true)
    expect(c.args).toEqual(['deploy', '/opt/operationkit-src', '/opt/operationkit-src/client.conf', String(r.deploy_id), 'https://ai.example.test/api/health', '/srv/ok/state/data'])
    expect(r.message).toContain('sudo bash /opt/operationkit-src/install/update.sh --config /opt/operationkit-src/client.conf')
    const argv = hostDockerArgs(c.image, c.args, c.opts, 'SCRIPT').join(' ')
    expect(argv).not.toMatch(/--skip-cloudflare|--skip-backup|--force/)
    // The runner's executable lines: update.sh is called exactly one way, and no line passes a skip/force flag.
    const code = fs.readFileSync(path.join(__dirname, 'host-runner.sh'), 'utf8').split('\n').filter(l => !/^\s*#/.test(l))
    expect(code.filter(l => l.includes('install/update.sh')).map(l => l.trim())).toEqual(['sudo bash "$SRC/install/update.sh" --config "$CONFIG_FILE"'])
    expect(code.join('\n')).not.toMatch(/--skip-cloudflare|--skip-backup|--force|--replace-dns/)
    expect(lastAudit()).toMatchObject({ action: 'deploy', outcome: 'started' })
  })

  it('one at a time', async () => {
    await call('dev_deploy', {})
    const second = (await call('dev_deploy', {})).result as Loose
    expect(second.code).toBe('deploy_running')
    expect(host.calls).toHaveLength(1)
    expect(lastAudit()).toMatchObject({ action: 'deploy', outcome: 'refused', code: 'deploy_running' })
  })

  it.each([
    ['deployed', 'done'],
    ['rolled_back', 'rolled_back'],
    ['rollback_failed', 'failed'],
  ])('settles a host outcome of %s', async (state, outcome) => {
    const r = (await call('dev_deploy', {})).result as Loose
    fs.writeFileSync(path.join(DATA_DIR, 'dev-ops', `deploy-${r.deploy_id}.json`), JSON.stringify({
      id: r.deploy_id, state, step: state === 'deployed' ? 'done' : 'verify',
      message: state === 'deployed' ? 'deployed' : `verify failed; rolled back with /opt/operationkit/backups/pre-update-x token ${FAKE_CF_TOKEN}`,
      from_sha: 'old', to_sha: 'new', backup_dir: '/opt/operationkit/backups/pre-update-x', log_tail: `...Bearer ${FAKE_CF_TOKEN}`,
    }))
    registerKnownSecret('OK_CF_API_TOKEN_TEST', FAKE_CF_TOKEN)
    const s = (await call('dev_deploy_status', {})).result as Loose
    expect(s.deploys[0]).toMatchObject({ id: r.deploy_id, status: state })
    expect(JSON.stringify(s)).not.toContain(FAKE_CF_TOKEN)
    const settled = getDb().prepare("SELECT * FROM dev_ops_audit WHERE action = 'deploy_settled' ORDER BY id DESC LIMIT 1").get() as Loose
    expect(settled).toMatchObject({ outcome, code: state })
    expect(allAuditText()).not.toContain(FAKE_CF_TOKEN)
  })

  it('a host that cannot start the run is a failed deploy, audited', async () => {
    host.reply = () => ({ code: 125, stdout: '', stderr: 'docker: Cannot connect to the Docker daemon' })
    const r = (await call('dev_deploy', {})).result as Loose
    expect(r.code).toBe('spawn_failed')
    expect(lastAudit()).toMatchObject({ action: 'deploy', outcome: 'failed', code: 'spawn_failed' })
  })
})

describe('7. Cloudflare guards', () => {
  it.each(['example.com', '@example.com', '*@example.com', 'everyone', 'a@x.com, b@y.com'])('never adds a domain / wildcard / list allow: %s', async email => {
    const r = (await call('cloudflare_access', { action: 'add', email })).result as Loose
    expect(r.ok).toBe(false)
    expect(['domain_allow_refused', 'bad_email']).toContain(r.code)
    expect(host.calls).toHaveLength(0)
    expect(lastAudit()).toMatchObject({ action: 'access_add', outcome: 'refused' })
  })

  it.each([SEEDED, 'Seeded-Owner@Example.test', OWNER_SIGNIN, 'installer@example.test', 'admin-user@example.test'])('never removes a protected address: %s', async email => {
    const r = (await call('cloudflare_access', { action: 'remove', email })).result as Loose
    expect(r).toMatchObject({ ok: false, code: 'protected' })
    expect(host.calls).toHaveLength(0)
  })

  it('adds one exact email through the host runner, request on stdin only', async () => {
    host.reply = () => ({ code: 0, stdout: '{"ok":true,"code":"added","email":"new.person@example.test"}\n', stderr: '' })
    const r = (await call('cloudflare_access', { action: 'add', email: 'New.Person@example.test' })).result as Loose
    expect(r).toMatchObject({ ok: true, code: 'added' })
    expect(host.calls[0].args).toEqual(['access-add', '/opt/operationkit-src', '/opt/operationkit-src/client.conf'])
    expect(JSON.parse(host.calls[0].opts.stdin)).toEqual({ email: 'new.person@example.test' })
    expect(lastAudit()).toMatchObject({ action: 'access_add', outcome: 'done', code: 'added' })
  })

  it('remove sends the protected list to the host on stdin (a second guard), never in argv, never back to the bot', async () => {
    host.reply = () => ({ code: 0, stdout: '{"ok":true,"code":"removed","email":"ex@example.test"}\n', stderr: '' })
    const out = await call('cloudflare_access', { action: 'remove', email: 'ex@example.test' })
    const c = host.calls[0]
    const req = JSON.parse(c.opts.stdin)
    expect(req.protected).toEqual(expect.arrayContaining([OWNER_SIGNIN, 'installer@example.test']))
    expect(req.protected_sha256).toEqual(expect.arrayContaining([...ACCESS_PROTECTED_SEED_SHA256, sha(SEEDED)]))
    const argv = hostDockerArgs(c.image, c.args, c.opts, 'SCRIPT').join(' ')
    expect(argv).not.toContain(OWNER_SIGNIN)
    expect(argv).not.toContain('ex@example.test')
    expect(JSON.stringify(out)).not.toContain(OWNER_SIGNIN)
  })

  it('DNS: outside the zone, the install\'s own record, NS records and bad values refuse before the host', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'upsert', type: 'A', name: 'evil.other.com', content: '1.2.3.4' }, 'outside_zone'],
      [{ action: 'delete', type: 'CNAME', name: 'ai.example.test' }, 'own_record'],
      [{ action: 'upsert', type: 'NS', name: 'x.example.test', content: 'ns1.evil.com' }, 'bad_type'],
      [{ action: 'upsert', type: 'A', name: 'x.example.test', content: 'not-an-ip' }, 'bad_content'],
    ]
    for (const [args, code] of cases) {
      const r = (await call('cloudflare_dns', args)).result as Loose
      expect(r).toMatchObject({ ok: false, code })
    }
    expect(host.calls).toHaveLength(0)
  })

  it('DNS upsert inside the zone goes to the host', async () => {
    host.reply = () => ({ code: 0, stdout: '{"ok":true,"code":"created","record":{"type":"TXT","name":"_dmarc.example.test"}}\n', stderr: '' })
    const r = (await call('cloudflare_dns', { action: 'upsert', type: 'TXT', name: '_dmarc.example.test', content: 'v=DMARC1; p=none' })).result as Loose
    expect(r).toMatchObject({ ok: true, code: 'created' })
    expect(JSON.parse(host.calls[0].opts.stdin)).toMatchObject({ action: 'upsert', type: 'TXT', name: '_dmarc.example.test', content: 'v=DMARC1; p=none' })
    expect(lastAudit()).toMatchObject({ action: 'dns_upsert', outcome: 'done' })
  })

  it('cloudflare.sh: only status / api-bypass / api-bic', async () => {
    for (const command of ['down', 'up', 'agent-pass']) {
      expect(((await call('cloudflare_run', { command })).result as Loose).code).toBe('bad_command')
    }
    expect(host.calls).toHaveLength(0)
    host.reply = () => ({ code: 0, stdout: '{"ok":true,"code":"ran","command":"status","output":"tunnel ok"}\n', stderr: '' })
    expect(((await call('cloudflare_run', { command: 'status' })).result as Loose).code).toBe('ran')
  })

  it('pure guards agree', () => {
    const prot = protectedAccessEmails()
    expect(prot).toEqual(expect.arrayContaining([OWNER_SIGNIN, 'installer@example.test', 'admin-user@example.test']))
    // The seed is two real hashes, frozen, carried by the host runner too, and config only ever ADDS to it.
    expect(ACCESS_PROTECTED_SEED_SHA256).toHaveLength(2)
    expect(Object.isFrozen(ACCESS_PROTECTED_SEED_SHA256)).toBe(true)
    for (const h of ACCESS_PROTECTED_SEED_SHA256) expect(h).toMatch(/^[0-9a-f]{64}$/)
    const runner = fs.readFileSync(path.join(__dirname, 'host-runner.sh'), 'utf8')
    for (const h of ACCESS_PROTECTED_SEED_SHA256) expect(runner).toContain(h)
    expect(protectedAccessHashes({ CC_DEV_OPS_PROTECTED_SHA256: 'garbage' })).toEqual([...ACCESS_PROTECTED_SEED_SHA256])
    expect(accessGuard('remove', SEEDED, [])).toMatchObject({ ok: false, code: 'protected' })
    expect(accessGuard('add', 'example.com', prot)).toMatchObject({ ok: false })
    expect(accessGuard('add', 'casey@example.com', prot)).toMatchObject({ ok: true, email: 'casey@example.com' })
    expect(dnsGuard({ action: 'upsert', type: 'MX', name: 'example.test', content: 'mx.example.net', priority: 10 }, { zone: 'example.test', domain: 'ai.example.test' })).toMatchObject({ ok: true })
  })
})

describe('8. secret values never reach the bot, the chat or the audit table', () => {
  it('a token in host output is redacted from the tool result and the audit row', async () => {
    registerKnownSecret('OK_CF_API_TOKEN_TEST', FAKE_CF_TOKEN)
    host.reply = () => ({ code: 0, stdout: `noise\n{"ok":false,"code":"command_failed","command":"status","output":"curl -H Authorization: Bearer ${FAKE_CF_TOKEN}","message":"leaked ${FAKE_CF_TOKEN}"}\n`, stderr: FAKE_CF_TOKEN })
    const out = await call('cloudflare_run', { command: 'status' })
    expect(JSON.stringify(out)).not.toContain(FAKE_CF_TOKEN)
    expect(allAuditText()).not.toContain(FAKE_CF_TOKEN)
  })

  it('the Access list result redacts a secret-valued address and never lists the protected set', async () => {
    registerKnownSecret('EMAILGUARD_EMAIL', OWNER_SIGNIN)
    host.reply = () => ({ code: 0, stdout: JSON.stringify({ ok: true, code: 'listed', allow: { emails: [SEEDED, OWNER_SIGNIN, 'casey@example.com'], domains: [], other_rules: 0 } }) + '\n', stderr: '' })
    const out = await call('cloudflare_access', { action: 'list' })
    const text = JSON.stringify(out)
    expect(text).not.toContain(OWNER_SIGNIN)
    expect(text).toContain('casey@example.com')
    expect((out.result as Loose).protected_count).toBeGreaterThan(0)
    expect((out.result as Loose).protected).toBeUndefined()
  })

  it('the docker argv for a deploy carries no secret and no request data', () => {
    const argv = hostDockerArgs('operationkit-app:local', ['deploy', '/opt/operationkit-src', '/opt/operationkit-src/client.conf', '7', 'https://ai.example.test/api/health', '/srv/ok/state/data'], { detached: true, name: 'ok-dev-ops-deploy-7' }, 'echo script')
    expect(argv.join(' ')).not.toContain(FAKE_CF_TOKEN)
    expect(argv).toEqual(expect.arrayContaining(['-d', '--privileged', '--pid=host', 'nsenter', 'bash', '-c']))
  })
})

describe('9. audit trail', () => {
  it('every dev-ops call writes a row, allowed or refused', async () => {
    const before = auditCount()
    await call('dev_ops_audit', { limit: 5 })
    await call('cloudflare_access', { action: 'add', email: '*@x.com' })
    await call('dev_merge_pr', { id: card({ verdict: 'fail' }) })
    await call('dev_close_card', { id: card(), status: 'done' })
    expect(auditCount()).toBe(before + 4)
  })

  it('a bad argument is refused and audited', async () => {
    const before = auditCount()
    await expect(call('dev_close_card', { id: card(), status: 'reopen' })).rejects.toThrow(/status must be/)
    expect(auditCount()).toBe(before + 1)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'bad_request', action: 'dev_close_card' })
  })

  it('a card the person cannot see is refused and audited', async () => {
    const before = auditCount()
    await expect(call('dev_merge_pr', { id: 999999 })).rejects.toThrow(/not on a board you can see/)
    expect(auditCount()).toBe(before + 1)
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'not_visible' })
  })
})
