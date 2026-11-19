/**
 * obj 901388 — standing merge: a bot merges its OWN passed PR under the owner's
 * merge grant without being asked, only when that grant has "Merge without
 * asking me each time" on.
 *
 * Real temp SQLite DB, the real grant rule (`decideStandingMergeApproval` →
 * the shared `grantDecision`), the real merge path (`runGrantApprovedMerge` →
 * `mergeUnderGrant`) and the real status handler; GitHub is a fake `gh`.
 *
 *  1. switch off (or no grant) → nothing merges on a passed review, nothing is written;
 *  2. switch on + every guard met → merged ONCE, card done, `approval_used`
 *     labelled `standing:<slug>`, one chat line to the grantor; repeated
 *     sweeps never merge twice;
 *  3. each refusal → no merge, card stays in review, ONE note that survives
 *     repeated sweeps: another bot's card, verdict not pass, CI red, reserved
 *     PR (no GitHub call), expired grant (date + where to renew, told once in
 *     chat), revoked grant, grantor no longer admin;
 *  4. CI still running → a wait (no note, no audit), merged once green; the
 *     wait is bounded, then it is one refusal;
 *  5. a NEW AI review after a refusal is a new attempt;
 *  6. the grant switch: off by default, merge-only, set by createGrant;
 *  7. `auto_merge_enabled` is never read or written; the kick is a no-op off-host.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-standing-merge-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
// obj 901372: model an install whose SERVER has its own GitHub login, so both the
// CI look and the merge run through the (faked) server `gh`.
process.env.GH_TOKEN = 'test-server-login'
process.env.JWT_SECRET = 'test-secret-standing-merge'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_REDACT_ENV_FILES = ''
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-standing-merge-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

// ── fake GitHub (same shape as grant-merge-tool.test.ts) ─────────────────────
interface FakePr {
  state: string
  mergeStateStatus: string
  headSha: string
  rollup: unknown[]
  required: string[]
}
const fake: { pr: FakePr; calls: string[][] } = {
  pr: { state: 'OPEN', mergeStateStatus: 'CLEAN', headSha: 'abc1234', rollup: [], required: [] },
  calls: [],
}

async function fakeExec(file: string, args: string[]): Promise<string> {
  fake.calls.push([file, ...args])
  if (file !== 'gh') throw new Error(`unexpected exec ${file}`)
  const p = fake.pr
  if (args[0] === 'api') {
    if (args.some(a => String(a).endsWith('/update-branch'))) {
      // GitHub update-branch (main's PR 896): a new head from the base, CI restarts on it.
      p.mergeStateStatus = 'CLEAN'
      p.headSha = 'def5678'
      p.rollup = [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '' }]
      return '{}'
    }
    if (String(args[1]).endsWith('/protection')) throw new Error('HTTP 404 Not Found')
    return JSON.stringify(p.required.length ? [{ type: 'required_status_checks', parameters: { required_status_checks: p.required.map(c => ({ context: c })) } }] : [])
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const fields = args[args.indexOf('--json') + 1]
    if (fields === 'state,mergeStateStatus') return JSON.stringify({ state: p.state, mergeStateStatus: p.mergeStateStatus })
    return JSON.stringify({ number: Number(args[2]), url: `https://github.com/acme/app/pull/${args[2]}`, headRefOid: p.headSha, baseRefName: 'main', statusCheckRollup: p.rollup, state: p.state })
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    p.state = 'MERGED'
    return ''
  }
  throw new Error(`unexpected gh ${args.join(' ')}`)
}

vi.mock('./ci-green-gate-github.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defaultExec: (f: string, a: string[]) => fakeExec(f, a) }
})
vi.mock('./worktree-reaper.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, scheduleObjectiveWorktreeReap: () => {} }
})
vi.mock('./session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (s: string) => s }
})

const { initDb, getDb } = await import('../db/index.js')
const { createGrant, revokeGrant, DelegationError } = await import('./delegated-approvals.js')
const { clearRequiredChecksCache } = await import('./ci-green-gate-github.js')
const { clearInstalledChatBotCache } = await import('./bots/card-owner.js')
const { chatBotGrantName } = await import('./agent-chat/grant-merge-tool.js')
const { seedExistingBotsOnce } = await import('./agent-chat/bot-workspaces.js')
const { createWorkspace } = await import('./workspaces.js')
const { findAgent } = await import('./agent-chat/engine.js')
const sm = await import('./standing-merge.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const OWNER = 1
const ANN = 3 // a second admin, demoted in one test
const GROWTH = 'growth'

const GREEN = [
  { name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { context: 'harness/test-agent', state: 'PENDING' },
]

let seq = 0
function card(spec: { worker?: string; ownerBot?: string | null; status?: string; verdict?: string | null; prNumber?: number; repo?: string; session?: string } = {}): number {
  seq += 1
  const n = spec.prNumber ?? 500 + seq
  const repo = spec.repo ?? 'acme/app'
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, agent_context, owner_bot, workspace, created_by, status, ai_review_verdict, type, pr_url, pr_number, ai_review_session_id, ai_review_iteration)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'task', ?, ?, ?, 1)`,
  ).run(
    `standing merge fixture ${seq}`,
    spec.worker ?? 'dev',
    spec.ownerBot ?? null,
    GROWTH,
    OWNER,
    spec.status ?? 'review',
    spec.verdict === undefined ? 'pass' : spec.verdict,
    `https://github.com/${repo}/pull/${n}`,
    n,
    spec.session ?? `rev-${seq}`,
  ).lastInsertRowid)
}

function grant(opts: { standing?: boolean; actions?: string[]; grantor?: { id: number; username: string }; now?: Date; expiresAt?: string } = {}) {
  const botName = chatBotGrantName(findAgent('dev')!)
  if (!botName) throw new Error('no grant identity for dev')
  return createGrant(getDb(), {
    grantor: opts.grantor ?? { id: OWNER, username: 'operator' },
    botName,
    agentSlug: 'dev',
    workspace: GROWTH,
    actions: opts.actions ?? ['merge'],
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
    allowedWorkspaces: [GROWTH],
    standingMerge: opts.standing ?? true,
    now: opts.now,
  })
}

const statusOf = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const merges = () => fake.calls.filter(c => c[1] === 'pr' && c[2] === 'merge')
const audits = (id: number) => getDb().prepare('SELECT * FROM delegation_audit WHERE objective_id = ? ORDER BY id').all(id) as Loose[]
const notes = (id: number) =>
  getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'standing_merge_refused'").all(id) as Loose[]
const chat = () => getDb().prepare("SELECT * FROM agent_chat_messages WHERE agent_slug = 'dev' ORDER BY id").all() as Loose[]
const autoMergeSetting = () => (getDb().prepare("SELECT value FROM settings WHERE key = 'auto_merge_enabled'").get() as { value: string } | undefined)?.value
const notify = vi.fn()
const sweep = (extra: Partial<Parameters<typeof sm.runStandingMergeSweep>[0]> = {}) => sm.runStandingMergeSweep({ notify, ...extra })

/** Sweep three times (repeated poller ticks) and expect the one refusal, written once. */
async function expectRefusedOnce(id: number, code: string) {
  const first = await sweep()
  expect(first.find(r => r.objective_id === id)).toMatchObject({ outcome: 'refused', code })
  await sweep()
  await sweep()
  expect(merges()).toHaveLength(0)
  expect(statusOf(id)).toBe('review')
  const n = notes(id)
  expect(n).toHaveLength(1)
  expect(JSON.parse(n[0].metadata)).toMatchObject({ code, slug: 'dev' })
  return n[0]
}

beforeAll(() => {
  for (const slug of ['dev', 'other-bot']) {
    fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
    fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${slug}\nsystem_prompt: You are ${slug}.\nknowledge_folders: []\ntools: [get_objective, list_objectives]\nversion: 1.0.0\nauthor: Test\n`)
  }
  clearInstalledChatBotCache()
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(OWNER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'ann', 'x', 'admin')`).run(ANN)
  createWorkspace({ slug: GROWTH, name: 'Growth', default_agent_pool: ['general'] })
  seedExistingBotsOnce(['dev', 'other-bot'])
})

afterAll(() => {
  sm.stopStandingMergeSweeper()
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(() => {
  sm.resetStandingMergeState()
  notify.mockClear()
  clearRequiredChecksCache()
  fake.pr = { state: 'OPEN', mergeStateStatus: 'CLEAN', headSha: 'abc1234', rollup: GREEN, required: ['gate'] }
  fake.calls = []
  const db = getDb()
  db.prepare('DELETE FROM delegation_grants').run()
  db.prepare('DELETE FROM delegation_audit').run()
  db.prepare('DELETE FROM agent_chat_messages').run()
  db.prepare("UPDATE objectives SET status = 'done' WHERE status = 'review'").run() // earlier fixtures out of the way
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ANN)
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_merge_enabled', '0')").run()
  db.prepare("DELETE FROM settings WHERE key = 'grant_merge_reserved_prs'").run()
  delete process.env.CC_STANDING_MERGE_CI_WAIT_MINUTES
})

describe('1. switch off → nothing merges on a passed review (today, byte for byte)', () => {
  it('no grant at all: the sweep reads nothing and does nothing', async () => {
    const id = card()
    expect(await sweep()).toEqual([])
    expect(fake.calls).toHaveLength(0)
    expect(statusOf(id)).toBe('review')
    expect(notes(id)).toHaveLength(0)
    expect(audits(id)).toHaveLength(0)
  })

  it('an active merge grant WITHOUT the switch: still nothing (the person must ask in chat)', async () => {
    const g = grant({ standing: false })
    expect(g.standing_merge).toBe(false)
    const id = card()
    expect(await sweep()).toEqual([])
    expect(fake.calls).toHaveLength(0)
    expect(statusOf(id)).toBe('review')
    expect(notes(id)).toHaveLength(0)
    expect(audits(id)).toHaveLength(0)
    expect(chat()).toHaveLength(0)
  })
})

describe('2. switch on + every guard met → merged once', () => {
  it('squash-merges pinned to the checked SHA, marks done, audits as standing:dev and tells the grantor in chat', async () => {
    const g = grant()
    expect(g.standing_merge).toBe(true)
    const id = card()
    const out = await sweep()
    expect(out).toEqual([{ objective_id: id, outcome: 'merged', grant_id: g.id }])

    expect(merges()).toHaveLength(1)
    expect(merges()[0]).toEqual(expect.arrayContaining(['--squash', '--delete-branch', '--repo', 'acme/app', '--match-head-commit', 'abc1234']))
    expect(statusOf(id)).toBe('done')

    const used = audits(id).filter(a => a.event === 'approval_used')
    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({ grant_id: g.id, action: 'merge', bot_name: 'dev', agent_key_id: null, agent_key_label: 'standing:dev', actor: 'operator' })
    expect(used[0].reason).toContain('grant_merge:squash-merged acme/app#')

    const line = getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = 'grant_merge'").get(id) as Loose
    expect(JSON.parse(line.metadata)).toMatchObject({ agent_key_label: 'standing:dev', grant_id: g.id })
    const moved = getDb().prepare("SELECT * FROM objective_audit WHERE objective_id = ? AND to_status = 'done'").get(id) as Loose
    expect(moved.pathway).toBe(`grant-merge:#${g.id}`)
    expect(String(moved.actor)).toContain('standing:dev')

    const msgs = chat()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].user_id).toBe(OWNER)
    expect(msgs[0].content).toContain(`PR #${500 + seq}`)
    expect(msgs[0].content).toContain(`card #${id}`)
    expect(msgs[0].content).toContain('Merged, not live until you deploy.')
    expect(notify).toHaveBeenCalledWith(OWNER, 'dev')
    expect(notes(id)).toHaveLength(0)
  })

  it('repeated sweeps, and a kick racing a sweep, never merge twice', async () => {
    grant()
    const id = card()
    await Promise.all([sweep(), sweep({ onlyCardId: id })])
    await sweep()
    await sweep()
    expect(merges()).toHaveLength(1)
    expect(statusOf(id)).toBe('done')
    expect(chat()).toHaveLength(1)
  })

  it('a card in another state, or with no PR, is never looked at', async () => {
    grant()
    const working = card({ status: 'working' })
    const noPr = card()
    getDb().prepare('UPDATE objectives SET pr_number = NULL, pr_url = NULL WHERE id = ?').run(noPr)
    expect(await sweep()).toEqual([])
    expect(fake.calls).toHaveLength(0)
    expect(statusOf(working)).toBe('working')
  })
})

describe('3. each refusal → no merge, card stays in review, one note', () => {
  it("another bot's card (worked under dev's slug, owned by other-bot)", async () => {
    grant()
    const id = card({ ownerBot: 'other-bot' })
    const n = await expectRefusedOnce(id, 'not_owned')
    expect(n.title).toContain('not one of dev')
    expect(audits(id).filter(a => a.event === 'approval_denied')).toHaveLength(1)
    expect(audits(id)[0]).toMatchObject({ reason: 'grant_merge:not_owned', agent_key_label: 'standing:dev' })
    expect(fake.calls).toHaveLength(0)
  })

  it('a card no one at dev works or owns is not touched at all (no note)', async () => {
    grant()
    const id = card({ worker: 'other-bot' })
    expect(await sweep()).toEqual([])
    expect(notes(id)).toHaveLength(0)
  })

  for (const verdict of ['fail', 'blocked']) {
    it(`verdict ${verdict}`, async () => {
      grant()
      const id = card({ verdict })
      await expectRefusedOnce(id, 'review_not_passed')
      expect(fake.calls).toHaveLength(0)
      expect(audits(id).filter(a => a.event === 'approval_denied')).toHaveLength(1)
    })
  }

  it('a review still running (no verdict yet) is not judged early', async () => {
    grant()
    const id = card({ verdict: null })
    expect(await sweep()).toEqual([])
    expect(notes(id)).toHaveLength(0)
  })

  it('CI red', async () => {
    grant()
    fake.pr.rollup = [{ name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }]
    const id = card()
    const n = await expectRefusedOnce(id, 'ci_not_green')
    expect(n.title).toContain('gate')
    expect(audits(id).filter(a => a.event === 'approval_denied')).toHaveLength(1)
    expect(audits(id)[0]).toMatchObject({ reason: 'grant_merge:ci_not_green', agent_key_label: 'standing:dev' })
  })

  it('a PR with conflicts (dirty)', async () => {
    grant()
    fake.pr.mergeStateStatus = 'DIRTY'
    await expectRefusedOnce(card(), 'pr_not_mergeable')
  })

  it('a PR that is behind is updated from its base (PR 896), then waits and merges the NEW head once CI is green', async () => {
    grant()
    fake.pr.mergeStateStatus = 'BEHIND'
    const id = card()
    expect((await sweep())[0]).toMatchObject({ objective_id: id, outcome: 'waiting' })
    expect(fake.calls.filter(c => c.some(a => String(a).endsWith('/update-branch')))).toHaveLength(1)
    expect(notes(id)).toHaveLength(0)
    expect(merges()).toHaveLength(0)
    expect(statusOf(id)).toBe('review')
    // CI still running on the new head: a wait, no second update.
    expect((await sweep())[0]).toMatchObject({ outcome: 'waiting' })
    expect(fake.calls.filter(c => c.some(a => String(a).endsWith('/update-branch')))).toHaveLength(1)

    fake.pr.rollup = GREEN
    expect((await sweep())[0]).toMatchObject({ outcome: 'merged' })
    expect(merges()).toHaveLength(1)
    expect(merges()[0]).toContain('def5678')
    expect(statusOf(id)).toBe('done')
  })

  it('reserved PR 645 (seed) is refused before ANY GitHub call', async () => {
    grant()
    const id = card({ prNumber: 645, repo: 'your-org/operationkit' })
    await expectRefusedOnce(id, 'reserved_pr')
    expect(fake.calls).toHaveLength(0)
  })

  it('a PR reserved by the server-side setting', async () => {
    grant()
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('grant_merge_reserved_prs', 'acme/app#778')").run()
    await expectRefusedOnce(card({ prNumber: 778 }), 'reserved_pr')
    expect(fake.calls).toHaveLength(0)
  })

  it('expired grant: says the date it ended and where to renew; tells the owner in chat once', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000)
    const g = grant({ now: past, expiresAt: new Date(past.getTime() + 86_400_000).toISOString() })
    const ended = g.expires_at.slice(0, 10)
    const a = card()
    const b = card()
    const n = await expectRefusedOnce(a, 'grant_expired')
    expect(n.title).toContain(`ended on ${ended}`)
    expect(n.title).toContain('Bots → dev → Settings → Approve on my behalf')
    expect(notes(b)).toHaveLength(1)
    expect(audits(a)[0]).toMatchObject({ event: 'approval_denied', reason: 'standing_merge:grant_expired', agent_key_label: 'standing:dev', grant_id: g.id })
    const msgs = chat()
    expect(msgs).toHaveLength(1) // once per grant, not per card or per tick
    expect(msgs[0].content).toContain(`ended on ${ended}`)
    expect(msgs[0].content).toContain('Approve on my behalf')
    expect(fake.calls).toHaveLength(0)
  })

  it('revoked grant', async () => {
    const g = grant()
    revokeGrant(getDb(), g.id, g.bot_name, 'operator')
    const n = await expectRefusedOnce(card(), 'grant_revoked')
    expect(n.title).toContain('was revoked on')
    expect(fake.calls).toHaveLength(0)
  })

  it('the server has no GitHub credential: one plain refusal, no wait, no gh call', async () => {
    const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR }
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    process.env.GH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-standing-no-gh-')) // no hosts.yml
    try {
      grant()
      const id = card()
      const n = await expectRefusedOnce(id, 'github_credential_missing')
      expect(n.title).toContain('no GitHub credential')
      expect(fake.calls).toEqual([])
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('grantor no longer an admin', async () => {
    grant({ grantor: { id: ANN, username: 'ann' } })
    getDb().prepare("UPDATE users SET role = 'member' WHERE id = ?").run(ANN)
    const n = await expectRefusedOnce(card(), 'grantor_not_admin')
    expect(n.title).toContain('ann')
    expect(fake.calls).toHaveLength(0)
  })

  it('an ended grant does not explain a card whose review did not pass', async () => {
    const g = grant()
    revokeGrant(getDb(), g.id, g.bot_name, 'operator')
    const id = card({ verdict: 'fail' })
    expect(await sweep()).toEqual([])
    expect(notes(id)).toHaveLength(0)
  })
})

describe('4. CI still running is a wait, not a refusal (bounded)', () => {
  it('waits without a note or audit row, then merges once the checks finish', async () => {
    grant()
    fake.pr.rollup = [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '' }]
    const id = card()
    expect((await sweep())[0]).toMatchObject({ objective_id: id, outcome: 'waiting' })
    expect((await sweep())[0]).toMatchObject({ outcome: 'waiting' })
    expect(notes(id)).toHaveLength(0)
    expect(audits(id)).toHaveLength(0)
    expect(merges()).toHaveLength(0)
    expect(statusOf(id)).toBe('review')

    fake.pr.rollup = GREEN
    expect((await sweep())[0]).toMatchObject({ outcome: 'merged' })
    expect(merges()).toHaveLength(1)
    expect(statusOf(id)).toBe('done')
  })

  it('no checks reported yet is also a wait', async () => {
    grant()
    fake.pr.rollup = []
    const id = card()
    expect((await sweep())[0]).toMatchObject({ objective_id: id, outcome: 'waiting' })
    expect(notes(id)).toHaveLength(0)
  })

  it('after the bound it gives up with ONE refusal', async () => {
    process.env.CC_STANDING_MERGE_CI_WAIT_MINUTES = '30'
    grant()
    fake.pr.rollup = [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '' }]
    const id = card()
    const t0 = Date.now()
    expect((await sweep({ now: () => new Date(t0) }))[0]).toMatchObject({ outcome: 'waiting' })
    expect((await sweep({ now: () => new Date(t0 + 29 * 60_000) }))[0]).toMatchObject({ outcome: 'waiting' })
    expect((await sweep({ now: () => new Date(t0 + 31 * 60_000) }))[0]).toMatchObject({ outcome: 'refused', code: 'ci_not_green' })
    await sweep({ now: () => new Date(t0 + 40 * 60_000) })
    expect(notes(id)).toHaveLength(1)
    expect(merges()).toHaveLength(0)
    expect(statusOf(id)).toBe('review')
  })
})

describe('5. a new AI review after a refusal is a new attempt', () => {
  it('refused on review 1, merged after review 2 passes', async () => {
    grant()
    fake.pr.rollup = [{ name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }]
    const id = card()
    await expectRefusedOnce(id, 'ci_not_green')
    fake.pr.rollup = GREEN
    getDb().prepare("UPDATE objectives SET ai_review_session_id = 'rev-second', ai_review_iteration = 2 WHERE id = ?").run(id)
    expect((await sweep())[0]).toMatchObject({ objective_id: id, outcome: 'merged' })
    expect(merges()).toHaveLength(1)
  })
})

describe('6. the grant switch', () => {
  it('is off unless sent as true, and only valid with merge', () => {
    expect(grant({ standing: false }).standing_merge).toBe(false)
    const plain = createGrant(getDb(), {
      grantor: { id: OWNER, username: 'operator' }, botName: 'dev', agentSlug: 'dev', workspace: GROWTH, actions: ['merge'],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), allowedWorkspaces: [GROWTH],
    })
    expect(plain.standing_merge).toBe(false)
    expect(() => grant({ actions: ['deploy'], standing: true })).toThrow(DelegationError)
    try {
      grant({ actions: ['deploy'], standing: true })
    } catch (err) {
      expect((err as InstanceType<typeof DelegationError>).code).toBe('standing_merge_needs_merge')
    }
    const audit = getDb().prepare("SELECT reason FROM delegation_audit WHERE event = 'grant_created' ORDER BY id DESC LIMIT 1").get() as { reason: string }
    expect(audit.reason).not.toContain('standing merge on')
    expect(grant().standing_merge).toBe(true)
    const on = getDb().prepare("SELECT reason FROM delegation_audit WHERE event = 'grant_created' ORDER BY id DESC LIMIT 1").get() as { reason: string }
    expect(on.reason).toContain('standing merge on')
  })

  it('existing grants (no value written) read as off: the column defaults to 0', () => {
    const info = getDb().prepare('PRAGMA table_info(delegation_grants)').all() as { name: string; dflt_value: string | null }[]
    expect(info.find(c => c.name === 'standing_merge')?.dflt_value).toBe('0')
  })
})

describe('7. never auto-merge; the kick is a no-op unless the host sweeper runs', () => {
  it('auto_merge_enabled is never written', async () => {
    grant()
    card()
    await sweep()
    expect(autoMergeSetting()).toBe('0')
  })

  it('kickStandingMerge does nothing when the sweeper is not started', async () => {
    grant()
    const id = card()
    sm.kickStandingMerge(id)
    await new Promise(r => setImmediate(r))
    await new Promise(r => setTimeout(r, 20))
    expect(fake.calls).toHaveLength(0)
    expect(statusOf(id)).toBe('review')
  })
})
