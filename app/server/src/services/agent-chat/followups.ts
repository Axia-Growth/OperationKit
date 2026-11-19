// ── One-off follow-up wakes a chat bot sets for itself (obj 901392) ──
//
// A chat bot could only act when the person typed, or on its High Agency wake.
// So after starting a card from chat it had to ask the person to come back and
// say "check". This is the timer that replaces that:
//
//   schedule_followup {in_minutes, note, card_id?, when_card_changes?}
//   list_followups
//   cancel_followup {id}
//
// A follow-up is a row in `bot_followups`, tied to ONE chat lane (person, bot,
// main conversation or one side thread). When it is due the drain in
// followup-wake.ts runs an ordinary turn of that bot in that lane, started by
// the bot's own note instead of a typed message. This file is the store, the
// limits and the three tools; it never calls a model.
//
// What a follow-up is NOT:
//  - It is not a new power. The turn it starts is engine.runTurn, the same
//    function a typed message runs, for the same person, bot and lane — so the
//    tools, workspace access, Full access and standing grants are exactly what
//    a normal turn has at that moment, re-read when it fires.
//  - It is not the person. The note is the bot's own text; it never counts as
//    an approval of a merge, a deploy, a prod migration or a decision.
//  - It is not a loop. At most `bot_followups_max_pending` (5) wait in one chat,
//    and a chain stops after `bot_followups_max_hops` (6) follow-ups in a row
//    with no message from the person.
import crypto from 'crypto'
import { getDb } from '../../db/index.js'
import { logActivity } from '../../routes/feed.js'
import { laneThreadId, MAIN_LANE, type ChatLane } from './threads.js'
import { agentHasTool, getBoardCard, ToolUseError, type ToolContext, type ToolOutcome, type ToolSpec } from './tools.js'

export const FOLLOWUP_TOOL = 'followups'
export const FOLLOWUP_FNS: ReadonlySet<string> = new Set(['schedule_followup', 'list_followups', 'cancel_followup'])
/** tool_name of the line the server writes into the chat when a follow-up fires. */
export const FOLLOWUP_WAKE_TOOL_NAME = 'followup_wake'

/** The chat ground rule a bot with the follow-up tools gets on every turn (engine.systemPromptFor). */
export const FOLLOWUP_PROMPT_LINE =
  '- You can check back on your own: after you start or nudge a card from this chat (or begin anything that takes a while), call schedule_followup instead of asking the person to come back and say "check", and tell them when it will fire. A follow-up is your own timer, never the person: it cannot approve a merge, deploy, migration or decision.'

export const MIN_FOLLOWUP_MINUTES = 2
export const MAX_FOLLOWUP_MINUTES = 1440
export const MAX_FOLLOWUP_NOTE = 1000
export const DEFAULT_MAX_PENDING = 5
export const DEFAULT_MAX_HOPS = 6

export type FollowupStatus = 'pending' | 'running' | 'fired' | 'failed' | 'cancelled' | 'dropped'

export interface FollowupRow {
  id: number
  user_id: number
  agent_slug: string
  thread_id: number | null
  workspace: string
  note: string
  card_id: number | null
  when_card_changes: number
  card_fingerprint: string | null
  due_at: string
  hop: number
  status: FollowupStatus
  fire_reason: string | null
  end_reason: string | null
  cancelled_by: string | null
  attempts: number
  next_attempt_at: string | null
  lease_until: string | null
  last_error: string | null
  reply_message_id: number | null
  created_at: string
  fired_at: string | null
  finished_at: string | null
}

/** What the chat UI and the activity log get for one follow-up. Times are ISO 8601 (UTC). */
export interface FollowupInfo {
  id: number
  status: FollowupStatus
  note: string
  card_id: number | null
  when_card_changes: boolean
  due_at: string
  hop: number
  thread_id: number | null
  /** 'due' | 'card_changed' once it fired. */
  fire_reason: string | null
  /** Why it was dropped / failed, or who cancelled it. */
  end_reason: string | null
  created_at: string
  fired_at: string | null
  finished_at: string | null
}

// ── settings (read at point of use, no restart) ──

function setting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function intSetting(key: string, fallback: number, min: number, max: number): number {
  const raw = setting(key)
  if (raw === null || raw.trim() === '') return fallback
  const n = Math.trunc(Number(raw))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Kill switch: settings.bot_followups_enabled = '0' hides the tools and parks the drain. */
export function followupsEnabled(): boolean {
  return setting('bot_followups_enabled') !== '0'
}

/** Most follow-ups that may WAIT in one chat lane at a time. settings.bot_followups_max_pending, default 5. */
export function maxPendingFollowups(): number {
  return intSetting('bot_followups_max_pending', DEFAULT_MAX_PENDING, 1, 50)
}

/** Most follow-ups in a row with no message from the person. settings.bot_followups_max_hops, default 6. */
export function maxFollowupHops(): number {
  return intSetting('bot_followups_max_hops', DEFAULT_MAX_HOPS, 1, 50)
}

// ── time ──

export function sqlTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

/** A stored 'YYYY-MM-DD HH:MM:SS' (UTC) as ISO 8601. */
export function isoTime(sql: string | null): string | null {
  if (!sql) return null
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sql) ? `${sql.replace(' ', 'T')}Z` : sql
}

/** HH:MM in server time — the clock the chat's ground rules already give the bot. */
export function serverClock(d: Date): string {
  return d.toTimeString().slice(0, 5)
}

// ── rows ──

export function getFollowup(id: number): FollowupRow | null {
  if (!Number.isInteger(id) || id <= 0) return null
  return (getDb().prepare('SELECT * FROM bot_followups WHERE id = ?').get(id) as FollowupRow | undefined) ?? null
}

export function followupInfo(r: FollowupRow): FollowupInfo {
  return {
    id: r.id,
    status: r.status,
    note: r.note,
    card_id: r.card_id,
    when_card_changes: Number(r.when_card_changes) === 1,
    due_at: isoTime(r.due_at) as string,
    hop: r.hop,
    thread_id: r.thread_id,
    fire_reason: r.fire_reason,
    end_reason: r.status === 'cancelled' ? r.cancelled_by : r.end_reason ?? r.last_error,
    created_at: isoTime(r.created_at) as string,
    fired_at: isoTime(r.fired_at),
    finished_at: isoTime(r.finished_at),
  }
}

function laneSql(lane: ChatLane): { sql: string; params: number[] } {
  return lane.kind === 'main' ? { sql: 'thread_id IS NULL', params: [] } : { sql: 'thread_id = ?', params: [lane.id] }
}

export function laneOfFollowup(r: Pick<FollowupRow, 'thread_id'>): ChatLane {
  return r.thread_id == null ? MAIN_LANE : { kind: 'thread', id: r.thread_id }
}

/** Follow-ups still waiting in one lane, soonest first. */
export function pendingFollowups(userId: number, slug: string, lane: ChatLane): FollowupRow[] {
  const l = laneSql(lane)
  return getDb()
    .prepare(`SELECT * FROM bot_followups WHERE user_id = ? AND agent_slug = ? AND ${l.sql} AND status = 'pending' ORDER BY due_at, id`)
    .all(userId, slug, ...l.params) as FollowupRow[]
}

/** Follow-ups by id, only this person's with this bot (the chat UI's lookup for the lines it shows). */
export function followupsByIds(userId: number, slug: string, ids: number[]): FollowupInfo[] {
  const clean = [...new Set(ids.filter(n => Number.isInteger(n) && n > 0))]
  if (clean.length === 0) return []
  const rows = getDb()
    .prepare(`SELECT * FROM bot_followups WHERE user_id = ? AND agent_slug = ? AND id IN (${clean.map(() => '?').join(', ')}) ORDER BY id`)
    .all(userId, slug, ...clean) as FollowupRow[]
  return rows.map(followupInfo)
}

/** This person's follow-ups with this bot, newest first: the log (fired, cancelled, dropped, failed) plus what still waits. */
export function followupLog(userId: number, slug: string, limit = 30): FollowupInfo[] {
  const rows = getDb()
    .prepare('SELECT * FROM bot_followups WHERE user_id = ? AND agent_slug = ? ORDER BY COALESCE(finished_at, fired_at, created_at) DESC, id DESC LIMIT ?')
    .all(userId, slug, Math.min(200, Math.max(1, limit))) as FollowupRow[]
  return rows.map(followupInfo)
}

// ── log ──

/** One activity-feed line per schedule / fire / cancel / drop / refusal. The row itself is the durable record. */
export function auditFollowup(kind: string, title: string, r: Pick<FollowupRow, 'id' | 'agent_slug' | 'workspace' | 'user_id' | 'card_id' | 'hop'>, extra: Record<string, unknown> = {}): void {
  try {
    logActivity({
      project: 'operationkit',
      workspace: r.workspace || undefined,
      event_type: kind === 'bot_followup_failed' ? 'error' : 'progress',
      title: title.slice(0, 200),
      metadata: { kind, followup_id: r.id, bot: r.agent_slug, user_id: r.user_id, card_id: r.card_id, hop: r.hop, ...extra },
    })
  } catch { /* the activity feed is best-effort */ }
  console.log(`[bot-followups] ${kind} #${r.id} bot=${r.agent_slug} user=${r.user_id}${extra.reason ? ` reason=${String(extra.reason)}` : ''}`)
}

// ── the card a follow-up waits on ──

/**
 * What "the card moved" means for when_card_changes: its status, PR, review
 * verdict, job disposition or last result. Deliberately NOT updated_at, which a
 * working card touches all the time.
 */
export function cardFingerprint(cardId: number): string | null {
  let r: Record<string, unknown> | undefined
  try {
    r = getDb()
      .prepare('SELECT status, pr_url, ai_review_verdict, job_disposition, last_session_summary, deleted_at FROM objectives WHERE id = ?')
      .get(cardId) as Record<string, unknown> | undefined
  } catch {
    return null
  }
  if (!r) return null
  const parts = [r.status, r.pr_url, r.ai_review_verdict, r.job_disposition, r.last_session_summary, r.deleted_at].map(v => (v == null ? '' : String(v)))
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex')
}

// ── schedule / cancel ──

export class FollowupRefused extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

export interface ScheduleInput {
  userId: number
  slug: string
  lane: ChatLane
  workspace: string
  inMinutes: number
  note: string
  cardId?: number | null
  whenCardChanges?: boolean
  /** 1 for a turn the person started; the firing follow-up's hop + 1 inside a follow-up turn. */
  hop: number
  now: Date
}

/** Store one follow-up, under the limits. Throws FollowupRefused with a reason the bot can repeat. */
export function scheduleFollowup(p: ScheduleInput): FollowupRow {
  if (!followupsEnabled()) throw new FollowupRefused('Follow-ups are switched off on this install.', 'disabled')
  if (!Number.isInteger(p.inMinutes) || p.inMinutes < MIN_FOLLOWUP_MINUTES || p.inMinutes > MAX_FOLLOWUP_MINUTES) {
    throw new FollowupRefused(`in_minutes must be a whole number from ${MIN_FOLLOWUP_MINUTES} to ${MAX_FOLLOWUP_MINUTES}.`, 'bad_minutes')
  }
  const note = p.note.replace(/\s+/g, ' ').trim()
  if (!note) throw new FollowupRefused('note is required: say what to check and what to do then.', 'bad_note')
  if (note.length > MAX_FOLLOWUP_NOTE) throw new FollowupRefused(`note is too long (${MAX_FOLLOWUP_NOTE} characters max).`, 'bad_note')
  if (p.whenCardChanges && !p.cardId) throw new FollowupRefused('when_card_changes needs card_id.', 'bad_card')
  const maxHops = maxFollowupHops()
  if (p.hop > maxHops) {
    throw new FollowupRefused(
      `Not scheduled: this would be follow-up ${p.hop} in a row with no message from the person, and the limit is ${maxHops}. ` +
        'Do not try again. Tell the person plainly that you have stopped checking on your own, why (the limit on automatic follow-ups), where things stand now, and that a message from them starts it again.',
      'max_hops',
    )
  }
  const maxPending = maxPendingFollowups()
  const waiting = pendingFollowups(p.userId, p.slug, p.lane)
  if (waiting.length >= maxPending) {
    throw new FollowupRefused(
      `Not scheduled: ${waiting.length} follow-ups are already waiting in this chat and the limit is ${maxPending}. Cancel one with cancel_followup (see list_followups) or wait for one to fire.`,
      'max_pending',
    )
  }
  const db = getDb()
  const due = new Date(p.now.getTime() + p.inMinutes * 60_000)
  const info = db
    .prepare(
      `INSERT INTO bot_followups (user_id, agent_slug, thread_id, workspace, note, card_id, when_card_changes, card_fingerprint, due_at, hop, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.userId,
      p.slug,
      laneThreadId(p.lane),
      p.workspace || '',
      note,
      p.cardId ?? null,
      p.whenCardChanges ? 1 : 0,
      p.whenCardChanges && p.cardId ? cardFingerprint(p.cardId) : null,
      sqlTime(due),
      p.hop,
      sqlTime(p.now),
    )
  const row = getFollowup(Number(info.lastInsertRowid)) as FollowupRow
  auditFollowup('bot_followup_scheduled', `Follow-up #${row.id} scheduled by ${p.slug} for ${sqlTime(due)} UTC`, row, { due_at: row.due_at })
  return row
}

/**
 * Cancel one WAITING follow-up of this person's chat with this bot. `lane` set =
 * it must be in that lane too (the bot's own tool). False = nothing to cancel.
 */
export function cancelFollowup(p: { userId: number; slug: string; id: number; by: 'person' | 'bot'; lane?: ChatLane; now?: Date }): FollowupRow | null {
  const r = getFollowup(p.id)
  if (!r || r.user_id !== p.userId || r.agent_slug.toLowerCase() !== p.slug.toLowerCase()) return null
  if (p.lane && laneThreadId(p.lane) !== r.thread_id) return null
  const changed = getDb()
    .prepare("UPDATE bot_followups SET status = 'cancelled', cancelled_by = ?, finished_at = ?, lease_until = NULL WHERE id = ? AND status = 'pending'")
    .run(p.by, sqlTime(p.now ?? new Date()), r.id).changes
  if (changed !== 1) return null
  const row = getFollowup(r.id) as FollowupRow
  auditFollowup('bot_followup_cancelled', `Follow-up #${row.id} of ${row.agent_slug} cancelled by the ${p.by}`, row, { by: p.by })
  return row
}

/** Drop what still waits in a lane (the chat was cleared or the thread deleted). Logged per row. */
export function dropLaneFollowups(userId: number, slug: string, lane: ChatLane, reason: string, now: Date = new Date()): number {
  let n = 0
  for (const r of pendingFollowups(userId, slug, lane)) if (dropFollowup(r, reason, now)) n++
  return n
}

/** pending|running → dropped, with the reason on the row and in the log. */
export function dropFollowup(r: FollowupRow, reason: string, now: Date = new Date()): boolean {
  const changed = getDb()
    .prepare("UPDATE bot_followups SET status = 'dropped', end_reason = ?, finished_at = ?, lease_until = NULL WHERE id = ? AND status IN ('pending', 'running')")
    .run(reason.slice(0, 300), sqlTime(now), r.id).changes
  if (changed === 1) auditFollowup('bot_followup_dropped', `Follow-up #${r.id} of ${r.agent_slug} dropped: ${reason}`, r, { reason })
  return changed === 1
}

// ── the three chat tools ──

const SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'schedule_followup',
      description:
        'Set a ONE-OFF timer for yourself: in N minutes you are woken in THIS chat with your note, run a normal turn with your usual tools, and your answer is posted here without the person typing anything. ' +
        'Use it after you start or nudge a card (or anything else that takes a while) instead of asking the person to come back and say "check". Tell the person when it will fire. ' +
        'The wake has exactly your normal permissions and is NOT the person: it never approves a merge, deploy, migration or decision. Do not put a password or key in the note; the person sees it.',
      parameters: {
        type: 'object',
        properties: {
          in_minutes: { type: 'integer', minimum: MIN_FOLLOWUP_MINUTES, maximum: MAX_FOLLOWUP_MINUTES, description: 'Minutes from now (2 to 1440).' },
          note: { type: 'string', description: 'For your future self: what to check and what to do then. You will not remember anything that is not in this chat or this note.' },
          card_id: { type: 'integer', description: 'The card you are waiting on, if any. Its current status is included when you are woken.' },
          when_card_changes: { type: 'boolean', description: 'With card_id: wake early, as soon as that card changes status or writes a new result; otherwise at the time limit.' },
        },
        required: ['in_minutes', 'note'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_followups',
      description: 'List the follow-ups you have waiting in this chat: id, when each fires, its note and card.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_followup',
      description: 'Cancel one of your waiting follow-ups in this chat by id (from schedule_followup or list_followups).',
      parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
    },
  },
]

/**
 * Offered to an ordinary chat turn (and to a follow-up turn, which IS one) of a
 * bot that has the `followups` tool. Never to a card wake or a bot-to-bot wake:
 * those do not run in a lane of the person's chat.
 */
export function followupToolSpecs(ctx: ToolContext): ToolSpec[] {
  if (ctx.cardWake || ctx.botWake) return []
  if (!agentHasTool(ctx.agent, FOLLOWUP_TOOL)) return []
  if (!followupsEnabled()) return []
  return SPECS.map(s => ({ ...s, function: { ...s.function } }))
}

function forModel(r: FollowupRow): Record<string, unknown> {
  return {
    id: r.id,
    fires_at: isoTime(r.due_at),
    fires_at_server_time: serverClock(new Date(isoTime(r.due_at) as string)),
    note: r.note,
    ...(r.card_id ? { card_id: r.card_id, when_card_changes: Number(r.when_card_changes) === 1 } : {}),
  }
}

export async function runFollowupTool(ctx: ToolContext, fnName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!FOLLOWUP_FNS.has(fnName)) throw new ToolUseError(`Unknown tool "${fnName}".`)
  if (ctx.cardWake || ctx.botWake) throw new ToolUseError('Follow-ups are not available in a wake turn.')
  if (!agentHasTool(ctx.agent, FOLLOWUP_TOOL)) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)
  if (!followupsEnabled()) throw new ToolUseError('Follow-ups are switched off on this install.')
  const lane = ctx.lane ?? MAIN_LANE
  const now = ctx.now?.() ?? new Date()

  if (fnName === 'list_followups') {
    const rows = pendingFollowups(ctx.userId, ctx.agent.slug, lane)
    return {
      result: { followups: rows.map(forModel), max_pending: maxPendingFollowups() },
      summary: rows.length === 0 ? 'No follow-ups waiting in this chat' : `${rows.length} follow-up${rows.length === 1 ? '' : 's'} waiting in this chat`,
    }
  }

  if (fnName === 'cancel_followup') {
    const id = Number(args.id)
    if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a follow-up id.')
    const row = cancelFollowup({ userId: ctx.userId, slug: ctx.agent.slug, id, by: 'bot', lane, now })
    if (!row) throw new ToolUseError(`No waiting follow-up #${id} in this chat.`)
    return { result: { cancelled: true, id }, summary: `Follow-up #${id} cancelled`, followup_id: id }
  }

  // schedule_followup
  const inMinutes = Number(args.in_minutes)
  const note = typeof args.note === 'string' ? args.note : ''
  const cardId = args.card_id === undefined || args.card_id === null ? null : Number(args.card_id)
  if (cardId !== null) {
    // Only a card the person could open on the board, in a workspace the bot may use. Throws otherwise.
    getBoardCard(ctx, cardId)
  }
  // A follow-up set inside a follow-up turn is one hop deeper, unless the person spoke in between.
  const hop = ctx.followup && !ctx.followup.personSpoke ? ctx.followup.hop + 1 : 1
  let row: FollowupRow
  try {
    row = scheduleFollowup({
      userId: ctx.userId,
      slug: ctx.agent.slug,
      lane,
      workspace: ctx.workspace,
      inMinutes,
      note,
      cardId,
      whenCardChanges: args.when_card_changes === true,
      hop,
      now,
    })
  } catch (err) {
    if (err instanceof FollowupRefused) {
      if (err.code === 'max_hops' || err.code === 'max_pending') {
        auditFollowup('bot_followup_refused', `Follow-up refused for ${ctx.agent.slug}: ${err.code}`, { id: 0, agent_slug: ctx.agent.slug, workspace: ctx.workspace, user_id: ctx.userId, card_id: cardId, hop }, { reason: err.code })
      }
      throw new ToolUseError(err.message)
    }
    throw err
  }
  const due = new Date(isoTime(row.due_at) as string)
  const maxHops = maxFollowupHops()
  return {
    result: {
      scheduled: true,
      id: row.id,
      fires_at: isoTime(row.due_at),
      fires_at_server_time: serverClock(due),
      in_minutes: inMinutes,
      ...(row.card_id ? { card_id: row.card_id, when_card_changes: Number(row.when_card_changes) === 1 } : {}),
      followup_in_a_row: row.hop,
      max_in_a_row: maxHops,
    },
    // Stored as the chat line; the UI renders the live state (and Cancel) from the row.
    summary: `Follow-up scheduled for ${serverClock(due)}: ${row.note}`.slice(0, 600),
    followup_id: row.id,
    ...(row.card_id ? { objective_id: row.card_id } : {}),
  }
}
