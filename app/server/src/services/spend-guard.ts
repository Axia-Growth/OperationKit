/**
 * Spend guard: per-effort default ceilings, a projected-cost guard on live
 * sessions, and a ceiling check before every spawn and respawn
 * (obj 900909, systems audit #10).
 *
 * ## The problem this closes
 *
 * Before this module every spend check ran AFTER the money was spent:
 *  - the job-accounting cost ceiling (`objective_job_accounting.cost_ceiling_usd`)
 *    is NULL until somebody sets one, so most cards had no cost ceiling at all;
 *  - the only default was the $75 / $150 / $300 cumulative cap
 *    (`AI_REVIEW_BUDGET_CEILING_USD`), and it was read only when a failed AI
 *    review decided whether to bounce the card again.
 *
 * ## What it does
 *
 * 1. **Default per-effort ceilings.** {@link resolveEffectiveCostCeiling} returns
 *    the card's explicit cost ceiling when one exists (card → workspace setting →
 *    global setting, exactly as `resolveConfiguredCeiling` already resolves it —
 *    nothing about an explicit ceiling changes). When none exists it returns the
 *    default for the card's effort: `settings.spend_ceiling_default_usd:<effort>`,
 *    else the built-in $75 / $150 / $300 (env-overridable, same numbers the AI
 *    review cap always used). The default is computed, never written into the
 *    card's ledger, so "explicit" and "default" stay distinguishable.
 *
 * 2. **Projected-cost guard.** On every live `working` card the poller calls
 *    {@link runSpendProjectionGuard} (throttled to one evaluation a minute). It
 *    samples measured spend, computes a burn rate (USD per minute over a rolling
 *    window) and projects spend `horizon` minutes ahead. While the projection is
 *    at or over the ceiling it walks a fixed chain, ONE step per evaluation and
 *    never out of order: warn on the card → drop to a cheaper effort or model
 *    (where the card allows it) → park the card in review with the reason.
 *
 * 3. **Spawn and respawn check.** {@link assertSpawnWithinCeiling} runs at the
 *    top of `startSession` and on the respawn path of `sendFollowUp`. Spend at or
 *    over the ceiling refuses the spawn with {@link SpendCeilingRefusedError},
 *    whose message says how much was spent against which ceiling and how to
 *    raise it.
 *
 * ## What it does NOT claim
 *
 * Spend is the CLI's own `total_cost_usd` per result event — list-price value of
 * the tokens, the same number the existing $75/$150/$300 cap reads. Sessions run
 * on subscription seats, so it is an estimate of value, not a billing feed. The
 * guard acts on that estimate; it is not a provider-side billing cap.
 *
 * ## Parking without corrupting the worktree
 *
 * A park stops the session, then {@link checkpointWorktree} makes the worktree
 * consistent: a stale `index.lock` is removed, an in-progress merge / rebase /
 * cherry-pick / revert is aborted, and every remaining change is committed as a
 * WIP checkpoint on the card's own branch (not pushed). The commit sha goes into
 * the park reason, so nothing the agent wrote is lost and the tree is never left
 * mid-operation.
 *
 * ## Switches (all `settings` rows, read at point of use, no restart)
 *
 *  - `spend_projection_guard_enabled` = '0' turns the projection guard off.
 *  - `spend_spawn_guard_enabled` = '0' turns the spawn/respawn check off.
 *  - `spend_ceiling_default_usd:<normal|high|ultracode>` overrides a default.
 *  - `spend_guard_degrade_default` = '0' makes cards opt IN to degradation
 *    (a per-card value set through the card's spend panel always wins).
 *  - Tuning: `spend_projection_horizon_minutes` (30), `…_window_minutes` (10),
 *    `…_min_span_minutes` (2), `…_interval_seconds` (60),
 *    `spend_guard_degrade_after_minutes` (5), `spend_guard_park_after_minutes` (10).
 */
import type { Database } from 'better-sqlite3'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { SpendEffortTier, SpendGuardStage, SpendGuardView } from '@operationkit/shared'
import { parseFiniteCeiling, resolveConfiguredCeiling } from './job-accounting.js'
import { budgetCeilingForEffort } from './poller-decisions.js'

// ── Settings ────────────────────────────────────────────────────────────────

function readSetting(db: Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function readNumber(db: Database, key: string, fallback: number): number {
  const n = parseFiniteCeiling(readSetting(db, key))
  return n ?? fallback
}

function readSwitch(db: Database, key: string, fallback: boolean): boolean {
  const raw = readSetting(db, key)
  if (raw == null || String(raw).trim() === '') return fallback
  const v = String(raw).trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off') return false
  if (v === '1' || v === 'true' || v === 'on') return true
  return fallback
}

export interface SpendGuardConfig {
  projectionEnabled: boolean
  spawnGuardEnabled: boolean
  horizonMinutes: number
  windowMinutes: number
  minSpanMinutes: number
  intervalMs: number
  degradeAfterMinutes: number
  parkAfterMinutes: number
  /** Spend at this share of the ceiling moves warned → degraded without waiting. */
  degradeSpendRatio: number
  /** Spend at this share of the ceiling moves degraded → parked without waiting. */
  parkSpendRatio: number
  /** Whether a card with no per-card choice may be degraded. */
  degradeDefault: boolean
}

export const SPEND_GUARD_DEFAULTS: SpendGuardConfig = {
  projectionEnabled: true,
  spawnGuardEnabled: true,
  horizonMinutes: 30,
  windowMinutes: 10,
  minSpanMinutes: 2,
  intervalMs: 60_000,
  degradeAfterMinutes: 5,
  parkAfterMinutes: 10,
  degradeSpendRatio: 0.8,
  parkSpendRatio: 0.95,
  degradeDefault: true,
}

export function resolveSpendGuardConfig(db: Database): SpendGuardConfig {
  const d = SPEND_GUARD_DEFAULTS
  return {
    projectionEnabled: readSwitch(db, 'spend_projection_guard_enabled', d.projectionEnabled),
    spawnGuardEnabled: readSwitch(db, 'spend_spawn_guard_enabled', d.spawnGuardEnabled),
    horizonMinutes: readNumber(db, 'spend_projection_horizon_minutes', d.horizonMinutes),
    windowMinutes: readNumber(db, 'spend_projection_window_minutes', d.windowMinutes),
    minSpanMinutes: readNumber(db, 'spend_projection_min_span_minutes', d.minSpanMinutes),
    intervalMs: readNumber(db, 'spend_projection_interval_seconds', d.intervalMs / 1000) * 1000,
    degradeAfterMinutes: readNumber(db, 'spend_guard_degrade_after_minutes', d.degradeAfterMinutes),
    parkAfterMinutes: readNumber(db, 'spend_guard_park_after_minutes', d.parkAfterMinutes),
    degradeSpendRatio: d.degradeSpendRatio,
    parkSpendRatio: d.parkSpendRatio,
    degradeDefault: readSwitch(db, 'spend_guard_degrade_default', d.degradeDefault),
  }
}

// ── Effective ceiling ───────────────────────────────────────────────────────

export function normalizeEffort(effort: string | null | undefined): SpendEffortTier {
  return effort === 'high' || effort === 'ultracode' ? effort : 'normal'
}

/** The per-effort default ceiling: `settings.spend_ceiling_default_usd:<effort>`, else built-in. */
export function defaultCeilingForEffort(db: Database, effort: string | null | undefined): number {
  const tier = normalizeEffort(effort)
  const fromSettings = parseFiniteCeiling(readSetting(db, `spend_ceiling_default_usd:${tier}`))
  if (fromSettings !== null) return fromSettings
  return budgetCeilingForEffort(tier)
}

export interface EffectiveCeiling {
  costUsd: number
  /** `objective` | `workspace:<ws>` | `global` | `default:<effort>`. */
  source: string
  isDefault: boolean
  /** The effort the default was read for (the ORIGINAL effort if the guard degraded the card). */
  effort: SpendEffortTier
}

interface GuardRow {
  objective_id: number
  stage: SpendGuardStage
  stage_at: string | null
  warned_at: string | null
  degraded_at: string | null
  parked_at: string | null
  ceiling_usd: number | null
  ceiling_source: string | null
  spent_usd: number
  burn_usd_per_min: number | null
  projected_usd: number | null
  horizon_minutes: number | null
  measured_at: string | null
  original_effort: string | null
  original_model: string | null
  degrade_allowed: number | null
  last_action: string | null
  last_action_at: string | null
  last_refusal: string | null
  last_refusal_at: string | null
}

export function getGuardRow(db: Database, objectiveId: number): GuardRow | null {
  try {
    return (db.prepare('SELECT * FROM objective_spend_guard WHERE objective_id = ?').get(objectiveId) as GuardRow | undefined) ?? null
  } catch {
    return null
  }
}

function ensureGuardRow(db: Database, objectiveId: number): void {
  db.prepare('INSERT OR IGNORE INTO objective_spend_guard (objective_id) VALUES (?)').run(objectiveId)
}

function updateGuardRow(db: Database, objectiveId: number, fields: Partial<Record<keyof GuardRow, unknown>>): void {
  ensureGuardRow(db, objectiveId)
  const keys = Object.keys(fields)
  if (!keys.length) return
  const sets = keys.map(k => `${k} = ?`).join(', ')
  db.prepare(`UPDATE objective_spend_guard SET ${sets}, updated_at = datetime('now') WHERE objective_id = ?`)
    .run(...keys.map(k => (fields as Record<string, unknown>)[k] as never), objectiveId)
}

/**
 * The cost ceiling in force for a card. An explicit ceiling (card, workspace or
 * global setting) always wins and is returned unchanged. Otherwise the default
 * for the card's effort — the effort it had BEFORE any guard degradation, so a
 * degrade never shrinks the budget it was meant to protect.
 */
export function resolveEffectiveCostCeiling(
  db: Database,
  objective: { id: number; workspace?: string | null; effort?: string | null },
): EffectiveCeiling {
  const explicit = resolveConfiguredCeiling(db, objective.id, objective.workspace)
  const row = getGuardRow(db, objective.id)
  const effort = normalizeEffort(row?.original_effort ?? objective.effort)
  if (explicit.costUsd !== null) {
    return { costUsd: explicit.costUsd, source: explicit.source, isDefault: false, effort }
  }
  return { costUsd: defaultCeilingForEffort(db, effort), source: `default:${effort}`, isDefault: true, effort }
}

/** Where a ceiling came from, in words a person reads on the card. */
export function describeCeilingSource(ceiling: Pick<EffectiveCeiling, 'source' | 'isDefault' | 'effort'>): string {
  if (ceiling.isDefault) return `the default for ${ceiling.effort} effort`
  if (ceiling.source === 'objective') return 'set on this card'
  if (ceiling.source.startsWith('workspace:')) return 'the workspace limit'
  return 'the board limit'
}

// ── Burn rate ───────────────────────────────────────────────────────────────

interface Sample { t: number; usd: number }

/**
 * Rolling spend samples per card, in memory. A restart empties it and the guard
 * re-warms within `minSpanMinutes`; the STAGE of the chain is durable in
 * `objective_spend_guard`, so a restart never re-warns or skips a step.
 */
export class BurnTracker {
  private samples = new Map<number, Sample[]>()
  private lastEval = new Map<number, number>()

  record(objectiveId: number, t: number, usd: number, windowMs: number): void {
    const list = this.samples.get(objectiveId) ?? []
    list.push({ t, usd })
    // Keep the window plus the newest sample at or before its start, so the
    // span can reach the full window instead of shrinking under it.
    const cutoff = t - windowMs
    let firstInside = list.findIndex(s => s.t >= cutoff)
    if (firstInside < 0) firstInside = list.length - 1
    const keepFrom = Math.max(0, firstInside - 1)
    this.samples.set(objectiveId, list.slice(keepFrom))
  }

  /** USD per minute across the window, or null until `minSpanMs` of samples exist. */
  rate(objectiveId: number, minSpanMs: number): number | null {
    const list = this.samples.get(objectiveId)
    if (!list || list.length < 2) return null
    const first = list[0]
    const last = list[list.length - 1]
    const span = last.t - first.t
    if (span < minSpanMs || span <= 0) return null
    return Math.max(0, (last.usd - first.usd) / (span / 60_000))
  }

  /** True when this card was evaluated less than `intervalMs` ago. */
  throttled(objectiveId: number, now: number, intervalMs: number): boolean {
    const last = this.lastEval.get(objectiveId)
    return last !== undefined && now - last < intervalMs
  }

  markEvaluated(objectiveId: number, now: number): void {
    this.lastEval.set(objectiveId, now)
  }

  reset(objectiveId: number): void {
    this.samples.delete(objectiveId)
    this.lastEval.delete(objectiveId)
  }
}

export const sharedBurnTracker = new BurnTracker()

export function projectSpend(spentUsd: number, burnUsdPerMin: number | null, horizonMinutes: number): number | null {
  if (burnUsdPerMin === null) return null
  return spentUsd + burnUsdPerMin * horizonMinutes
}

// ── The chain (pure) ────────────────────────────────────────────────────────

export type SpendGuardAction = 'none' | 'warn' | 'degrade' | 'park'

/**
 * One step of the chain. Pure: no clock, no DB. The stage moves at most one step
 * per call and only forward, so a card is always warned before it is degraded
 * and degraded (or told it cannot be) before it is parked — even when spend
 * jumps past the ceiling between two evaluations.
 *
 * "Crossing" = the projection is at or over the ceiling, or spend already is.
 *  - none     → warn as soon as it crosses;
 *  - warned   → degrade once it has kept crossing for `degradeAfterMinutes`, or
 *               spend reaches `degradeSpendRatio` of the ceiling;
 *  - degraded → park once it has kept crossing for `parkAfterMinutes`, or spend
 *               reaches `parkSpendRatio` of the ceiling;
 *  - parked   → nothing more (the card is in review).
 */
export function decideSpendGuardStep(input: {
  stage: SpendGuardStage
  stageAtMs: number | null
  nowMs: number
  spentUsd: number
  projectedUsd: number | null
  ceilingUsd: number
  cfg: Pick<SpendGuardConfig, 'degradeAfterMinutes' | 'parkAfterMinutes' | 'degradeSpendRatio' | 'parkSpendRatio'>
}): { action: SpendGuardAction; crossing: boolean } {
  const { stage, stageAtMs, nowMs, spentUsd, projectedUsd, ceilingUsd, cfg } = input
  const crossing = spentUsd >= ceilingUsd || (projectedUsd !== null && projectedUsd >= ceilingUsd)
  if (!crossing) return { action: 'none', crossing }
  const dwellMs = stageAtMs === null ? Infinity : nowMs - stageAtMs
  switch (stage) {
    case 'none':
      return { action: 'warn', crossing }
    case 'warned':
      if (dwellMs >= cfg.degradeAfterMinutes * 60_000 || spentUsd >= ceilingUsd * cfg.degradeSpendRatio) {
        return { action: 'degrade', crossing }
      }
      return { action: 'none', crossing }
    case 'degraded':
      if (dwellMs >= cfg.parkAfterMinutes * 60_000 || spentUsd >= ceilingUsd * cfg.parkSpendRatio) {
        return { action: 'park', crossing }
      }
      return { action: 'none', crossing }
    default:
      return { action: 'none', crossing }
  }
}

// ── Degrade ─────────────────────────────────────────────────────────────────

/** Rough cost tier of a Claude model id, or null when unknown. */
export function claudeModelTier(modelId: string | null | undefined): number | null {
  const id = (modelId || '').toLowerCase()
  if (!id) return null
  if (/haiku/.test(id)) return 1
  if (/sonnet/.test(id)) return 2
  if (/opus/.test(id)) return 3
  if (/fable|mythos/.test(id)) return 4
  return null
}

/** The next cheaper ENABLED model on the same engine, or null. */
export function cheaperModel(db: Database, modelId: string | null | undefined): string | null {
  const tier = claudeModelTier(modelId)
  if (tier === null || tier <= 1) return null
  let rows: { id: string; engine: string; sort_order: number }[] = []
  try {
    rows = db.prepare('SELECT id, engine, sort_order FROM models WHERE enabled = 1 ORDER BY sort_order, id').all() as typeof rows
  } catch {
    return null
  }
  const current = rows.find(r => r.id === modelId)
  const engine = current?.engine ?? 'claude'
  let best: { id: string; tier: number } | null = null
  for (const r of rows) {
    if (r.engine !== engine) continue
    const t = claudeModelTier(r.id)
    if (t === null || t >= tier) continue
    if (!best || t > best.tier) best = { id: r.id, tier: t }
  }
  return best?.id ?? null
}

export interface DegradePlan {
  effort: string | null
  model: string | null
  note: string
}

/** What a degrade would change: one effort notch, or (already at normal) a cheaper model. */
export function planDegrade(
  db: Database,
  objective: { effort?: string | null; model?: string | null },
): DegradePlan | null {
  const effort = normalizeEffort(objective.effort)
  if (effort === 'ultracode') return { effort: 'high', model: null, note: 'effort lowered from ultracode to high' }
  if (effort === 'high') return { effort: 'normal', model: null, note: 'effort lowered from high to normal' }
  const model = cheaperModel(db, objective.model)
  if (model) return { effort: null, model, note: `model changed from ${objective.model} to ${model}` }
  return null
}

export function isDegradeAllowed(db: Database, objectiveId: number, cfg?: SpendGuardConfig): boolean {
  const row = getGuardRow(db, objectiveId)
  if (row && row.degrade_allowed !== null && row.degrade_allowed !== undefined) return row.degrade_allowed === 1
  return (cfg ?? resolveSpendGuardConfig(db)).degradeDefault
}

// ── Activity + card warnings ────────────────────────────────────────────────

export type SpendGuardEventKind =
  | 'spend_guard_warn'
  | 'spend_guard_degrade'
  | 'spend_guard_degrade_skipped'
  | 'spend_guard_park'
  | 'spend_guard_reset'
  | 'spend_guard_spawn_refused'
  | 'spend_guard_ceiling_set'

const EVENT_TYPE: Record<SpendGuardEventKind, string> = {
  spend_guard_warn: 'decision',
  spend_guard_degrade: 'decision',
  spend_guard_degrade_skipped: 'decision',
  spend_guard_park: 'blocker',
  spend_guard_reset: 'decision',
  spend_guard_spawn_refused: 'blocker',
  spend_guard_ceiling_set: 'decision',
}

const EVENT_TITLE: Record<SpendGuardEventKind, string> = {
  spend_guard_warn: 'Spend guard: projected to cross the ceiling',
  spend_guard_degrade: 'Spend guard: moved to a cheaper tier',
  spend_guard_degrade_skipped: 'Spend guard: no cheaper tier to move to',
  spend_guard_park: 'Spend guard: parked in review',
  spend_guard_reset: 'Spend guard: chain reset',
  spend_guard_spawn_refused: 'Spend guard: start refused',
  spend_guard_ceiling_set: 'Spend guard: ceiling changed',
}

/** Every guard action is one `activity_log` row; `metadata.kind` names it. Never throws. */
export function logSpendGuardActivity(
  db: Database,
  objective: { id: number; project?: string | null; workspace?: string | null; session_id?: string | null },
  kind: SpendGuardEventKind,
  detail: string,
  extra: Record<string, unknown> = {},
): void {
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      objective.project || 'unknown',
      objective.workspace ?? null,
      objective.id,
      objective.session_id ?? null,
      EVENT_TYPE[kind],
      EVENT_TITLE[kind],
      detail,
      JSON.stringify({ kind, ...extra }),
    )
  } catch (err) {
    console.warn(`[spend-guard] activity_log write failed for obj ${objective.id}:`, (err as Error).message)
  }
}

/** A `warning` row on the card's own events feed (stays local to this card). Never throws. */
function warnOnCard(db: Database, objective: { id: number; session_id?: string | null }, message: string, kind: string): void {
  try {
    db.prepare(
      `INSERT INTO session_events (session_id, objective_id, event_type, description, metadata, created_at)
       VALUES (?, ?, 'warning', ?, ?, datetime('now'))`,
    ).run(objective.session_id ?? null, objective.id, message, JSON.stringify({ kind }))
  } catch { /* events table absent in a minimal DB */ }
}

const usd = (n: number) => `$${n.toFixed(2)}`

// ── Worktree checkpoint ─────────────────────────────────────────────────────

export type GitRunner = (cwd: string, args: string[]) => string

export const defaultGit: GitRunner = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })

export interface CheckpointResult {
  state: 'no-worktree' | 'clean' | 'committed' | 'failed'
  sha: string | null
  aborted: string[]
  error: string | null
}

/**
 * Leave a worktree consistent after its session was stopped: remove a stale
 * `index.lock`, abort any in-progress merge / rebase / cherry-pick / revert,
 * then commit every remaining change as a WIP checkpoint (local, not pushed).
 *
 * Call it only AFTER the session is stopped — before that, the agent could
 * write after the checkpoint. Never throws.
 */
export function checkpointWorktree(dir: string, label: string, git: GitRunner = defaultGit): CheckpointResult {
  const aborted: string[] = []
  try {
    if (!dir || !fs.existsSync(dir)) return { state: 'no-worktree', sha: null, aborted, error: null }
    try {
      if (git(dir, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
        return { state: 'no-worktree', sha: null, aborted, error: null }
      }
    } catch {
      return { state: 'no-worktree', sha: null, aborted, error: null }
    }
    const gitPath = (name: string) => {
      const p = git(dir, ['rev-parse', '--git-path', name]).trim()
      return path.isAbsolute(p) ? p : path.join(dir, p)
    }
    // The session is stopped, so any index lock is stale.
    const lock = gitPath('index.lock')
    if (fs.existsSync(lock)) {
      fs.rmSync(lock, { force: true })
      aborted.push('index.lock')
    }
    const ops: Array<[string, string[]]> = [
      ['MERGE_HEAD', ['merge', '--abort']],
      ['CHERRY_PICK_HEAD', ['cherry-pick', '--abort']],
      ['REVERT_HEAD', ['revert', '--abort']],
    ]
    for (const [marker, args] of ops) {
      if (fs.existsSync(gitPath(marker))) {
        git(dir, args)
        aborted.push(args[0])
      }
    }
    if (fs.existsSync(gitPath('rebase-merge')) || fs.existsSync(gitPath('rebase-apply'))) {
      git(dir, ['rebase', '--abort'])
      aborted.push('rebase')
    }
    const dirty = git(dir, ['status', '--porcelain']).trim()
    if (dirty) {
      git(dir, ['add', '-A'])
      git(dir, [
        '-c', 'user.name=Operation Kit spend guard',
        '-c', 'user.email=spend-guard@operationkit.local',
        'commit', '--no-verify', '-m', `WIP: spend guard checkpoint — ${label}`,
      ])
    }
    const sha = git(dir, ['rev-parse', 'HEAD']).trim()
    return { state: dirty ? 'committed' : 'clean', sha, aborted, error: null }
  } catch (err) {
    return { state: 'failed', sha: null, aborted, error: (err as Error).message.split('\n')[0].slice(0, 300) }
  }
}

export function describeCheckpoint(c: CheckpointResult): string {
  const ab = c.aborted.length ? ` (cleared: ${c.aborted.join(', ')})` : ''
  switch (c.state) {
    case 'committed': return `Uncommitted work was saved as a WIP checkpoint commit ${c.sha?.slice(0, 10)} on the card's branch${ab}.`
    case 'clean': return `The worktree was already clean at ${c.sha?.slice(0, 10)}${ab}.`
    case 'no-worktree': return 'The card has no worktree, so there was nothing to checkpoint.'
    default: return `Worktree checkpoint FAILED (${c.error ?? 'unknown error'}${ab}) — check the worktree before resuming.`
  }
}

// ── Projected-cost guard (live sessions) ─────────────────────────────────────

export interface GuardObjective {
  id: number
  status: string
  session_id?: string | null
  workspace?: string | null
  project?: string | null
  effort?: string | null
  model?: string | null
  title?: string | null
}

export interface SpendGuardDeps {
  now?: () => number
  /** Measured cumulative spend for the card, in USD. */
  measureSpend: (objective: GuardObjective) => number
  /** Stop the card's running job (kill tmux, release leases). Called after the status write. */
  stopJob: (objective: GuardObjective) => Promise<void> | void
  /** Make the card's worktree consistent after the stop. Default: {@link checkpointWorktree} on `/tmp/cc-worktree-<id>`. */
  checkpoint?: (objective: GuardObjective) => CheckpointResult
  /** Push the updated card row to the board. */
  broadcast?: (objectiveId: number) => void
  tracker?: BurnTracker
  config?: SpendGuardConfig
}

export interface SpendGuardTickResult {
  evaluated: boolean
  action: SpendGuardAction | 'reset' | 'degrade_skipped'
  /** True when the card was parked and its job stopped — the caller must `continue`. */
  stopped: boolean
  spentUsd?: number
  projectedUsd?: number | null
  burnUsdPerMin?: number | null
  ceilingUsd?: number
}

function parseSqlTime(s: string | null | undefined): number | null {
  if (!s) return null
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z'
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function sqlTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

/**
 * One evaluation of the projected-cost guard for a live `working` card. Called
 * by the poller on every tick; throttled per card to `intervalMs`. Never throws.
 */
export async function runSpendProjectionGuard(
  db: Database,
  objective: GuardObjective,
  deps: SpendGuardDeps,
): Promise<SpendGuardTickResult> {
  const now = (deps.now ?? Date.now)()
  const tracker = deps.tracker ?? sharedBurnTracker
  try {
    if (objective.status !== 'working' || !objective.session_id) return { evaluated: false, action: 'none', stopped: false }
    const cfg = deps.config ?? resolveSpendGuardConfig(db)
    if (!cfg.projectionEnabled) return { evaluated: false, action: 'none', stopped: false }
    if (tracker.throttled(objective.id, now, cfg.intervalMs)) return { evaluated: false, action: 'none', stopped: false }
    tracker.markEvaluated(objective.id, now)

    let row = getGuardRow(db, objective.id)
    // A parked card that is `working` again was restarted on purpose (the park
    // put it in review; only a person or an explicit start moves it back, and
    // the spawn check let it through because spend is under the ceiling).
    // Start a fresh chain for the new run.
    if (row?.stage === 'parked') {
      updateGuardRow(db, objective.id, {
        stage: 'none', stage_at: sqlTime(now), warned_at: null, degraded_at: null,
        last_action: 'Card restarted after a park; the warn, cheaper tier, park sequence starts again.',
        last_action_at: sqlTime(now),
      })
      logSpendGuardActivity(db, objective, 'spend_guard_reset', 'Card restarted after a spend-guard park; chain reset.')
      tracker.reset(objective.id)
      tracker.markEvaluated(objective.id, now)
      row = getGuardRow(db, objective.id)
    }

    const ceiling = resolveEffectiveCostCeiling(db, objective)
    const spentUsd = deps.measureSpend(objective)
    tracker.record(objective.id, now, spentUsd, cfg.windowMinutes * 60_000)
    const burn = tracker.rate(objective.id, cfg.minSpanMinutes * 60_000)
    const projected = projectSpend(spentUsd, burn, cfg.horizonMinutes)

    updateGuardRow(db, objective.id, {
      ceiling_usd: ceiling.costUsd,
      ceiling_source: ceiling.source,
      spent_usd: spentUsd,
      burn_usd_per_min: burn,
      projected_usd: projected,
      horizon_minutes: cfg.horizonMinutes,
      measured_at: sqlTime(now),
    })

    const stage = (row?.stage ?? 'none') as SpendGuardStage
    const step = decideSpendGuardStep({
      stage,
      stageAtMs: parseSqlTime(row?.stage_at),
      nowMs: now,
      spentUsd,
      projectedUsd: projected,
      ceilingUsd: ceiling.costUsd,
      cfg,
    })
    const base = { evaluated: true, spentUsd, projectedUsd: projected, burnUsdPerMin: burn, ceilingUsd: ceiling.costUsd }
    const numbers =
      `${usd(spentUsd)} spent of a ${usd(ceiling.costUsd)} ceiling (${describeCeilingSource(ceiling)})` +
      (burn !== null && projected !== null
        ? `, burning ${usd(burn)}/min, projected ${usd(projected)} in ${cfg.horizonMinutes} min`
        : '')
    const meta = { spent_usd: spentUsd, ceiling_usd: ceiling.costUsd, ceiling_source: ceiling.source, burn_usd_per_min: burn, projected_usd: projected, horizon_minutes: cfg.horizonMinutes }

    if (step.action === 'warn') {
      const msg = `Spend warning: ${numbers}. If this keeps up the card will be moved to a cheaper tier, then parked in review.`
      updateGuardRow(db, objective.id, { stage: 'warned', stage_at: sqlTime(now), warned_at: sqlTime(now), last_action: msg, last_action_at: sqlTime(now) })
      warnOnCard(db, objective, msg, 'spend_guard_warn')
      logSpendGuardActivity(db, objective, 'spend_guard_warn', msg, meta)
      deps.broadcast?.(objective.id)
      return { ...base, action: 'warn', stopped: false }
    }

    if (step.action === 'degrade') {
      const allowed = isDegradeAllowed(db, objective.id, cfg)
      const plan = allowed ? planDegrade(db, objective) : null
      if (plan) {
        const fresh = getGuardRow(db, objective.id)
        db.prepare(
          `UPDATE objectives SET effort = COALESCE(?, effort), model = COALESCE(?, model), updated_at = datetime('now') WHERE id = ?`,
        ).run(plan.effort, plan.model, objective.id)
        const msg = `Spend guard moved the card to a cheaper tier (${plan.note}); it applies from the next turn, the running turn is not interrupted. ${numbers}.`
        updateGuardRow(db, objective.id, {
          stage: 'degraded', stage_at: sqlTime(now), degraded_at: sqlTime(now),
          original_effort: fresh?.original_effort ?? normalizeEffort(objective.effort),
          original_model: fresh?.original_model ?? objective.model ?? null,
          last_action: msg, last_action_at: sqlTime(now),
        })
        warnOnCard(db, objective, msg, 'spend_guard_degrade')
        logSpendGuardActivity(db, objective, 'spend_guard_degrade', msg, { ...meta, from_effort: objective.effort ?? null, from_model: objective.model ?? null, to_effort: plan.effort, to_model: plan.model })
        deps.broadcast?.(objective.id)
        return { ...base, action: 'degrade', stopped: false }
      }
      const why = allowed ? 'it is already on the cheapest effort and model available' : 'this card does not allow it'
      const msg = `Spend guard could not move the card to a cheaper tier: ${why}. Next step is parking it in review. ${numbers}.`
      updateGuardRow(db, objective.id, { stage: 'degraded', stage_at: sqlTime(now), degraded_at: sqlTime(now), last_action: msg, last_action_at: sqlTime(now) })
      warnOnCard(db, objective, msg, 'spend_guard_degrade_skipped')
      logSpendGuardActivity(db, objective, 'spend_guard_degrade_skipped', msg, { ...meta, degrade_allowed: allowed })
      deps.broadcast?.(objective.id)
      return { ...base, action: 'degrade_skipped', stopped: false }
    }

    if (step.action === 'park') {
      const head =
        `Parked by the spend guard: ${numbers}. The card was warned, then ` +
        `${stage === 'degraded' && getGuardRow(db, objective.id)?.original_effort ? 'moved to a cheaper tier' : 'checked for a cheaper tier'}, ` +
        'and the projection still crosses the ceiling.'
      // Status first: the poller must not respawn the card while we stop it.
      const moved = parkCardInReview(db, objective.id, head)
      if (!moved) return { ...base, action: 'none', stopped: false }
      try {
        await deps.stopJob(objective)
      } catch (err) {
        console.error(`[spend-guard] stopJob failed for obj ${objective.id}:`, err)
      }
      const cp = (deps.checkpoint ?? ((o: GuardObjective) => checkpointWorktree(`/tmp/cc-worktree-${o.id}`, `obj ${o.id} parked at ${usd(spentUsd)}`)))(objective)
      const reason =
        `${head} ${describeCheckpoint(cp)} ` +
        'To continue, raise the ceiling in the card\'s spend panel, then resume.'
      try {
        db.prepare('UPDATE objectives SET ai_review_findings = ? WHERE id = ?').run(reason, objective.id)
      } catch { /* the park itself already landed */ }
      updateGuardRow(db, objective.id, { stage: 'parked', stage_at: sqlTime(now), parked_at: sqlTime(now), last_action: reason, last_action_at: sqlTime(now) })
      logSpendGuardActivity(db, objective, 'spend_guard_park', reason, { ...meta, checkpoint: cp.state, checkpoint_sha: cp.sha, cleared: cp.aborted })
      tracker.reset(objective.id)
      tracker.markEvaluated(objective.id, now)
      deps.broadcast?.(objective.id)
      return { ...base, action: 'park', stopped: true }
    }

    return { ...base, action: 'none', stopped: false }
  } catch (err) {
    // A guard must never wedge the tick and never invent a stop.
    console.error(`[spend-guard] projection check failed for obj ${objective.id}:`, err)
    return { evaluated: false, action: 'none', stopped: false }
  }
}

/** Move a `working` card to review with a blocked verdict and the reason. Returns false if it was no longer working. */
function parkCardInReview(db: Database, objectiveId: number, reason: string): boolean {
  const sql = (withReason: boolean) =>
    `UPDATE objectives
        SET status = 'review', ai_review_verdict = 'blocked', ai_review_findings = ?,
            ${withReason ? "blocked_reason = 'spend-guard'," : ''} has_blockers = 1, updated_at = datetime('now')
      WHERE id = ? AND status = 'working'`
  try {
    return db.prepare(sql(true)).run(reason, objectiveId).changes > 0
  } catch {
    try {
      return db.prepare(sql(false)).run(reason, objectiveId).changes > 0
    } catch (err) {
      console.error(`[spend-guard] could not park obj ${objectiveId}:`, err)
      return false
    }
  }
}

// ── Spawn / respawn check ───────────────────────────────────────────────────

export type SpawnKind = 'spawn' | 'respawn'

export class SpendCeilingRefusedError extends Error {
  readonly code = 'spend_ceiling_refused'
  constructor(
    message: string,
    public readonly objectiveId: number,
    public readonly kind: SpawnKind,
    public readonly spentUsd: number,
    public readonly ceilingUsd: number,
    public readonly ceilingSource: string,
  ) {
    super(message)
    this.name = 'SpendCeilingRefusedError'
  }
}

export interface SpawnCeilingVerdict {
  allowed: boolean
  reason: string | null
  spentUsd: number
  ceiling: EffectiveCeiling | null
}

/** Pure-ish check (DB + an injected spend measurement). Fails open on any internal error. */
export function checkSpawnCeiling(
  db: Database,
  objective: { id: number; workspace?: string | null; effort?: string | null },
  kind: SpawnKind,
  measureSpend: () => number,
): SpawnCeilingVerdict {
  try {
    const cfg = resolveSpendGuardConfig(db)
    if (!cfg.spawnGuardEnabled) return { allowed: true, reason: null, spentUsd: 0, ceiling: null }
    const ceiling = resolveEffectiveCostCeiling(db, objective)
    const spentUsd = measureSpend()
    if (spentUsd < ceiling.costUsd) return { allowed: true, reason: null, spentUsd, ceiling }
    const reason =
      `${kind === 'spawn' ? 'Start' : 'Respawn'} refused by the spend guard: this card has spent ${usd(spentUsd)} ` +
      `against its ${usd(ceiling.costUsd)} ceiling (${describeCeilingSource(ceiling)}). ` +
      'Raise the ceiling in the card\'s spend panel to continue.'
    return { allowed: false, reason, spentUsd, ceiling }
  } catch (err) {
    console.error(`[spend-guard] spawn check failed for obj ${objective.id} (allowing):`, err)
    return { allowed: true, reason: null, spentUsd: 0, ceiling: null }
  }
}

/**
 * Refuse a spawn or respawn over the ceiling. Records the refusal on the card
 * (spend panel + activity_log) and throws {@link SpendCeilingRefusedError}.
 */
export function assertSpawnWithinCeiling(
  db: Database,
  objective: { id: number; workspace?: string | null; effort?: string | null; project?: string | null; session_id?: string | null },
  kind: SpawnKind,
  measureSpend: () => number,
): void {
  const verdict = checkSpawnCeiling(db, objective, kind, measureSpend)
  if (verdict.allowed || !verdict.ceiling || !verdict.reason) return
  try {
    updateGuardRow(db, objective.id, {
      last_refusal: verdict.reason,
      last_refusal_at: sqlTime(Date.now()),
      spent_usd: verdict.spentUsd,
      ceiling_usd: verdict.ceiling.costUsd,
      ceiling_source: verdict.ceiling.source,
    })
  } catch { /* table absent → the throw below still carries the reason */ }
  logSpendGuardActivity(db, objective, 'spend_guard_spawn_refused', verdict.reason, {
    spawn_kind: kind,
    spent_usd: verdict.spentUsd,
    ceiling_usd: verdict.ceiling.costUsd,
    ceiling_source: verdict.ceiling.source,
  })
  console.warn(`[spend-guard] obj ${objective.id}: ${verdict.reason}`)
  throw new SpendCeilingRefusedError(
    verdict.reason, objective.id, kind, verdict.spentUsd, verdict.ceiling.costUsd, verdict.ceiling.source,
  )
}

// ── Card view + owner controls ──────────────────────────────────────────────

/** The card panel's numbers. Spend is measured fresh; burn and projection come from the last live evaluation. */
export function buildSpendGuardView(
  db: Database,
  objective: GuardObjective,
  measureSpend: () => number,
  nowMs = Date.now(),
): SpendGuardView {
  const cfg = resolveSpendGuardConfig(db)
  const ceiling = resolveEffectiveCostCeiling(db, objective)
  const row = getGuardRow(db, objective.id)
  let spent = row?.spent_usd ?? 0
  try { spent = measureSpend() } catch { /* fall back to the last measurement */ }
  const measuredAt = parseSqlTime(row?.measured_at)
  // A projection is only meaningful while the card is running and was measured recently.
  const fresh = objective.status === 'working' && measuredAt !== null && nowMs - measuredAt <= Math.max(5 * 60_000, cfg.intervalMs * 3)
  return {
    objective_id: objective.id,
    ceiling_usd: ceiling.costUsd,
    ceiling_source: ceiling.source,
    ceiling_is_default: ceiling.isDefault,
    spent_usd: spent,
    projected_usd: fresh ? row?.projected_usd ?? null : null,
    burn_usd_per_min: fresh ? row?.burn_usd_per_min ?? null : null,
    horizon_minutes: row?.horizon_minutes ?? cfg.horizonMinutes,
    stage: (row?.stage ?? 'none') as SpendGuardStage,
    stage_at: row?.stage_at ?? null,
    last_action: row?.last_action ?? null,
    last_action_at: row?.last_action_at ?? null,
    last_refusal: row?.last_refusal ?? null,
    last_refusal_at: row?.last_refusal_at ?? null,
    degrade_allowed: isDegradeAllowed(db, objective.id, cfg),
    projection_guard_enabled: cfg.projectionEnabled,
    spawn_guard_enabled: cfg.spawnGuardEnabled,
    over_ceiling: spent >= ceiling.costUsd,
  }
}

/**
 * Owner control from the card: set an explicit cost ceiling and/or whether the
 * guard may degrade this card. Setting a ceiling clears a park/refusal so the
 * card can be resumed; it never touches any OTHER card's ceiling.
 */
export function applySpendSettings(
  db: Database,
  objective: { id: number; project?: string | null; workspace?: string | null },
  input: { costUsd?: number; degradeAllowed?: boolean },
  actor: string,
): void {
  const parts: string[] = []
  if (input.costUsd !== undefined) {
    const row = db.prepare('SELECT * FROM objective_job_accounting WHERE objective_id = ?').get(objective.id) as
      | { wallclock_ceiling_ms: number | null }
      | undefined
    db.prepare('INSERT OR IGNORE INTO objective_job_accounting (objective_id) VALUES (?)').run(objective.id)
    db.prepare(
      `UPDATE objective_job_accounting
          SET cost_ceiling_usd = ?, wallclock_ceiling_ms = ?, ceiling_source = 'objective',
              ceiling_set_at = datetime('now'), updated_at = datetime('now')
        WHERE objective_id = ?`,
    ).run(input.costUsd, row?.wallclock_ceiling_ms ?? null, objective.id)
    updateGuardRow(db, objective.id, {
      stage: 'none', stage_at: null, warned_at: null, degraded_at: null,
      last_refusal: null, last_refusal_at: null,
    })
    sharedBurnTracker.reset(objective.id)
    parts.push(`cost ceiling set to ${usd(input.costUsd)}`)
  }
  if (input.degradeAllowed !== undefined) {
    updateGuardRow(db, objective.id, { degrade_allowed: input.degradeAllowed ? 1 : 0 })
    parts.push(input.degradeAllowed ? 'cheaper-tier fallback allowed' : 'cheaper-tier fallback not allowed')
  }
  if (parts.length) {
    const msg = `${actor}: ${parts.join('; ')}.`
    updateGuardRow(db, objective.id, { last_action: msg, last_action_at: sqlTime(Date.now()) })
    logSpendGuardActivity(db, objective, 'spend_guard_ceiling_set', msg, { cost_usd: input.costUsd ?? null, degrade_allowed: input.degradeAllowed ?? null, actor })
  }
}
