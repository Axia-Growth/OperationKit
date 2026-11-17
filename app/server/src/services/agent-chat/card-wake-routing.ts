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
// Burst control, at enqueue (`enqueueCardWake`), per bot + card:
//   - a wake still pending or running absorbs the new one (coalesced);
//   - a wake started within the window (default 10 min) suppresses it (rate_limited);
//   - and per bot, at most N wakes an hour across all its cards (bot_hourly_cap).
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
export const DEFAULT_CARD_WAKE_WINDOW_MINUTES = 10
export const DEFAULT_CARD_WAKE_MAX_PER_HOUR = 12
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
  source_event_id: number | null
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
  const live = db
    .prepare("SELECT id FROM bot_card_wakes WHERE lower(slug) = lower(?) AND objective_id = ? AND status IN ('pending', 'running') ORDER BY id DESC LIMIT 1")
    .get(w.slug, w.objective_id) as { id: number } | undefined
  if (live) {
    skip = `coalesced: wake #${live.id} for this bot and card is still queued or running`
    // The live wake carries the newest need, so it acts on what the card needs now.
    db.prepare("UPDATE bot_card_wakes SET need_kind = ?, need_why = ? WHERE id = ? AND status = 'pending'").run(w.need_kind, w.need_why.slice(0, 1000), live.id)
  }
  const windowMin = cardWakeWindowMinutes(db)
  if (!skip && windowMin > 0) {
    const recent = db
      .prepare(
        `SELECT id FROM bot_card_wakes WHERE lower(slug) = lower(?) AND objective_id = ? AND status IN ('pending', 'running', 'done', 'failed')
           AND created_at > ? ORDER BY id DESC LIMIT 1`,
      )
      .get(w.slug, w.objective_id, sqlTime(new Date(now.getTime() - windowMin * 60_000))) as { id: number } | undefined
    if (recent) skip = `rate_limited: wake #${recent.id} for this bot and card ran less than ${windowMin} min ago`
  }
  const cap = cardWakeMaxPerHour(db)
  if (!skip && cap > 0) {
    const n = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM bot_card_wakes WHERE lower(slug) = lower(?) AND status IN ('pending', 'running', 'done', 'failed') AND created_at > ?`,
      )
      .get(w.slug, sqlTime(new Date(now.getTime() - 3600_000))) as { n: number }).n
    if (n >= cap) skip = `bot_hourly_cap: ${w.slug} already had ${n} card wakes in the last hour (cap ${cap})`
  }

  const info = db
    .prepare(
      `INSERT INTO bot_card_wakes (event_id, slug, objective_id, workspace, user_id, source_event_id, need_kind, need_why, status, skip_reason, next_attempt_at, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      w.event_id, w.slug, w.objective_id, w.workspace, w.user_id, w.source_event_id, w.need_kind, w.need_why.slice(0, 1000),
      skip ? 'skipped' : 'pending', skip, skip ? null : sqlTime(now), sqlTime(now), skip ? sqlTime(now) : null,
    )
  if (!skip && onQueued) {
    const fn = onQueued
    setImmediate(() => { try { fn() } catch { /* the timer drains it anyway */ } })
  }
  return { id: Number(info.lastInsertRowid), status: skip ? 'skipped' : 'pending', skip_reason: skip }
}
