// obj 900909 (systems audit #10) — per-effort default ceilings, the projected-cost
// guard's warn → degrade → park chain (fake clock + fake usage), the spawn check,
// the worktree checkpoint, and the additive migration. Real migrated DB.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spend-guard-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-900909'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP
delete process.env.OBJECTIVE_CEILING_NORMAL_USD
delete process.env.OBJECTIVE_CEILING_HIGH_USD
delete process.env.OBJECTIVE_CEILING_ULTRACODE_USD

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn(), broadcastToObjective: vi.fn() }))

const { getDb, initDb } = await import('../db/index.js')
const { setObjectiveCeiling, resolveConfiguredCeiling } = await import('./job-accounting.js')
const sg = await import('./spend-guard.js')
const {
  BurnTracker, SPEND_GUARD_DEFAULTS, SpendCeilingRefusedError, assertSpawnWithinCeiling,
  buildSpendGuardView, checkpointWorktree, decideSpendGuardStep, defaultCeilingForEffort,
  resolveEffectiveCostCeiling, runSpendProjectionGuard, applySpendSettings, checkSpawnCeiling,
} = sg

beforeAll(() => { initDb() })
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})
beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'spend_%' OR key LIKE 'job_cost_ceiling_usd%'").run()
})

let nextId = 9_909_000
function seedCard(opts: { effort?: string; model?: string | null; status?: string; workspace?: string } = {}) {
  const id = nextId++
  getDb().prepare(
    `INSERT INTO objectives (id, title, type, status, effort, model, session_id, project, workspace, create_pr, delegate_mode)
     VALUES (?, ?, 'task', ?, ?, ?, ?, 'operationkit', ?, 0, 0)`,
  ).run(id, `card ${id}`, opts.status ?? 'working', opts.effort ?? 'normal', opts.model ?? 'claude-opus-4-8', `cc-${id}-1`, opts.workspace ?? 'operationkit')
  return id
}
const card = (id: number) => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as {
  id: number; status: string; effort: string; model: string | null; session_id: string | null
  ai_review_verdict: string | null; ai_review_findings: string | null; blocked_reason: string | null; workspace: string
}
const guardActivity = (id: number) =>
  (getDb().prepare("SELECT title, detail, metadata FROM activity_log WHERE objective_id = ? AND metadata LIKE '%spend_guard_%' ORDER BY id").all(id) as { title: string; detail: string; metadata: string }[])
    .map(r => ({ ...r, kind: JSON.parse(r.metadata).kind as string }))
const setSetting = (key: string, value: string) =>
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

// ─────────────────────────────────────────────────────────────────────────────
describe('per-effort default ceilings', () => {
  it('a card with no ceiling gets the default for its effort ($75 / $150 / $300)', () => {
    for (const [effort, usd] of [['normal', 75], ['high', 150], ['ultracode', 300]] as const) {
      const id = seedCard({ effort })
      const c = resolveEffectiveCostCeiling(getDb(), card(id))
      expect(c).toMatchObject({ costUsd: usd, source: `default:${effort}`, isDefault: true, effort })
      // The default is computed, never written into the card's ledger.
      expect(resolveConfiguredCeiling(getDb(), id, 'operationkit').source).toBe('none')
    }
  })

  it('the defaults come from settings when set', () => {
    setSetting('spend_ceiling_default_usd:high', '42')
    const id = seedCard({ effort: 'high' })
    expect(resolveEffectiveCostCeiling(getDb(), card(id)).costUsd).toBe(42)
    expect(defaultCeilingForEffort(getDb(), 'normal')).toBe(75)
    // A junk setting is ignored, never turned into Infinity or 0.
    setSetting('spend_ceiling_default_usd:normal', 'Infinity')
    expect(defaultCeilingForEffort(getDb(), 'normal')).toBe(75)
  })

  it('an explicit ceiling is used unchanged — card, then workspace, then global', () => {
    const a = seedCard({ effort: 'ultracode' })
    setObjectiveCeiling(getDb(), a, { costUsd: 12.5 })
    expect(resolveEffectiveCostCeiling(getDb(), card(a))).toMatchObject({ costUsd: 12.5, source: 'objective', isDefault: false })

    setSetting('job_cost_ceiling_usd:operationkit', '33')
    const b = seedCard()
    expect(resolveEffectiveCostCeiling(getDb(), card(b))).toMatchObject({ costUsd: 33, source: 'workspace:operationkit', isDefault: false })
    // The card's own explicit value still wins over the workspace one.
    expect(resolveEffectiveCostCeiling(getDb(), card(a)).costUsd).toBe(12.5)
  })

  it('a wall-clock-only explicit ceiling keeps its wall-clock and gets the cost default', () => {
    const id = seedCard({ effort: 'high' })
    setObjectiveCeiling(getDb(), id, { wallclockMs: 3_600_000 })
    expect(resolveEffectiveCostCeiling(getDb(), card(id))).toMatchObject({ costUsd: 150, source: 'default:high' })
    expect(resolveConfiguredCeiling(getDb(), id, 'operationkit')).toMatchObject({ wallclockMs: 3_600_000, costUsd: null })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('decideSpendGuardStep (pure)', () => {
  const cfg = SPEND_GUARD_DEFAULTS
  const base = { stageAtMs: 0, nowMs: 0, spentUsd: 10, ceilingUsd: 100, cfg }
  it('does nothing while the projection is under the ceiling', () => {
    expect(decideSpendGuardStep({ ...base, stage: 'none', projectedUsd: 99 }).action).toBe('none')
    expect(decideSpendGuardStep({ ...base, stage: 'none', projectedUsd: null }).action).toBe('none')
  })
  it('moves one step at a time, in order, even when spend is already over', () => {
    const over = { ...base, spentUsd: 500, projectedUsd: 900 }
    expect(decideSpendGuardStep({ ...over, stage: 'none' }).action).toBe('warn')
    expect(decideSpendGuardStep({ ...over, stage: 'warned' }).action).toBe('degrade')
    expect(decideSpendGuardStep({ ...over, stage: 'degraded' }).action).toBe('park')
    expect(decideSpendGuardStep({ ...over, stage: 'parked' }).action).toBe('none')
  })
  it('waits the dwell time before degrading and parking when spend is low', () => {
    const crossing = { ...base, projectedUsd: 120 }
    expect(decideSpendGuardStep({ ...crossing, stage: 'warned', nowMs: 4 * 60_000 }).action).toBe('none')
    expect(decideSpendGuardStep({ ...crossing, stage: 'warned', nowMs: 5 * 60_000 }).action).toBe('degrade')
    expect(decideSpendGuardStep({ ...crossing, stage: 'degraded', nowMs: 9 * 60_000 }).action).toBe('none')
    expect(decideSpendGuardStep({ ...crossing, stage: 'degraded', nowMs: 10 * 60_000 }).action).toBe('park')
  })
})

describe('BurnTracker', () => {
  it('needs the minimum span, then reports USD per minute over the window', () => {
    const t = new BurnTracker()
    t.record(1, 0, 10, 600_000)
    expect(t.rate(1, 120_000)).toBeNull()
    t.record(1, 60_000, 12, 600_000)
    expect(t.rate(1, 120_000)).toBeNull()
    t.record(1, 120_000, 14, 600_000)
    expect(t.rate(1, 120_000)).toBeCloseTo(2)
    // Old samples fall out of the window: the rate follows the CURRENT burn.
    for (let m = 3; m <= 20; m++) t.record(1, m * 60_000, 14 + (m - 2) * 0.5, 600_000)
    expect(t.rate(1, 120_000)).toBeCloseTo(0.5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('projected-cost guard: warn → degrade → park (fake clock + fake usage)', () => {
  function harness(id: number) {
    let now = Date.parse('2026-11-15T12:00:00Z')
    let spent = 0
    const stopJob = vi.fn()
    const checkpoint = vi.fn(() => ({ state: 'committed' as const, sha: 'abc1234def567', aborted: ['merge'], error: null }))
    const tracker = new BurnTracker()
    const deps = {
      now: () => now,
      measureSpend: () => spent,
      stopJob,
      checkpoint,
      tracker,
      config: { ...SPEND_GUARD_DEFAULTS },
    }
    return {
      deps, stopJob, checkpoint,
      async tick(minutes: number, usd: number) {
        now += minutes * 60_000
        spent = usd
        return runSpendProjectionGuard(getDb(), card(id), deps)
      },
    }
  }

  it('warns, then moves to a cheaper effort, then parks in review — in that order', async () => {
    // ultracode → $300 default ceiling. Burn $5/min, 30 min horizon → +$150.
    const id = seedCard({ effort: 'ultracode', model: 'claude-opus-4-8' })
    const h = harness(id)
    const actions: string[] = []
    let r = await h.tick(0, 10); actions.push(r.action)   // first sample, warming up
    r = await h.tick(1, 15); actions.push(r.action)
    r = await h.tick(1, 20); actions.push(r.action)       // 2 min span: burn $5/min → $170 projected
    expect(r.burnUsdPerMin).toBeCloseTo(5)
    expect(r.projectedUsd).toBeCloseTo(170)
    // Keep burning until the projection crosses $300: spent + 150 ≥ 300 at $150.
    let spent = 20
    while (actions.at(-1) === 'none') { spent += 5; r = await h.tick(1, spent); actions.push(r.action) }
    expect(actions.at(-1)).toBe('warn')
    expect(card(id).status).toBe('working')
    expect(card(id).effort).toBe('ultracode')

    // Still crossing: degrade after the 5-minute dwell, not before.
    for (let i = 0; i < 4; i++) { spent += 5; r = await h.tick(1, spent); expect(r.action).toBe('none') }
    spent += 5; r = await h.tick(1, spent)
    expect(r.action).toBe('degrade')
    expect(card(id)).toMatchObject({ status: 'working', effort: 'high' })
    // The ceiling is still read from the ORIGINAL effort — degrading never halves the budget.
    expect(resolveEffectiveCostCeiling(getDb(), card(id))).toMatchObject({ costUsd: 300, source: 'default:ultracode' })

    // Spend reaching 95% of the ceiling parks without waiting out the dwell.
    r = await h.tick(1, 290)
    expect(r.action).toBe('park')
    expect(r.stopped).toBe(true)
    const c = card(id)
    expect(c.status).toBe('review')
    expect(c.ai_review_verdict).toBe('blocked')
    expect(c.blocked_reason).toBe('spend-guard')
    expect(c.ai_review_findings).toMatch(/Parked by the spend guard: \$290\.00 spent of a \$300\.00 ceiling \(the default for ultracode effort\)/)
    expect(c.ai_review_findings).toMatch(/WIP checkpoint commit abc1234def/)
    // The job is stopped BEFORE the worktree is checkpointed.
    expect(h.stopJob).toHaveBeenCalledTimes(1)
    expect(h.checkpoint).toHaveBeenCalledTimes(1)
    expect(h.stopJob.mock.invocationCallOrder[0]).toBeLessThan(h.checkpoint.mock.invocationCallOrder[0])

    expect(guardActivity(id).map(a => a.kind)).toEqual(['spend_guard_warn', 'spend_guard_degrade', 'spend_guard_park'])
    // The view the card panel reads.
    const view = buildSpendGuardView(getDb(), { ...card(id) }, () => 290)
    expect(view).toMatchObject({ stage: 'parked', ceiling_usd: 300, spent_usd: 290, ceiling_is_default: true })
    expect(view.last_action).toMatch(/Parked by the spend guard/)
  })

  it('a sudden jump past the ceiling still goes warn → degrade → park on consecutive evaluations', async () => {
    const id = seedCard({ effort: 'normal', model: 'claude-opus-4-8' })
    getDb().prepare("INSERT OR IGNORE INTO models (id, label, engine, enabled, is_default, is_planner, sort_order) VALUES ('claude-sonnet-5', 'Sonnet 5', 'claude', 1, 0, 0, 50)").run()
    getDb().prepare("INSERT OR IGNORE INTO models (id, label, engine, enabled, is_default, is_planner, sort_order) VALUES ('claude-opus-4-8', 'Opus 4.8', 'claude', 1, 0, 0, 10)").run()
    const h = harness(id)
    await h.tick(0, 1)
    await h.tick(1, 2)
    expect((await h.tick(1, 500)).action).toBe('warn')
    expect((await h.tick(1, 501)).action).toBe('degrade')
    // At normal effort the cheaper step is the model.
    expect(card(id).model).toBe('claude-sonnet-5')
    expect((await h.tick(1, 502)).action).toBe('park')
    expect(guardActivity(id).map(a => a.kind)).toEqual(['spend_guard_warn', 'spend_guard_degrade', 'spend_guard_park'])
  })

  it('a card that does not allow degradation is warned, told why, then parked — still in order', async () => {
    const id = seedCard({ effort: 'high' })
    applySpendSettings(getDb(), card(id), { degradeAllowed: false }, 'test')
    const h = harness(id)
    await h.tick(0, 1)
    await h.tick(1, 2)
    expect((await h.tick(1, 200)).action).toBe('warn')
    expect((await h.tick(1, 201)).action).toBe('degrade_skipped')
    expect(card(id).effort).toBe('high')
    expect((await h.tick(1, 202)).action).toBe('park')
    const kinds = guardActivity(id).map(a => a.kind)
    expect(kinds.slice(-3)).toEqual(['spend_guard_warn', 'spend_guard_degrade_skipped', 'spend_guard_park'])
  })

  it('throttles to one evaluation per interval', async () => {
    const id = seedCard()
    const h = harness(id)
    expect((await h.tick(0, 1)).evaluated).toBe(true)
    expect((await h.tick(0.5, 2)).evaluated).toBe(false)
    expect((await h.tick(0.5, 3)).evaluated).toBe(true)
  })

  it('the kill switch turns the projection guard off', async () => {
    setSetting('spend_projection_guard_enabled', '0')
    const id = seedCard()
    const h = harness(id)
    h.deps.config = sg.resolveSpendGuardConfig(getDb())
    for (let m = 0; m < 5; m++) expect((await h.tick(1, 1000 * m)).evaluated).toBe(false)
    expect(card(id).status).toBe('working')
    expect(guardActivity(id)).toEqual([])
  })

  it('an explicit ceiling is honoured and never rewritten by the guard', async () => {
    const id = seedCard({ effort: 'ultracode' })
    setObjectiveCeiling(getDb(), id, { costUsd: 20 })
    const h = harness(id)
    await h.tick(0, 1)
    await h.tick(1, 2)
    const r = await h.tick(1, 3)   // $1/min → $33 projected > $20
    expect(r).toMatchObject({ action: 'warn', ceilingUsd: 20 })
    const row = getDb().prepare('SELECT cost_ceiling_usd, ceiling_source FROM objective_job_accounting WHERE objective_id = ?').get(id)
    expect(row).toEqual({ cost_ceiling_usd: 20, ceiling_source: 'objective' })
  })

  it('a parked card that is restarted starts a fresh chain', async () => {
    const id = seedCard()
    const h = harness(id)
    await h.tick(0, 1); await h.tick(1, 2)
    await h.tick(1, 100); await h.tick(1, 100); await h.tick(1, 100)
    expect(card(id).status).toBe('review')
    // An owner raises the ceiling and resumes the card.
    applySpendSettings(getDb(), card(id), { costUsd: 1000 }, 'owner')
    getDb().prepare("UPDATE objectives SET status = 'working' WHERE id = ?").run(id)
    const r = await h.tick(1, 101)
    expect(r.action).toBe('none')
    expect(buildSpendGuardView(getDb(), card(id), () => 101)).toMatchObject({ stage: 'none', ceiling_usd: 1000, ceiling_source: 'objective' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('spawn / respawn ceiling check', () => {
  it('refuses a spawn at or over the ceiling with the reason, and records it', () => {
    const id = seedCard({ effort: 'normal', status: 'queue' })
    let err: unknown
    try { assertSpawnWithinCeiling(getDb(), card(id), 'spawn', () => 80) } catch (e) { err = e }
    expect(err).toBeInstanceOf(SpendCeilingRefusedError)
    const e = err as InstanceType<typeof SpendCeilingRefusedError>
    expect(e.message).toBe(
      'Start refused by the spend guard: this card has spent $80.00 against its $75.00 ceiling (the default for normal effort). ' +
      'Raise the ceiling in the card\'s spend panel to continue.',
    )
    expect(e).toMatchObject({ code: 'spend_ceiling_refused', kind: 'spawn', spentUsd: 80, ceilingUsd: 75, ceilingSource: 'default:normal' })
    expect(guardActivity(id).map(a => a.kind)).toEqual(['spend_guard_spawn_refused'])
    expect(buildSpendGuardView(getDb(), card(id), () => 80)).toMatchObject({ over_ceiling: true, last_refusal: e.message })
  })

  it('refuses a respawn over an explicit ceiling', () => {
    const id = seedCard()
    setObjectiveCeiling(getDb(), id, { costUsd: 5 })
    expect(() => assertSpawnWithinCeiling(getDb(), card(id), 'respawn', () => 5)).toThrow(
      /^Respawn refused by the spend guard: this card has spent \$5\.00 against its \$5\.00 ceiling \(set on this card\)/,
    )
  })

  it('allows a spawn under the ceiling, and the kill switch allows everything', () => {
    const id = seedCard()
    expect(() => assertSpawnWithinCeiling(getDb(), card(id), 'spawn', () => 74.99)).not.toThrow()
    setSetting('spend_spawn_guard_enabled', '0')
    expect(checkSpawnCeiling(getDb(), card(id), 'spawn', () => 10_000).allowed).toBe(true)
  })

  it('fails open if measuring spend throws (never a phantom refusal)', () => {
    const id = seedCard()
    expect(() => assertSpawnWithinCeiling(getDb(), card(id), 'spawn', () => { throw new Error('boom') })).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('checkpointWorktree leaves the worktree consistent', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  it('aborts an in-progress merge and commits leftover changes as a WIP checkpoint', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'wt-'))
    git(dir, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
    git(dir, 'checkout', '-q', '-b', 'other')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n')
    git(dir, 'commit', '-qam', 'other')
    git(dir, 'checkout', '-q', 'main')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n')
    git(dir, 'commit', '-qam', 'main')
    try { git(dir, 'merge', 'other') } catch { /* conflict, as intended */ }
    expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(true)
    // Agent-written file left behind, plus a stale lock from a killed git process.
    fs.writeFileSync(path.join(dir, 'new.txt'), 'work in progress\n')

    const r = checkpointWorktree(dir, 'obj test')
    expect(r.state).toBe('committed')
    expect(r.aborted).toContain('merge')
    expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'log', '-1', '--format=%s')).toMatch(/^WIP: spend guard checkpoint — obj test/)
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD')).toContain('new.txt')
    expect(r.sha).toBe(git(dir, 'rev-parse', 'HEAD').trim())
  })

  it('removes a stale index.lock; a clean tree is left alone; no worktree is reported', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'wt-'))
    git(dir, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'x')
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '')
    const r = checkpointWorktree(dir, 'obj clean')
    expect(r).toMatchObject({ state: 'clean', aborted: ['index.lock'] })
    expect(checkpointWorktree(path.join(TMP, 'does-not-exist'), 'x').state).toBe('no-worktree')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('migration is additive', () => {
  it('re-running initDb keeps explicit ceilings and guard state untouched', () => {
    const id = seedCard()
    setObjectiveCeiling(getDb(), id, { costUsd: 7, wallclockMs: 1000 })
    applySpendSettings(getDb(), card(id), { degradeAllowed: false }, 'test')
    initDb()
    expect(getDb().prepare('SELECT cost_ceiling_usd, wallclock_ceiling_ms, ceiling_source FROM objective_job_accounting WHERE objective_id = ?').get(id))
      .toEqual({ cost_ceiling_usd: 7, wallclock_ceiling_ms: 1000, ceiling_source: 'objective' })
    expect(buildSpendGuardView(getDb(), card(id), () => 0).degrade_allowed).toBe(false)
    // The new table did not add a column to objective_job_accounting.
    const cols = (getDb().prepare('PRAGMA table_info(objective_job_accounting)').all() as { name: string }[]).map(c => c.name)
    expect(cols).not.toContain('stage')
  })
})
