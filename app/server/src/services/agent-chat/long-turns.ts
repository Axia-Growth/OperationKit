// ── Long chat turns run as a background job (obj 901491) ──
//
// Before this a chat turn had two hard walls, both too small for real board
// work ("merge these ten PRs"):
//
//   - 8 model rounds (engine.ts MAX_STEPS), then a red "Stopped after 8 steps
//     without a final answer" with no account of what the turn had done;
//   - one HTTP request held open for the whole turn. Nothing in this server
//     times it out, but the proxy in front does: Cloudflare answers 524 when
//     the origin has sent nothing for about 100 seconds.
//
// Now a turn runs under a BUDGET (steps + minutes, per bot, set by an admin)
// and the request that started it waits only a short FOREGROUND window. A turn
// that is still going when the window closes carries on server-side as a
// background job tied to the chat lane: the request answers 202 "working on
// it", each tool action lands in the lane as it happens (the page already
// re-reads a lane whose turn is running), and the final answer is posted as a
// normal bot message. A turn that reaches its budget, or is cut off by a
// restart, posts what it did, what it did not do and the next step.
//
// What this does NOT change: the turn is the SAME turn with the SAME
// ToolContext, so every tool gate (workspace list, Full access, operator
// tools needing a browser-typed message, merge grants) is evaluated exactly as
// it was, on every call. A background turn gets no tool a short turn lacks.
import { getDb } from '../../db/index.js'
import { laneThreadId, type ChatLane } from './threads.js'

/** The pre-901491 cap; still the cap when long turns are switched off, and for wakes. */
export const LEGACY_MAX_STEPS = 8

export const DEFAULT_TURN_MAX_STEPS = 60
export const DEFAULT_TURN_MAX_MINUTES = 30
/** How long the request that started a turn waits before answering "working on it". Well under a proxy's ~100s. */
export const DEFAULT_FOREGROUND_SECONDS = 20

export const TURN_STEPS_RANGE = { min: 8, max: 200 } as const
export const TURN_MINUTES_RANGE = { min: 2, max: 240 } as const
const FOREGROUND_RANGE = { min: 1, max: 90 } as const

export const SETTING_ENABLED = 'agent_chat_long_turns_enabled'
export const SETTING_MAX_STEPS = 'agent_chat_turn_max_steps'
export const SETTING_MAX_MINUTES = 'agent_chat_turn_max_minutes'
export const SETTING_FOREGROUND_SECONDS = 'agent_chat_turn_foreground_seconds'

export class TurnLimitsError extends Error {
  readonly status = 400
}

function setting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function intIn(raw: unknown, range: { min: number; max: number }): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  return Math.min(range.max, Math.max(range.min, n))
}

/** Install kill switch: `agent_chat_long_turns_enabled = '0'` puts every chat turn back on the old 8-step, request-bound path. */
export function longTurnsEnabled(): boolean {
  return setting(SETTING_ENABLED) !== '0'
}

export interface TurnLimits {
  slug: string
  /** null = the install default. */
  max_steps: number | null
  max_minutes: number | null
  updated_at: string | null
}

export function getTurnLimits(slug: string): TurnLimits {
  let r: { max_steps: number | null; max_minutes: number | null; updated_at: string } | undefined
  try {
    r = getDb().prepare('SELECT max_steps, max_minutes, updated_at FROM agent_chat_turn_limits WHERE slug = ?').get(slug) as typeof r
  } catch { /* no table yet → defaults */ }
  return { slug, max_steps: r?.max_steps ?? null, max_minutes: r?.max_minutes ?? null, updated_at: r?.updated_at ?? null }
}

function strictInt(v: unknown, name: string, range: { min: number; max: number }): number | null {
  if (v === null || v === '') return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < range.min || v > range.max) {
    throw new TurnLimitsError(`${name} must be a whole number from ${range.min} to ${range.max} (or empty for the install default)`)
  }
  return v
}

/** Save an admin's per-bot budget. Only the fields present change; null clears one back to the install default. */
export function setTurnLimits(slug: string, patch: { max_steps?: unknown; max_minutes?: unknown }, userId: number): TurnLimits {
  const cur = getTurnLimits(slug)
  const steps = patch.max_steps !== undefined ? strictInt(patch.max_steps, 'max_steps', TURN_STEPS_RANGE) : cur.max_steps
  const minutes = patch.max_minutes !== undefined ? strictInt(patch.max_minutes, 'max_minutes', TURN_MINUTES_RANGE) : cur.max_minutes
  getDb()
    .prepare(
      `INSERT INTO agent_chat_turn_limits (slug, max_steps, max_minutes, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slug) DO UPDATE SET max_steps = excluded.max_steps, max_minutes = excluded.max_minutes,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(slug, steps, minutes, userId)
  return getTurnLimits(slug)
}

export interface TurnBudget {
  /** false = long turns are off for the install: the old 8 steps, the request waits for the whole turn. */
  enabled: boolean
  maxSteps: number
  maxSeconds: number
  foregroundMs: number
}

export function installTurnDefaults(): { max_steps: number; max_minutes: number; foreground_seconds: number } {
  return {
    max_steps: intIn(setting(SETTING_MAX_STEPS), TURN_STEPS_RANGE) ?? DEFAULT_TURN_MAX_STEPS,
    max_minutes: intIn(setting(SETTING_MAX_MINUTES), TURN_MINUTES_RANGE) ?? DEFAULT_TURN_MAX_MINUTES,
    foreground_seconds: intIn(setting(SETTING_FOREGROUND_SECONDS), FOREGROUND_RANGE) ?? DEFAULT_FOREGROUND_SECONDS,
  }
}

/** The budget one chat turn of this bot runs under, read at the start of the turn (no restart needed after a change). */
export function turnBudgetFor(slug: string): TurnBudget {
  const d = installTurnDefaults()
  if (!longTurnsEnabled()) return { enabled: false, maxSteps: LEGACY_MAX_STEPS, maxSeconds: 0, foregroundMs: 0 }
  const own = getTurnLimits(slug)
  return {
    enabled: true,
    maxSteps: own.max_steps ?? d.max_steps,
    maxSeconds: (own.max_minutes ?? d.max_minutes) * 60,
    foregroundMs: d.foreground_seconds * 1000,
  }
}

// ── the job record ──

export type TurnJobStatus = 'running' | 'answered' | 'limit' | 'stopped' | 'failed' | 'interrupted'
export type TurnLimitReason = 'steps' | 'time'

export interface TurnJob {
  id: number
  user_id: number
  agent_slug: string
  thread_id: number | null
  status: TurnJobStatus
  background: boolean
  browser_session: boolean
  max_steps: number
  max_seconds: number
  steps: number
  tool_calls: number
  limit_reason: TurnLimitReason | null
  first_message_id: number | null
  note: string | null
  started_at: string
  detached_at: string | null
  finished_at: string | null
}

function mapJob(r: Record<string, unknown>): TurnJob {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    agent_slug: String(r.agent_slug),
    thread_id: r.thread_id === null || r.thread_id === undefined ? null : Number(r.thread_id),
    status: r.status as TurnJobStatus,
    background: Number(r.background) === 1,
    browser_session: Number(r.browser_session) === 1,
    max_steps: Number(r.max_steps),
    max_seconds: Number(r.max_seconds),
    steps: Number(r.steps),
    tool_calls: Number(r.tool_calls),
    limit_reason: (r.limit_reason as TurnLimitReason | null) ?? null,
    first_message_id: r.first_message_id === null || r.first_message_id === undefined ? null : Number(r.first_message_id),
    note: (r.note as string | null) ?? null,
    started_at: String(r.started_at),
    detached_at: (r.detached_at as string | null) ?? null,
    finished_at: (r.finished_at as string | null) ?? null,
  }
}

export function getTurnJob(id: number): TurnJob | null {
  const r = getDb().prepare('SELECT * FROM agent_chat_turn_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? mapJob(r) : null
}

export function startTurnJob(p: { userId: number; slug: string; lane: ChatLane; budget: TurnBudget; browserSession: boolean }): number {
  const info = getDb()
    .prepare('INSERT INTO agent_chat_turn_jobs (user_id, agent_slug, thread_id, max_steps, max_seconds, browser_session) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.userId, p.slug, laneThreadId(p.lane), p.budget.maxSteps, p.budget.maxSeconds, p.browserSession ? 1 : 0)
  return Number(info.lastInsertRowid)
}

/** Progress, written as the turn runs. Never throws: bookkeeping must not break a turn. */
export function noteTurnProgress(id: number, p: { steps?: number; toolCalls?: number; firstMessageId?: number }): void {
  try {
    getDb()
      .prepare(
        `UPDATE agent_chat_turn_jobs
            SET steps = COALESCE(?, steps), tool_calls = COALESCE(?, tool_calls), first_message_id = COALESCE(first_message_id, ?)
          WHERE id = ? AND status = 'running'`,
      )
      .run(p.steps ?? null, p.toolCalls ?? null, p.firstMessageId ?? null, id)
  } catch { /* best effort */ }
}

/** The request that started this turn was answered "working on it"; the turn carries on by itself. */
export function markTurnBackground(id: number): void {
  try {
    getDb().prepare(`UPDATE agent_chat_turn_jobs SET background = 1, detached_at = COALESCE(detached_at, datetime('now')) WHERE id = ?`).run(id)
  } catch { /* best effort */ }
}

export function finishTurnJob(id: number, status: Exclude<TurnJobStatus, 'running'>, extra: { limitReason?: TurnLimitReason; note?: string } = {}): void {
  try {
    getDb()
      .prepare(`UPDATE agent_chat_turn_jobs SET status = ?, limit_reason = ?, note = ?, finished_at = datetime('now') WHERE id = ? AND status = 'running'`)
      .run(status, extra.limitReason ?? null, extra.note ? extra.note.slice(0, 500) : null, id)
  } catch { /* best effort */ }
}

/** The running job of one lane, for the composer ("step 12 of 60"). */
export function runningTurnJob(userId: number, slug: string, lane: ChatLane): TurnJob | null {
  const threadId = laneThreadId(lane)
  try {
    const r = getDb()
      .prepare(
        `SELECT * FROM agent_chat_turn_jobs
          WHERE user_id = ? AND agent_slug = ? AND status = 'running' AND ${threadId === null ? 'thread_id IS NULL' : 'thread_id = ?'}
          ORDER BY id DESC LIMIT 1`,
      )
      .get(...(threadId === null ? [userId, slug] : [userId, slug, threadId])) as Record<string, unknown> | undefined
    return r ? mapJob(r) : null
  } catch {
    return null
  }
}

/** Recent jobs of one bot — the admin's view on the bot settings panel. No message text, only the record. */
export function recentTurnJobs(slug: string, limit = 10): TurnJob[] {
  try {
    const rows = getDb().prepare('SELECT * FROM agent_chat_turn_jobs WHERE agent_slug = ? ORDER BY id DESC LIMIT ?').all(slug, Math.min(50, Math.max(1, limit))) as Record<string, unknown>[]
    return rows.map(mapJob)
  } catch {
    return []
  }
}

// ── the "never ends silently" report ──

export interface DoneLine {
  tool: string | null
  summary: string
  ok: boolean
}

const REPORT_MAX_LINES = 15

function minutesText(seconds: number): string {
  const m = Math.round(seconds / 60)
  return m === 1 ? '1 minute' : `${m} minutes`
}

/**
 * What a turn posts when it stops short: what it did, what it did not do, the
 * next step. Built from the tool lines the turn already recorded — no model
 * call, so it cannot itself fail or run long.
 *
 * (Card #901488 adds a model-written version of the step-limit answer and a
 * Continue button. This is the floor under it: it also covers the time budget
 * and a restart, where there may be no model to ask.)
 */
export function turnStopReport(p: { why: 'steps' | 'time' | 'restart'; budget: { maxSteps: number; maxSeconds: number }; done: DoneLine[] }): string {
  const head =
    p.why === 'steps'
      ? `I reached this reply's step limit (${p.budget.maxSteps} steps) before I finished.`
      : p.why === 'time'
        ? `I reached this reply's time limit (${minutesText(p.budget.maxSeconds)}) before I finished.`
        : 'The server restarted while I was working on this, so this reply was cut off.'
  const shown = p.done.slice(-REPORT_MAX_LINES)
  const hidden = p.done.length - shown.length
  const failed = p.done.filter(d => !d.ok).length
  const doneLines = p.done.length
    ? [
        ...(hidden > 0 ? [`- (${hidden} earlier ${hidden === 1 ? 'action' : 'actions'} are in the chat above)`] : []),
        ...shown.map(d => `- ${d.ok ? '' : 'FAILED: '}${d.tool ? `${d.tool}: ` : ''}${d.summary.replace(/\s+/g, ' ').slice(0, 200)}`),
      ]
    : ['- Nothing yet: no action had finished.']
  return [
    head,
    '',
    `**Done so far** (${p.done.length} ${p.done.length === 1 ? 'action' : 'actions'}${failed ? `, ${failed} failed` : ''}):`,
    ...doneLines,
    '',
    p.why === 'restart'
      ? '**Not done:** anything not in that list. The action that was running when the server restarted may or may not have gone through, so check it before repeating it.'
      : '**Not done:** anything not in that list. I had not finished the request or written a final answer.',
    '',
    p.why === 'restart'
      ? '**Next step:** send "continue" and I will check where things stand and carry on.'
      : '**Next step:** send "continue" and I will carry on from here with a fresh budget. An admin can raise the limit under this bot\'s Settings → Long replies.',
  ].join('\n')
}

/** The tool lines a turn recorded in its lane, from its first row on. */
export function doneLinesSince(userId: number, slug: string, threadId: number | null, firstMessageId: number | null): DoneLine[] {
  if (!firstMessageId) return []
  const rows = getDb()
    .prepare(
      `SELECT tool_name, content, meta FROM agent_chat_messages
        WHERE user_id = ? AND agent_slug = ? AND ${threadId === null ? 'thread_id IS NULL' : 'thread_id = ?'} AND id >= ? AND role = 'tool'
        ORDER BY id`,
    )
    .all(...(threadId === null ? [userId, slug, firstMessageId] : [userId, slug, threadId, firstMessageId])) as { tool_name: string | null; content: string; meta: string | null }[]
  return rows.map(r => {
    let ok = true
    try { ok = (JSON.parse(r.meta ?? '{}') as { ok?: boolean }).ok !== false } catch { /* a line with unreadable meta counts as done */ }
    return { tool: r.tool_name, summary: String(r.content ?? ''), ok }
  })
}

/**
 * A restart kills every turn in memory. On boot, each job still marked
 * `running` is one of those: close it as `interrupted` and post the report in
 * its lane, so the person finds an answer where they were waiting for one.
 * Runs once per boot, before any new turn can start; safe to call again.
 */
export function recoverInterruptedTurns(notify?: (userId: number, slug: string) => void): number {
  const db = getDb()
  let rows: Record<string, unknown>[] = []
  try {
    rows = db.prepare(`SELECT * FROM agent_chat_turn_jobs WHERE status = 'running' ORDER BY id`).all() as Record<string, unknown>[]
  } catch {
    return 0
  }
  let n = 0
  for (const raw of rows) {
    const job = mapJob(raw)
    try {
      const claimed = db
        .prepare(`UPDATE agent_chat_turn_jobs SET status = 'interrupted', note = 'server restart', finished_at = datetime('now') WHERE id = ? AND status = 'running'`)
        .run(job.id).changes
      if (!claimed) continue
      const content = turnStopReport({
        why: 'restart',
        budget: { maxSteps: job.max_steps, maxSeconds: job.max_seconds },
        done: doneLinesSince(job.user_id, job.agent_slug, job.thread_id, job.first_message_id),
      })
      db.prepare('INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, provider, model, tool_name, meta, thread_id) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)').run(
        job.user_id,
        job.agent_slug,
        'assistant',
        content,
        JSON.stringify({ kind: 'turn_interrupted', turn_job_id: job.id }),
        job.thread_id,
      )
      n++
      try { notify?.(job.user_id, job.agent_slug) } catch { /* the sidebar push never decides this */ }
    } catch (err) {
      console.error(`[agent-chat] long turn #${job.id}: could not post the restart report:`, err instanceof Error ? err.message : err)
    }
  }
  if (n) console.log(`[agent-chat] long turns: ${n} turn(s) cut off by a restart were closed with a report in their chat`)
  return n
}
