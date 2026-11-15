// ── "Needs you" posts: the only bot activity that reaches the main chat (obj 900947) ──
//
// THE ROUTING RULE (shared/bot-work.ts chatRouteFor). High Agency activity —
// a wake starting, a wake's report, a card it filed finishing, a PR — goes to
// the bot's Activity feed (read straight off the board by bot-work.ts). The
// bot's MAIN chat only gets a message when the bot needs the person, and only
// for one of four reasons:
//
//   approval_beyond_grant  the bot asked to approve a merge / prod migration /
//                          deploy its delegation grant does not cover
//   over_ceiling           a card is at or over its spend ceiling
//   decision               a card is parked for a decision (Needs You, or a
//                          job disposition of needs_review)
//   blocker                a card is blocked, waiting on a secret, or stalled
//
// WHAT THE MESSAGE CAN DO. It carries Approve and Reply buttons in the UI.
// Both call EXISTING routes with their existing gates — Reply and Approve
// post to the card through POST /api/objectives/:id/message (a signed-in
// person's message, stamped by the server from the cookie), and Approve on an
// over-ceiling card raises the ceiling through PUT /api/objectives/:id/spend
// (cookie-only, card owner or admin). This module adds no approval path of its
// own and nothing here approves anything on a bot's say-so: it only writes the
// chat message.
//
// WHO GETS IT. The person the bot's High Agency runs as (the admin who switched
// it on), and only when the bot is granted the card's workspace and that person
// can see the CARD — the board list's rule (bot-work.ts botViewScope): an admin
// sees every card; a member sees a workspace's cards only with 'all'
// visibility there, else just the cards they are assigned to or created.
//
// DEDUPE. One message per (card, reason) while the reason holds
// (bot_attention_posts). When it clears the row is dropped, so a recurrence is
// a new message. The first run anchors silently — switching this on never
// floods anyone's chat with history; the Work tab already lists those cards.
import type { Database } from 'better-sqlite3'
import {
  BOT_NEEDS_YOU_KIND,
  chatRouteFor,
  NEEDS_YOU_LABELS,
  type BotNeedsYouMeta,
  type NeedsYouReason,
} from '@operationkit/shared'
import { notifyBotMessage } from './sidebar-live.js'
import { ownedCardsWithSignals, type BotRef } from './bot-work.js'

export const ATTENTION_SEEDED_SETTING = 'bot_attention_seeded_at'

function setting(db: Database, key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return r?.value ?? null
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

const ACTION_LABEL: Record<string, string> = { merge: 'merge', prod_migration: 'prod migration', deploy: 'deploy' }

/** The message text. Final values only — never the worker's scratch. */
export function attentionText(bot: string, meta: BotNeedsYouMeta): string {
  const card = `card #${meta.objective_id} "${meta.title}"`
  switch (meta.reason) {
    case 'approval_beyond_grant':
      return `${bot} needs your approval: it asked to approve a ${ACTION_LABEL[meta.action ?? ''] ?? 'gated action'} on ${card}, and its grant does not cover that. Approve sends your approval to the card as you; Reply asks a question instead.`
    case 'over_ceiling':
      return `${bot} needs you: ${card} has spent ${usd(meta.spent_usd ?? 0)} against its ${usd(meta.ceiling_usd ?? 0)} ceiling and cannot start again until the ceiling is raised.`
    case 'decision':
      return `${bot} needs a decision from you on ${card}.`
    case 'blocker':
      return `${bot} is blocked on ${card} and needs you to unblock it.`
  }
}

interface HaRow {
  slug: string
  run_as_user_id: number | null
}

function recipientFor(db: Database, s: HaRow): { id: number; admin: boolean } | null {
  if (s.run_as_user_id != null) {
    const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(s.run_as_user_id) as { id: number; role: string } | undefined
    if (u) return { id: u.id, admin: u.role === 'admin' }
  }
  const a = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as { id: number } | undefined
  return a ? { id: a.id, admin: true } : null
}

export interface AttentionTickResult {
  posted: number
  cleared: number
  seeded: boolean
}

/**
 * One pass: for every bot with High Agency, find its open High Agency cards
 * (wakes + cards its wakes filed) that need the person, post one main-chat
 * message per new (card, reason), and forget reasons that cleared.
 *
 * `bots` maps slug → display name (the chat agent list); a High Agency row for
 * a bot that is no longer installed is skipped.
 */
export function runBotAttentionTick(db: Database, bots: BotRef[]): AttentionTickResult {
  const seeded = setting(db, ATTENTION_SEEDED_SETTING) !== null
  let rows: HaRow[] = []
  try {
    rows = db.prepare('SELECT slug, run_as_user_id FROM agent_chat_high_agency WHERE enabled = 1 OR routine_id IS NOT NULL').all() as HaRow[]
  } catch {
    return { posted: 0, cleared: 0, seeded }
  }
  const byName = new Map(bots.map(b => [b.slug, b]))
  const insertPost = db.prepare(
    'INSERT OR IGNORE INTO bot_attention_posts (objective_id, reason, agent_slug, user_id) VALUES (?, ?, ?, ?)',
  )
  const setMessage = db.prepare('UPDATE bot_attention_posts SET message_id = ? WHERE objective_id = ? AND reason = ?')
  const insertMessage = db.prepare(
    "INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, meta) VALUES (?, ?, 'assistant', ?, ?)",
  )
  let posted = 0
  let cleared = 0
  const live = new Set<string>()
  const touched = new Set<string>()

  for (const s of rows) {
    const bot = byName.get(s.slug)
    if (!bot) continue
    touched.add(s.slug)
    const who = recipientFor(db, s)
    if (!who) continue
    // The recipient's own board visibility bounds what is announced to them: a
    // member who runs the bot is only told about cards they could open.
    const { rows: cards, signals, wakes } = ownedCardsWithSignals(db, bot, { id: who.id, role: who.admin ? 'admin' : 'member' })
    const wakeIds = new Set(cards.filter(c => c.routine_id != null && wakes.includes(c.routine_id)).map(c => c.id))
    // High Agency activity only: the wakes and the cards they filed. A card a
    // person asked for in chat already reports back to that conversation
    // (bot-thread-delivery.ts) and is not this module's to re-announce.
    const haCards = cards.filter(c => wakeIds.has(c.id) || (c.source_job_id != null && wakeIds.has(c.source_job_id)) || (c.parent_id != null && wakeIds.has(c.parent_id)))
    for (const c of haCards) {
      const sig = signals.get(c.id)
      if (!sig) continue
      for (const reason of sig.needs_you) {
        if (chatRouteFor(reason) !== 'main_chat') continue
        live.add(`${c.id}:${reason}`)
        const fresh = insertPost.run(c.id, reason, s.slug, who.id).changes > 0
        if (!fresh || !seeded) continue
        const meta: BotNeedsYouMeta = {
          kind: BOT_NEEDS_YOU_KIND,
          objective_id: c.id,
          reason: reason as NeedsYouReason,
          title: c.title,
          ...(reason === 'over_ceiling' ? { spent_usd: sig.spent_usd, ceiling_usd: sig.ceiling_usd ?? 0 } : {}),
          ...(reason === 'approval_beyond_grant' ? { action: sig.denied_action } : {}),
        }
        const info = insertMessage.run(who.id, s.slug, attentionText(bot.name, meta), JSON.stringify({ ...meta, label: NEEDS_YOU_LABELS[meta.reason] }))
        setMessage.run(Number(info.lastInsertRowid), c.id, reason)
        notifyBotMessage(who.id, s.slug)
        posted++
      }
    }
  }

  // Forget reasons that cleared — only for bots we looked at this pass.
  if (touched.size) {
    const existing = db
      .prepare(`SELECT objective_id, reason, agent_slug FROM bot_attention_posts WHERE agent_slug IN (${[...touched].map(() => '?').join(', ')})`)
      .all(...touched) as { objective_id: number; reason: string; agent_slug: string }[]
    const del = db.prepare('DELETE FROM bot_attention_posts WHERE objective_id = ? AND reason = ?')
    for (const e of existing) {
      if (live.has(`${e.objective_id}:${e.reason}`)) continue
      cleared += del.run(e.objective_id, e.reason).changes
    }
  }
  if (!seeded) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, datetime('now')) ON CONFLICT(key) DO NOTHING").run(ATTENTION_SEEDED_SETTING)
  }
  return { posted, cleared, seeded }
}

/**
 * Chat history written before this change is never rewritten or deleted. When
 * it is read, a message about High Agency activity that is NOT a needs-you post
 * is marked `meta.activity_feed = true` so the UI collapses it ("now in
 * Activity"). `haCardIds` = the High Agency cards those messages point at.
 */
export function markFeedMessage(
  meta: Record<string, unknown> | null | undefined,
  content: string,
  isHaCard: (id: number) => boolean,
): boolean {
  if (meta?.kind === BOT_NEEDS_YOU_KIND) return false
  if (typeof meta?.kind === 'string' && meta.kind.startsWith('high_agency')) return true
  const card = Number(meta?.bot_job ?? NaN)
  if (Number.isInteger(card) && card > 0 && isHaCard(card)) return true
  return /^High Agency wake\b/.test(content.trim())
}

/** The poller runs every few seconds; a needs-you pass once a minute is plenty. */
export const ATTENTION_INTERVAL_MS = 60_000
let lastAttentionRun = 0

/** Throttled entry point for the poller. `bots` is read lazily (only when the pass runs). */
export function maybeRunBotAttentionTick(db: Database, bots: () => BotRef[], nowMs = Date.now()): AttentionTickResult | null {
  if (nowMs - lastAttentionRun < ATTENTION_INTERVAL_MS) return null
  lastAttentionRun = nowMs
  return runBotAttentionTick(db, bots())
}
