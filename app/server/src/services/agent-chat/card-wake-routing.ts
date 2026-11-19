// ── needs_agent card wakes: who gets one, and the outbox (obj 901328) ──
//
// Before this, every needs_agent event (and completion wake) left the box as a
// webhook: to the key that filed the card, or for a keyless card to the bot's
// own webhook, else the General's (obj 900553). The CoS forwards on the
// raw `owner_bot` string, which reaches EXTERNAL Grok bots only. A card owned by
// an Operation Kit chat bot (Example CTO, SEO/GEO, Operation Kit Dev …) never woke
// that bot unless High Agency happened to be on.
//
// Now the enqueue tick asks `resolveCardWakeRoute` first. When the card's owner
// (`cardOwnerBot`, the ONE ownership rule, with the same name/slug folding the
// High Agency own-card gate uses) is a chat bot installed here, its card wakes
// are on, and it may work in the card's workspace for a real person, the event
// becomes a `bot_card_wakes` row instead of a webhook delivery. Anything else —
// no owner, an external Grok bot, the switch off, a workspace the bot cannot
// use — returns a refusal and the webhook path runs exactly as it did.
//
// Burst control, at enqueue (`enqueueCardWake`), per bot + card (obj 901394):
//   - DEBOUNCE: a new wake waits `bot_card_wake_debounce_seconds` (default 60) before
//     it runs, so events that land close together are answered in ONE turn. The drain
//     also folds every wake of the same bot + person + workspace that is due inside
//     that window into the turn it is about to run (card-wakes.ts);
//   - a wake still pending absorbs the new one (coalesced);
//   - a wake that ran for this card inside the window (default 10 min) DEFERS the new
//     one to the end of the window. It is not dropped: before obj 901394 it was, which
//     lost e.g. "PR merged" five minutes after "entered review";
//   - per bot, at most N wake TURNS an hour across all its cards (bot_hourly_cap).
//     When the cap is hit the event is kept as a `skipped` row and ONE plain line is
//     posted in the person's chat with the bot, so it never goes silent;
//   - an event the bot caused ITSELF (it closed, moved, messaged, restarted or merged
//     the card in a turn of its own) never wakes it: `bot_card_wake_self_actions`
//     records the objective_events id range of each such action, and an event inside a
//     range is kept as a `skipped` row (self_caused).
// A suppressed event is kept as a `skipped` row with its reason, never dropped
// silently. Nothing here needs configuring; the settings below only tune it.
import type Database from 'better-sqlite3'
import { getDb } from '../../db/index.js'
import { cardOwnerBot, installedChatBots, type ChatBotRef, type OwnedCard } from '../bots/card-owner.js'
import { botMayUseWorkspace } from './bot-workspaces.js'
import { botMessageWorkspaces } from './bot-messaging.js'

/** Kill switch for the whole in-product path. Default on: no row = on. */
export const CARD_WAKES_ENABLED_SETTING = 'bot_card_wakes_enabled'
export const CARD_WAKE_WINDOW_SETTING = 'bot_card_wake_window_minutes'
export const CARD_WAKE_HOURLY_CAP_SETTING = 'bot_card_wake_max_per_hour'
/** Seconds a new wake waits so close-together events share one turn. 0 = no wait. */
export const CARD_WAKE_DEBOUNCE_SETTING = 'bot_card_wake_debounce_seconds'
/** `chat` (default) = the bot's normal chat tools plus the own-card tools; `own_cards` = the own-card tools only (the obj 901328 scope). */
export const CARD_WAKE_TOOLS_SETTING = 'bot_card_wake_tools'
/** '0' = the wake's answer stays in the "Card wakes" thread only. Default: also posted in the main chat. */
export const CARD_WAKE_POST_TO_CHAT_SETTING = 'bot_card_wake_post_to_chat'
export const DEFAULT_CARD_WAKE_WINDOW_MINUTES = 10
export const DEFAULT_CARD_WAKE_MAX_PER_HOUR = 12
export const DEFAULT_CARD_WAKE_DEBOUNCE_SECONDS = 60
export const CARD_WAKES_THREAD_TITLE = 'Card wakes'

function setting(db: Database.Database, key: string): string | null {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value ?? null
  } catch {
    return null
  }
}

function numberSetting(db: Database.Database, key: string, dflt: number): number {
  const raw = setting(db, key)
  if (raw === null || raw.trim() === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

export function cardWakesGloballyEnabled(db: Database.Database = getDb()): boolean {
  return setting(db, CARD_WAKES_ENABLED_SETTING) !== '0'
}

export function cardWakeWindowMinutes(db: Database.Database = getDb()): number {
  return numberSetting(db, CARD_WAKE_WINDOW_SETTING, DEFAULT_CARD_WAKE_WINDOW_MINUTES)
}

export function cardWakeMaxPerHour(db: Database.Database = getDb()): number {
  return numberSetting(db, CARD_WAKE_HOURLY_CAP_SETTING, DEFAULT_CARD_WAKE_MAX_PER_HOUR)
}

export function cardWakeDebounceSeconds(db: Database.Database = getDb()): number {
  return Math.min(900, numberSetting(db, CARD_WAKE_DEBOUNCE_SETTING, DEFAULT_CARD_WAKE_DEBOUNCE_SECONDS))
}

export type CardWakeToolScope = 'chat' | 'own_cards'

export function cardWakeToolScope(db: Database.Database = getDb()): CardWakeToolScope {
  return setting(db, CARD_WAKE_TOOLS_SETTING) === 'own_cards' ? 'own_cards' : 'chat'
}

export function cardWakePostsToChat(db: Database.Database = getDb()): boolean {
  return setting(db, CARD_WAKE_POST_TO_CHAT_SETTING) !== '0'
}

/** Wake TURNS this bot started in the last hour (a wake folded into another turn is not a turn). */
export function cardWakeTurnsLastHour(db: Database.Database, slug: string, now: Date): number {
  return (db
    .prepare("SELECT COUNT(*) AS n FROM bot_card_wakes WHERE lower(slug) = lower(?) AND started_at IS NOT NULL AND started_at > ? AND status IN ('running', 'done', 'failed')")
    .get(slug, sqlTime(new Date(now.getTime() - 3600_000))) as { n: number }).n
}

/**
 * The one plain line a person sees when the hourly cap stops a wake. Posted at
 * most once an hour per bot + person (the marker is the message itself), so a
 * burst over the cap is one line, not one per card.
 */
export function postCardWakeCapLine(db: Database.Database, p: { slug: string; userId: number; objectiveId: number; cap: number }, now: Date = new Date()): boolean {
  try {
    const since = sqlTime(new Date(now.getTime() - 3600_000))
    const seen = db
      .prepare("SELECT id FROM agent_chat_messages WHERE user_id = ? AND lower(agent_slug) = lower(?) AND created_at > ? AND meta LIKE '%\"kind\":\"card_wake_cap\"%' LIMIT 1")
      .get(p.userId, p.slug, since)
    if (seen) return false
    db.prepare("INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, meta, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)").run(
      p.userId,
      p.slug,
      `I reached my limit of ${p.cap} card wakes an hour, so I did not look at card #${p.objectiveId} (or any card that changes before the hour is up). Ask me to "check my cards" and I will go through them now.`,
      JSON.stringify({ kind: 'card_wake_cap', objective_id: p.objectiveId, cap: p.cap }),
      sqlTime(now),
    )
    return true
  } catch (err) {
    console.warn(`[card-wakes] could not post the cap line for ${p.slug}:`, err instanceof Error ? err.message : String(err))
    return false
  }
}

// ── the bot's own actions (no wake for an event the bot caused itself) ──

/** Tools through which a bot changes a card. Each call is bracketed as a self action. */
export const SELF_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'my_card_set_status', 'my_card_message', 'card_take_over', 'card_reown', 'card_comment', 'card_restart', 'merge_approved_pr', 'raise_decision',
])
/** A merge the bot made itself is confirmed later by GitHub; that echo is the bot's own doing too. */
export const SELF_ECHO_MINUTES = 15
const OPEN_ACTION_MINUTES = 10

function headEventId(db: Database.Database): number {
  try {
    return (db.prepare('SELECT COALESCE(MAX(id), 0) AS head FROM objective_events').get() as { head: number }).head
  } catch {
    return 0
  }
}

/** Open a self action BEFORE the tool touches the card. Returns its id (0 = not recorded). */
export function beginSelfAction(db: Database.Database, p: { slug: string; objectiveId: number; tool: string }, now: Date = new Date()): number {
  try {
    const info = db
      .prepare('INSERT INTO bot_card_wake_self_actions (slug, objective_id, tool, from_event_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.slug.toLowerCase(), p.objectiveId, p.tool, headEventId(db), sqlTime(now))
    return Number(info.lastInsertRowid)
  } catch {
    return 0
  }
}

/** Close it AFTER: every objective_events row written in between was the bot's own doing. */
export function endSelfAction(db: Database.Database, id: number): void {
  if (!id) return
  try {
    db.prepare('UPDATE bot_card_wake_self_actions SET to_event_id = ? WHERE id = ?').run(headEventId(db), id)
  } catch { /* an open row lapses on its own */ }
}

/**
 * Did this bot cause this event on this card? True when the event id falls inside
 * one of the bot's recorded action ranges (an action still open counts for a few
 * minutes), or, for a completion (`completed` / `pr_merged`), when the bot merged
 * the card's PR itself in the last few minutes (GitHub confirms a merge later).
 */
export function isSelfCausedEvent(db: Database.Database, p: { slug: string; objectiveId: number; eventId: number | null; kind: string }, now: Date = new Date()): boolean {
  try {
    if (p.eventId != null) {
      const hit = db
        .prepare(
          `SELECT id FROM bot_card_wake_self_actions WHERE slug = ? AND objective_id = ? AND from_event_id < ?
             AND (to_event_id >= ? OR (to_event_id IS NULL AND created_at > ?)) LIMIT 1`,
        )
        .get(p.slug.toLowerCase(), p.objectiveId, p.eventId, p.eventId, sqlTime(new Date(now.getTime() - OPEN_ACTION_MINUTES * 60_000)))
      if (hit) return true
    }
    if (p.kind === 'completed' || p.kind === 'pr_merged') {
      const echo = db
        .prepare("SELECT id FROM bot_card_wake_self_actions WHERE slug = ? AND objective_id = ? AND tool = 'merge_approved_pr' AND created_at > ? LIMIT 1")
        .get(p.slug.toLowerCase(), p.objectiveId, sqlTime(new Date(now.getTime() - SELF_ECHO_MINUTES * 60_000)))
      if (echo) return true
    }
  } catch { /* no table → nothing recorded → not self-caused */ }
  return false
}

// ── the per-bot switch (no row = on) ──

export interface CardWakeSwitch {
  slug: string
  enabled: boolean
  /** True when nobody has set it: the default (on). */
  is_default: boolean
  updated_at: string | null
}

export function getCardWakeSwitch(slug: string, db: Database.Database = getDb()): CardWakeSwitch {
  let row: { enabled: number; updated_at: string } | undefined
  try {
    row = db.prepare('SELECT enabled, updated_at FROM agent_chat_card_wakes WHERE slug = ?').get(slug) as typeof row
  } catch {
    row = undefined
  }
  return { slug, enabled: row ? Number(row.enabled) > 0 : true, is_default: !row, updated_at: row?.updated_at ?? null }
}

export function setCardWakeSwitch(slug: string, enabled: boolean, userId: number | null, db: Database.Database = getDb()): CardWakeSwitch {
  db.prepare(
    `INSERT INTO agent_chat_card_wakes (slug, enabled, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(slug, enabled ? 1 : 0, userId)
  return getCardWakeSwitch(slug, db)
}

// ── routing ──

export interface CardWakeCard extends OwnedCard {
  workspace: string | null
  assigned_user_id?: number | null
  created_by?: number | null
}

export type CardWakeRefusal =
  | 'globally_off'
  | 'no_owner'
  | 'not_chat_bot'
  | 'switched_off'
  | 'no_workspace'
  | 'workspace_denied'
  | 'no_person'

export type CardWakeRoute =
  | { ok: true; slug: string; userId: number; workspace: string }
  | { ok: false; reason: CardWakeRefusal }

export interface RouteOptions {
  /** Installed chat bots. Default: the agent files on this install. */
  chatBots?: ChatBotRef[]
}

const lower = (v: unknown): string => String(v ?? '').trim().toLowerCase()

/**
 * The person the wake acts for: the card's assignee, else whoever filed it, else
 * the admin who switched the bot's High Agency on, else the first admin. Each
 * must share the card's workspace with the bot (person ∩ bot list, the same rule
 * every chat tool and bot-to-bot wake uses). null when nobody qualifies.
 */
function personFor(db: Database.Database, card: CardWakeCard, slug: string, workspace: string): number | null {
  const tried = new Set<number>()
  const candidates: Array<number | null | undefined> = [card.assigned_user_id, card.created_by]
  try {
    const ha = db.prepare('SELECT run_as_user_id FROM agent_chat_high_agency WHERE lower(slug) = ?').get(lower(slug)) as { run_as_user_id: number | null } | undefined
    candidates.push(ha?.run_as_user_id)
  } catch { /* no High Agency table */ }
  try {
    for (const r of db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id").all() as { id: number }[]) candidates.push(r.id)
  } catch { /* no users table */ }
  for (const c of candidates) {
    if (c == null || !Number.isInteger(Number(c)) || tried.has(Number(c))) continue
    tried.add(Number(c))
    try {
      if (botMessageWorkspaces(Number(c), slug).includes(workspace)) return Number(c)
    } catch { /* unreadable → next */ }
  }
  return null
}

/**
 * Does this card's needs_agent event become an in-product card wake, and for
 * whom? A refusal means "use the webhook path as before". Fails closed.
 */
export function resolveCardWakeRoute(card: CardWakeCard, db: Database.Database = getDb(), opts: RouteOptions = {}): CardWakeRoute {
  try {
    if (!cardWakesGloballyEnabled(db)) return { ok: false, reason: 'globally_off' }
    const chatBots = opts.chatBots ?? installedChatBots()
    const owner = cardOwnerBot(card, db, { chatBots })
    if (!owner) return { ok: false, reason: 'no_owner' }
    const installed = new Set(chatBots.map(b => lower(b.slug)))
    const slug = owner.slugs.find(s => installed.has(lower(s)))
    if (!slug) return { ok: false, reason: 'not_chat_bot' }
    const chatSlug = chatBots.find(b => lower(b.slug) === lower(slug))?.slug ?? slug
    if (!getCardWakeSwitch(chatSlug, db).enabled) return { ok: false, reason: 'switched_off' }
    const workspace = String(card.workspace ?? '').trim()
    if (!workspace) return { ok: false, reason: 'no_workspace' }
    if (!botMayUseWorkspace(chatSlug, workspace)) return { ok: false, reason: 'workspace_denied' }
    const userId = personFor(db, card, chatSlug, workspace)
    if (userId == null) return { ok: false, reason: 'no_person' }
    return { ok: true, slug: chatSlug, userId, workspace }
  } catch {
    return { ok: false, reason: 'no_owner' }
  }
}

// ── the outbox ──

export interface CardWakeInput {
  event_id: string
  slug: string
  objective_id: number
  workspace: string
  user_id: number
  /**
   * What the wake is about: the objective_events id for a card change, or the
   * decision id for a `decision_raised` / `decision_answered` wake.
   */
  source_event_id: number | null
  /** The objective_events id, when the wake came from one (the self-action check). */
  source_objective_event_id?: number | null
  /** The caller already knows the bot caused this itself (e.g. it raised the decision). */
  self_caused?: boolean
  need_kind: string
  need_why: string
}

export interface EnqueuedCardWake {
  id: number
  status: 'pending' | 'skipped'
  skip_reason: string | null
}

function sqlTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

type Listener = () => void
let onQueued: Listener | null = null
/** The drain registers here so a new wake is picked up at once, not on the next tick. */
export function onCardWakeQueued(fn: Listener | null): void {
  onQueued = fn
}

/**
 * Queue one wake, or record why it was suppressed. Returns null when the event
 * id was already queued (a replayed event is a silent no-op). Run inside the
 * enqueue transaction.
 */
export function enqueueCardWake(db: Database.Database, w: CardWakeInput, now: Date = new Date()): EnqueuedCardWake | null {
  const existing = db.prepare('SELECT id FROM bot_card_wakes WHERE event_id = ?').get(w.event_id)
  if (existing) return null

  let skip: string | null = null
  let capHit = 0
  const debounceMs = cardWakeDebounceSeconds(db) * 1000
  let runAt = new Date(now.getTime() + debounceMs)
  if (w.self_caused || isSelfCausedEvent(db, { slug: w.slug, objectiveId: w.objective_id, eventId: w.source_objective_event_id ?? null, kind: w.need_kind }, now)) {
    skip = `self_caused: ${w.slug} made this change itself, so it is not woken for it`
  }
  const live = skip
    ? undefined
    : (db
        .prepare("SELECT id FROM bot_card_wakes WHERE lower(slug) = lower(?) AND objective_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
        .get(w.slug, w.objective_id) as { id: number } | undefined)
  if (live) {
    skip = `coalesced: wake #${live.id} for this bot and card is still queued`
    // The live wake carries the newest need, so it acts on what the card needs now.
    db.prepare("UPDATE bot_card_wakes SET need_kind = ?, need_why = ?, source_event_id = COALESCE(?, source_event_id) WHERE id = ? AND status = 'pending'")
      .run(w.need_kind, w.need_why.slice(0, 1000), w.source_event_id, live.id)
  }
  const cap = cardWakeMaxPerHour(db)
  if (!skip && cap > 0) {
    const n = cardWakeTurnsLastHour(db, w.slug, now)
    if (n >= cap) {
      skip = `bot_hourly_cap: ${w.slug} already had ${n} card wakes in the last hour (cap ${cap})`
      capHit = cap
    }
  }
  const windowMin = cardWakeWindowMinutes(db)
  if (!skip && windowMin > 0) {
    // A turn for this card ran (or is running) inside the window: wait for the window
    // to end, then run. One turn per card per window, and nothing is lost.
    const recent = db
      .prepare(
        `SELECT id, COALESCE(started_at, finished_at) AS started_at FROM bot_card_wakes WHERE lower(slug) = lower(?) AND objective_id = ? AND status IN ('running', 'done', 'failed')
           AND COALESCE(started_at, finished_at) > ? ORDER BY COALESCE(started_at, finished_at) DESC LIMIT 1`,
      )
      .get(w.slug, w.objective_id, sqlTime(new Date(now.getTime() - windowMin * 60_000))) as { id: number; started_at: string } | undefined
    if (recent) {
      const windowEnd = new Date(Date.parse(`${recent.started_at.replace(' ', 'T')}Z`) + windowMin * 60_000)
      if (windowEnd.getTime() > runAt.getTime()) runAt = windowEnd
    }
  }

  const info = db
    .prepare(
      `INSERT INTO bot_card_wakes (event_id, slug, objective_id, workspace, user_id, source_event_id, need_kind, need_why, status, skip_reason, next_attempt_at, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      w.event_id, w.slug, w.objective_id, w.workspace, w.user_id, w.source_event_id, w.need_kind, w.need_why.slice(0, 1000),
      skip ? 'skipped' : 'pending', skip, skip ? null : sqlTime(runAt), sqlTime(now), skip ? sqlTime(now) : null,
    )
  if (capHit) postCardWakeCapLine(db, { slug: w.slug, userId: w.user_id, objectiveId: w.objective_id, cap: capHit }, now)
  if (!skip && debounceMs === 0 && onQueued) {
    const fn = onQueued
    setImmediate(() => { try { fn() } catch { /* the timer drains it anyway */ } })
  }
  return { id: Number(info.lastInsertRowid), status: skip ? 'skipped' : 'pending', skip_reason: skip }
}
