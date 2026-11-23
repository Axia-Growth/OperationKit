/**
 * obj 901463 — the Dev merge queue, through the real chat tool entry point
 * (`runChatTool` → `dev_merge_pr`), a real temp SQLite DB, the real status
 * handler and the real background pass (`processPendingMerges`), with GitHub
 * replaced by a fake that models SEVERAL pull requests against one moving base:
 * a PR whose branch does not contain the latest base is BEHIND, update-branch
 * makes a new head and restarts its CI, and a merge moves the base so every
 * other open PR falls behind.
 *
 *  1. three PRs asked for in a row merge in that order with ONE branch update
 *     each; the two behind the head are not touched until they reach it;
 *  2. a conflicted PR (GitHub DIRTY) is skipped with an audit row and the PR
 *     behind it becomes the head in the same pass;
 *  3. waiting in the queue costs nothing: no update is counted and the 90-minute
 *     wait starts when a PR reaches the head; the update cap still holds there;
 *  4. every existing refusal still refuses, at ask time and again at the head;
 *  5. queue order is ask order, per repo; asking twice adds nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-merge-queue-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.GH_TOKEN = 'test-server-login'
process.env.JWT_SECRET = 'test-secret-merge-queue'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-merge-queue-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-merge-queue-kb-'))

// ── fake GitHub: many PRs, one base per repo ─────────────────────────────────
const GREEN = [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }]
const PENDING = [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '' }]
const RED = [{ name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }]

interface FakePr { repo: string; state: string; headSha: string; rollup: unknown[]; base: number; conflict: boolean }
const gh: { prs: Record<number, FakePr>; main: Record<string, number>; calls: string[][]; parents: Record<string, string[]>; shaSeq: number; staleClean: Set<number> } = {
  prs: {}, main: {}, calls: [], parents: {}, shaSeq: 0, staleClean: new Set(),
}
const mergeState = (p: FakePr) => p.conflict ? 'DIRTY' : p.base < (gh.main[p.repo] ?? 0) ? 'BEHIND' : JSON.stringify(p.rollup) === JSON.stringify(GREEN) ? 'CLEAN' : 'BLOCKED'
const newSha = () => (0xa000000 + ++gh.shaSeq).toString(16).padStart(12, '0')

async function fakeExec(file: string, args: string[]): Promise<string> {
  gh.calls.push([file, ...args])
  if (file !== 'gh') throw new Error(`unexpected exec ${file}`)
  if (args[0] === 'api') {
    const up = args.map(a => /^repos\/(.+)\/pulls\/(\d+)\/update-branch$/.exec(String(a))).find(Boolean)
    if (up && args.includes('PUT')) {
      const p = gh.prs[Number(up[2])]
      const expected = String(args.find(a => String(a).startsWith('expected_head_sha=')) ?? '').split('=')[1]
      if (expected !== p.headSha) throw new Error('HTTP 422: expected head sha didn’t match current head ref.')
      if (p.conflict) throw new Error('HTTP 422: merge conflict between base and head')
      const before = p.headSha
      p.headSha = newSha()
      gh.parents[p.headSha] = [before, 'base0000000000']
      p.base = gh.main[p.repo] ?? 0
      p.rollup = PENDING // GitHub starts a new CI run on the update commit
      return '{"message":"Updating pull request branch."}'
    }
    const cm = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)$/.exec(String(args[1]))
    if (cm) return JSON.stringify(gh.parents[cm[1]] ?? ['someone0000', 'else0000000'])
    if (String(args[1]).endsWith('/protection')) throw new Error('HTTP 404 Not Found')
    return JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'gate' }] } }])
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const p = gh.prs[Number(args[2])]
    const fields = args[args.indexOf('--json') + 1]
    if (fields === 'state,mergeStateStatus') return JSON.stringify({ state: p.state, mergeStateStatus: gh.staleClean.has(Number(args[2])) ? 'CLEAN' : mergeState(p) })
    return JSON.stringify({ number: Number(args[2]), url: `https://github.com/${p.repo}/pull/${args[2]}`, headRefOid: p.headSha, baseRefName: 'main', statusCheckRollup: p.rollup, state: p.state })
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const p = gh.prs[Number(args[2])]
    // The repo ruleset: up to date with the base, checks green, pinned head.
    if (args[args.indexOf('--match-head-commit') + 1] !== p.headSha) throw new Error('head commit mismatch')
    if (mergeState(p) !== 'CLEAN') {
      gh.staleClean.delete(Number(args[2])) // GitHub has caught up by the time it refuses
      throw new Error(`Pull request is not mergeable: ${mergeState(p)}`)
    }
    p.state = 'MERGED'
    gh.main[p.repo] = (gh.main[p.repo] ?? 0) + 1
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
vi.mock('../session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (s: string) => s }
})

const { initDb, getDb } = await import('../../db/index.js')
const { clearRequiredChecksCache } = await import('../ci-green-gate-github.js')
const { clearInstalledChatBotCache } = await import('../bots/card-owner.js')
const { runChatTool } = await import('../agent-chat/tools.js')
const { seedExistingBotsOnce } = await import('../agent-chat/bot-workspaces.js')
const { createWorkspace } = await import('../workspaces.js')
const { setDevOpsSwitch, DEV_OPS_BOT_SLUG } = await import('./switch.js')
const { processPendingMerges, PENDING_MERGE_TTL_MS, MAX_UPDATES } = await import('./merge.js')

type Agent = import('../agent-chat/agent-defs.js').ChatAgent
type Ctx = import('../agent-chat/tools.js').ToolContext
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const WS = 'operationkit'
const REPO = 'acme/app'
const DEV: Agent = {
  slug: DEV_OPS_BOT_SLUG, name: DEV_OPS_BOT_SLUG, description: '', avatar: '', colour: 'blue', system_prompt: 'You help.',
  knowledge_folders: [], tools: ['get_objective', 'list_objectives'], model: null, provider: null, schedules: [],
  version: null, author: null, how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
}
const ctx = (): Ctx => ({ userId: OWNER, username: 'operator', workspace: WS, agent: DEV, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } as Loose, browserSession: true })
const ask = async (id: number) => (await runChatTool(ctx(), 'dev_merge_pr', { id })).result as Loose

let prSeq = 1000
interface Spec { owner?: string; status?: string; verdict?: string | null; repo?: string; behind?: boolean; rollup?: unknown[]; conflict?: boolean; prNumber?: number }
/** A Dev card with an open PR. By default the PR is green on its head but BEHIND the base. */
function prCard(spec: Spec = {}): { id: number; pr: number } {
  const pr = spec.prNumber ?? ++prSeq
  const repo = spec.repo ?? REPO
  gh.main[repo] ??= 5
  gh.prs[pr] = { repo, state: 'OPEN', headSha: newSha(), rollup: spec.rollup ?? GREEN, base: (spec.behind ?? true) ? gh.main[repo] - 1 : gh.main[repo], conflict: !!spec.conflict }
  const id = Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, ai_review_verdict, type, pr_url, pr_number, is_strategy)
     VALUES (?, ?, ?, ?, ?, ?, 'task', ?, ?, 0)`,
  ).run(`merge queue fixture ${pr}`, spec.owner ?? DEV_OPS_BOT_SLUG, WS, OWNER, spec.status ?? 'review', spec.verdict === undefined ? 'pass' : spec.verdict, `https://github.com/${repo}/pull/${pr}`, pr).lastInsertRowid)
  return { id, pr }
}
const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const mergedPrs = () => gh.calls.filter(c => c[1] === 'pr' && c[2] === 'merge').map(c => Number(c[3]))
const updatesOf = (pr: number) => gh.calls.filter(c => c.some(a => String(a).endsWith(`/pulls/${pr}/update-branch`))).length
const callsFor = (pr: number) => gh.calls.filter(c => c.some(a => String(a) === String(pr) || String(a).includes(`/pulls/${pr}/`))).length
const row = (pr: number) => getDb().prepare('SELECT * FROM dev_ops_pending_merges WHERE pr_number = ? ORDER BY id DESC LIMIT 1').get(pr) as Loose
const waitingCount = () => (getDb().prepare("SELECT COUNT(*) AS n FROM dev_ops_pending_merges WHERE status = 'waiting'").get() as { n: number }).n
const audits = (pr: number) => getDb().prepare('SELECT action, outcome, code, detail FROM dev_ops_audit WHERE target = ? ORDER BY id').all(`${gh.prs[pr].repo}#${pr}`) as Array<{ action: string; outcome: string; code: string; detail: string }>
const green = (pr: number) => { gh.prs[pr].rollup = GREEN }
/** Something else lands on the base outside the queue. */
const landOutside = (repo = REPO) => { gh.main[repo] += 1 }

beforeAll(() => {
  fs.mkdirSync(path.join(TMP_AGENTS, DEV_OPS_BOT_SLUG), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, DEV_OPS_BOT_SLUG, 'agent.yaml'), `name: ${DEV_OPS_BOT_SLUG}\nsystem_prompt: You are dev.\nknowledge_folders: []\ntools: [get_objective, list_objectives]\nversion: 1.0.0\nauthor: Test\n`)
  clearInstalledChatBotCache()
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role, email) VALUES (?, 'operator', 'x', 'admin', 'admin-user@example.test')`).run(OWNER)
  createWorkspace({ slug: WS, name: 'Operation Kit', default_agent_pool: ['general'] })
  seedExistingBotsOnce([DEV_OPS_BOT_SLUG])
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

beforeEach(() => {
  clearRequiredChecksCache()
  gh.prs = {}
  gh.main = {}
  gh.calls = []
  gh.parents = {}
  gh.staleClean = new Set()
  getDb().prepare('DELETE FROM agent_chat_dev_ops').run()
  getDb().prepare("DELETE FROM settings WHERE key = 'grant_merge_reserved_prs'").run()
  getDb().prepare("UPDATE dev_ops_pending_merges SET status = 'failed' WHERE status = 'waiting'").run()
})

describe('1. three PRs asked for in a row merge one at a time, in order', () => {
  it('one branch update each; a PR behind the head is not touched until it is the head', async () => {
    const a = prCard(), b = prCard(), c = prCard()

    const ra = await ask(a.id)
    expect(ra).toMatchObject({ ok: true, code: 'branch_updated_waiting_for_ci', queue_position: 1 })
    const rb = await ask(b.id)
    expect(rb).toMatchObject({ ok: true, code: 'queued_behind', queue_position: 2, queue_ahead: [a.pr] })
    const rc = await ask(c.id)
    expect(rc).toMatchObject({ ok: true, code: 'queued_behind', queue_position: 3, queue_ahead: [a.pr, b.pr] })
    expect(rc.message).toContain(`position 3, behind PR #${a.pr}, PR #${b.pr}`)

    // Only the head was updated. The audit row says where the others sit.
    expect([updatesOf(a.pr), updatesOf(b.pr), updatesOf(c.pr)]).toEqual([1, 0, 0])
    expect(audits(b.pr).at(-1)).toMatchObject({ action: 'merge', outcome: 'waiting', code: 'queued_behind' })
    expect(audits(c.pr).at(-1)!.detail).toContain('position 3')
    expect(row(b.pr)).toMatchObject({ status: 'waiting', stage: 'queued', updates: 0, head_at: null })

    // CI still running on A: nothing moves, and B / C get no GitHub call at all.
    const touchedAtAsk = callsFor(b.pr) + callsFor(c.pr)
    let tick = await processPendingMerges()
    expect(tick.map(t => [t.id, t.outcome, t.queue_position])).toEqual([[ra.pending_id, 'waiting', 1], [rb.pending_id, 'queued', 2], [rc.pending_id, 'queued', 3]])
    expect(callsFor(b.pr) + callsFor(c.pr)).toBe(touchedAtAsk)
    expect(mergedPrs()).toEqual([])

    // A goes green: it merges. B is not started in the same pass (the base just moved).
    green(a.pr)
    tick = await processPendingMerges()
    expect(tick.find(t => t.id === ra.pending_id)?.outcome).toBe('merged')
    expect(mergedPrs()).toEqual([a.pr])
    expect(updatesOf(b.pr)).toBe(0)
    expect(audits(b.pr).at(-1)).toMatchObject({ action: 'merge_queue', code: 'queue_next' })
    expect(audits(c.pr).at(-1)).toMatchObject({ action: 'merge_queue', code: 'queued_behind' })
    expect(audits(c.pr).at(-1)!.detail).toContain(`position 2 in the merge queue for ${REPO}, behind PR #${b.pr}`)

    // Next pass: B is the head and is updated once. C still untouched.
    tick = await processPendingMerges()
    expect(tick.find(t => t.id === rb.pending_id)).toMatchObject({ outcome: 'updated', queue_position: 1 })
    expect([updatesOf(b.pr), updatesOf(c.pr)]).toEqual([1, 0])
    expect(audits(b.pr).map(x => x.code)).toEqual(expect.arrayContaining(['queue_head', 'branch_updated_waiting_for_ci']))
    expect(row(b.pr)).toMatchObject({ stage: 'updated', updates: 1 })

    green(b.pr)
    await processPendingMerges() // B merges
    await processPendingMerges() // C becomes the head, updated once
    expect(mergedPrs()).toEqual([a.pr, b.pr])
    expect(updatesOf(c.pr)).toBe(1)
    green(c.pr)
    await processPendingMerges()

    expect(mergedPrs()).toEqual([a.pr, b.pr, c.pr])
    expect([updatesOf(a.pr), updatesOf(b.pr), updatesOf(c.pr)]).toEqual([1, 1, 1])
    expect([a, b, c].map(x => statusOf(x.id))).toEqual(['done', 'done', 'done'])
    expect(waitingCount()).toBe(0)
    // Each merge was pinned to that PR's own update commit.
    for (const m of gh.calls.filter(x => x[1] === 'pr' && x[2] === 'merge')) {
      expect(m[m.indexOf('--match-head-commit') + 1]).toBe(gh.prs[Number(m[3])].headSha)
    }
  })
})

describe('2. a conflicted PR is skipped and does not block the queue', () => {
  it('DIRTY at the head → conflict_skipped, and the PR behind it is started in the same pass', async () => {
    const a = prCard(), b = prCard(), c = prCard()
    await ask(a.id)
    const rb = await ask(b.id)
    const rc = await ask(c.id)
    green(a.pr)
    await processPendingMerges() // A merges
    gh.prs[b.pr].conflict = true // A's merge left B in conflict with main

    const tick = await processPendingMerges()
    expect(tick.find(t => t.id === rb.pending_id)?.outcome).toBe('failed')
    expect(tick.find(t => t.id === rc.pending_id)).toMatchObject({ outcome: 'updated', queue_position: 1 })
    expect(audits(b.pr).at(-1)).toMatchObject({ action: 'merge_on_green', outcome: 'failed', code: 'conflict_skipped' })
    expect(audits(b.pr).at(-1)!.detail).toMatch(/conflicts with main .* skipped/)
    expect(updatesOf(b.pr)).toBe(0)
    expect(statusOf(b.id)).toBe('review')

    green(c.pr)
    await processPendingMerges()
    expect(mergedPrs()).toEqual([a.pr, c.pr])
    expect(statusOf(c.id)).toBe('done')
  })

  it('a PR already in conflict when it is asked for is refused as before and never queued', async () => {
    const a = prCard()
    await ask(a.id)
    const d = prCard({ conflict: true })
    expect((await ask(d.id)).code).toBe('pr_not_mergeable')
    expect(waitingCount()).toBe(1)
  })
})

describe('3. waiting in the queue does not count against the update cap or the wait limit', () => {
  it('the head is re-updated when main moves outside the queue; the PR behind it stays at zero updates', async () => {
    const a = prCard(), b = prCard()
    await ask(a.id)
    await ask(b.id)
    for (let n = 2; n <= MAX_UPDATES; n++) {
      landOutside()
      const tick = await processPendingMerges()
      expect(tick[0]).toMatchObject({ outcome: 'updated_again' })
      expect(row(a.pr).updates).toBe(n)
      expect(row(b.pr)).toMatchObject({ stage: 'queued', updates: 0, status: 'waiting' })
    }
    expect([updatesOf(a.pr), updatesOf(b.pr)]).toEqual([MAX_UPDATES, 0])

    // The cap still holds at the head: one more fall-behind drops A, and B takes over at once.
    landOutside()
    const tick = await processPendingMerges()
    expect(audits(a.pr).at(-1)).toMatchObject({ code: 'too_many_updates', outcome: 'failed' })
    expect(updatesOf(a.pr)).toBe(MAX_UPDATES)
    expect(tick.find(t => t.id === row(b.pr).id)).toMatchObject({ outcome: 'updated' })

    // B has its full allowance: it can still fall behind and be updated up to the cap, then merge.
    for (let n = 2; n <= MAX_UPDATES; n++) {
      landOutside()
      await processPendingMerges()
    }
    expect(row(b.pr)).toMatchObject({ updates: MAX_UPDATES, status: 'waiting' })
    green(b.pr)
    await processPendingMerges()
    expect(mergedPrs()).toEqual([b.pr])
  })

  it('the 90-minute limit starts when a PR reaches the head, not when it was asked for', async () => {
    const a = prCard(), b = prCard()
    const t0 = Date.now()
    await ask(a.id)
    const rb = await ask(b.id)

    // A spends 80 minutes at the head, then merges.
    green(a.pr)
    await processPendingMerges({ now: () => t0 + 80 * 60_000 })
    expect(mergedPrs()).toEqual([a.pr])
    // B reaches the head 85 minutes after it was asked for…
    await processPendingMerges({ now: () => t0 + 85 * 60_000 })
    expect(updatesOf(b.pr)).toBe(1)
    // …and at 150 minutes it has only been the head for 65: still waiting, then merges.
    let tick = await processPendingMerges({ now: () => t0 + 150 * 60_000 })
    expect(tick.find(t => t.id === rb.pending_id)?.outcome).toBe('waiting')
    green(b.pr)
    tick = await processPendingMerges({ now: () => t0 + 151 * 60_000 })
    expect(tick.find(t => t.id === rb.pending_id)?.outcome).toBe('merged')
  })

  it('a head whose CI never goes green still expires 90 minutes after reaching the head', async () => {
    const a = prCard(), b = prCard()
    const t0 = Date.now()
    const ra = await ask(a.id)
    const rb = await ask(b.id)
    const tick = await processPendingMerges({ now: () => t0 + PENDING_MERGE_TTL_MS + 60_000 })
    expect(tick.find(t => t.id === ra.pending_id)?.outcome).toBe('expired')
    expect(tick.find(t => t.id === rb.pending_id)).toMatchObject({ outcome: 'updated' })
    expect(mergedPrs()).toEqual([])
  })
})

describe('4. every existing refusal still refuses', () => {
  it('at ask time, with a queue already running: nothing is queued, updated or merged', async () => {
    const a = prCard()
    await ask(a.id)
    gh.calls = []

    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('grant_merge_reserved_prs', 'acme/app#777')").run()
    expect((await ask(prCard({ prNumber: 777 }).id)).code).toBe('reserved_pr')
    expect((await ask(prCard({ prNumber: 645, repo: 'your-org/operationkit' }).id)).code).toBe('reserved_pr')
    expect((await ask(prCard({ verdict: 'fail' }).id)).code).toBe('review_failed')
    expect((await ask(prCard({ status: 'working' }).id)).code).toBe('card_still_running')
    expect((await ask(prCard({ status: 'cancelled' }).id)).code).toBe('card_cancelled')
    expect((await ask(prCard({ owner: 'other-bot' }).id)).code).toBe('not_dev_card')
    expect(gh.calls).toHaveLength(0) // all refused before any GitHub call

    expect((await ask(prCard({ behind: false, rollup: RED }).id)).code).toBe('ci_not_green')
    expect((await ask(prCard({ behind: false, rollup: PENDING }).id)).code).toBe('ci_not_green')
    const closed = prCard()
    gh.prs[closed.pr].state = 'CLOSED'
    expect((await ask(closed.id)).code).toBe('pr_not_open')

    expect(waitingCount()).toBe(1)
    expect(mergedPrs()).toEqual([])
    expect(gh.calls.filter(c => c.some(x => String(x).endsWith('/update-branch')))).toHaveLength(0)
  })

  it('a queued PR is re-checked when it reaches the head and dropped untouched if a guard now refuses', async () => {
    const a = prCard(), failedReview = prCard(), running = prCard(), reserved = prCard(), pushed = prCard(), redCi = prCard({ behind: false }), ok = prCard()
    await ask(a.id)
    for (const x of [failedReview, running, reserved, pushed, redCi, ok]) expect((await ask(x.id)).code).toBe('queued_behind')

    // While they wait: a review fails, a worker restarts, a PR becomes reserved, someone pushes, CI goes red.
    getDb().prepare("UPDATE objectives SET ai_review_verdict = 'fail' WHERE id = ?").run(failedReview.id)
    getDb().prepare("UPDATE objectives SET status = 'working' WHERE id = ?").run(running.id)
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('grant_merge_reserved_prs', ?)").run(`${REPO}#${reserved.pr}`)
    gh.prs[pushed.pr].headSha = newSha()
    gh.prs[redCi.pr].rollup = RED
    green(a.pr)
    await processPendingMerges() // A merges
    const atAsk = new Map([failedReview, running, reserved].map(x => [x.pr, callsFor(x.pr)]))

    await processPendingMerges()
    expect(audits(failedReview.pr).at(-1)).toMatchObject({ outcome: 'failed', code: 'review_failed' })
    expect(audits(running.pr).at(-1)).toMatchObject({ outcome: 'failed', code: 'card_still_running' })
    expect(audits(reserved.pr).at(-1)).toMatchObject({ outcome: 'failed', code: 'reserved_pr' })
    expect(audits(pushed.pr).at(-1)).toMatchObject({ outcome: 'failed', code: 'head_changed_while_queued' })
    for (const x of [failedReview, running, reserved, pushed]) expect(updatesOf(x.pr)).toBe(0)
    // Guards that need no GitHub call made none for those PRs.
    for (const x of [failedReview, running, reserved]) expect(callsFor(x.pr)).toBe(atAsk.get(x.pr)) // nothing since the read at ask time

    // redCi reached the head in that same pass and was updated; its new CI run fails → never merged.
    expect(updatesOf(redCi.pr)).toBe(1)
    gh.prs[redCi.pr].rollup = RED
    await processPendingMerges()
    expect(audits(redCi.pr).at(-1)).toMatchObject({ outcome: 'failed', code: 'ci_failed' })

    // The one healthy PR at the back still gets through.
    expect(updatesOf(ok.pr)).toBe(1)
    green(ok.pr)
    await processPendingMerges()
    expect(mergedPrs()).toEqual([a.pr, ok.pr])
    for (const x of [failedReview, running, reserved, pushed, redCi]) expect(statusOf(x.id)).not.toBe('done')
  })

  it('switching the operator tools off drops the whole queue without a GitHub call', async () => {
    const a = prCard(), b = prCard(), c = prCard()
    for (const x of [a, b, c]) await ask(x.id)
    setDevOpsSwitch(DEV_OPS_BOT_SLUG, false, OWNER)
    gh.calls = []
    const tick = await processPendingMerges()
    expect(tick.map(t => t.outcome)).toEqual(['failed', 'failed', 'failed'])
    expect(gh.calls).toHaveLength(0)
    expect(waitingCount()).toBe(0)
  })

  it('an update commit is still the only new head that may merge (a push at the head is refused)', async () => {
    const a = prCard(), b = prCard()
    await ask(a.id)
    await ask(b.id)
    gh.prs[a.pr].headSha = newSha() // someone pushes on top of the update commit
    green(a.pr)
    await processPendingMerges()
    expect(audits(a.pr).at(-1)).toMatchObject({ code: 'head_not_update_commit', outcome: 'failed' })
    expect(mergedPrs()).toEqual([])
    expect(updatesOf(b.pr)).toBe(1) // B took over
  })
})

describe('5. order and membership', () => {
  it('a PR that could merge right now still waits its turn behind the queue', async () => {
    const a = prCard()
    const ready = prCard({ behind: false })
    await ask(a.id)
    const r = await ask(ready.id)
    expect(r).toMatchObject({ code: 'queued_behind', queue_position: 2 })
    expect(mergedPrs()).toEqual([])
    green(a.pr)
    await processPendingMerges()
    await processPendingMerges()
    green(ready.pr)
    await processPendingMerges()
    expect(mergedPrs()).toEqual([a.pr, ready.pr])
    expect(updatesOf(ready.pr)).toBe(1)
  })

  it('a queued PR that is still up to date and green when it reaches the head merges with no update', async () => {
    const a = prCard(), b = prCard()
    await ask(a.id)
    await ask(b.id)
    gh.prs[a.pr].state = 'CLOSED' // A is closed by hand: main does not move
    gh.prs[b.pr].base = gh.main[REPO] // B's worker had merged main itself before the ask
    await processPendingMerges()
    expect(mergedPrs()).toEqual([b.pr])
    expect(updatesOf(b.pr)).toBe(0)
  })

  it('asking again for a queued PR adds nothing and reports its place', async () => {
    const a = prCard(), b = prCard()
    await ask(a.id)
    await ask(b.id)
    const again = await ask(b.id)
    expect(again).toMatchObject({ ok: true, code: 'already_queued', queue_position: 2, queue_ahead: [a.pr] })
    expect((await ask(a.id))).toMatchObject({ code: 'already_queued', queue_position: 1 })
    expect(waitingCount()).toBe(2)
    expect(updatesOf(a.pr) + updatesOf(b.pr)).toBe(1)
  })

  it('each repo has its own queue', async () => {
    const a = prCard()
    const other = prCard({ repo: 'acme/site' })
    await ask(a.id)
    expect(await ask(other.id)).toMatchObject({ code: 'branch_updated_waiting_for_ci', queue_position: 1 })
    green(a.pr)
    green(other.pr)
    await processPendingMerges()
    expect(mergedPrs().sort()).toEqual([a.pr, other.pr].sort())
  })

  it('GitHub briefly calling a behind PR mergeable does not drop it: the refused merge leaves it at the head', async () => {
    const a = prCard(), b = prCard({ behind: false })
    await ask(a.id)
    await ask(b.id)
    green(a.pr)
    await processPendingMerges() // A merges; B is really behind now
    gh.staleClean.add(b.pr) // …but GitHub's view still says CLEAN for a moment

    let tick = await processPendingMerges()
    expect(tick.find(t => t.id === row(b.pr).id)?.outcome).toBe('waiting')
    expect(row(b.pr).status).toBe('waiting')
    expect(gh.prs[b.pr].state).toBe('OPEN')

    tick = await processPendingMerges() // now read as BEHIND: updated once
    expect(tick.find(t => t.id === row(b.pr).id)?.outcome).toBe('updated')
    green(b.pr)
    await processPendingMerges()
    expect(gh.prs[b.pr].state).toBe('MERGED')
    expect(updatesOf(b.pr)).toBe(1)
  })
})
