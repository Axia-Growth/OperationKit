/**
 * One-off follow-up wakes a chat bot sets for itself (obj 901392). Additive
 * CREATE TABLE only; no existing table is altered.
 *
 * `bot_followups` is both the schedule and the log: one row per
 * `schedule_followup` call. Status:
 *
 *   pending   → waiting for `due_at` (or, with when_card_changes, for the card to move)
 *   running   → claimed by the drain (lease_until), the bot's turn is in flight
 *   fired     → the turn ran; `reply_message_id` is the bot's answer in the chat
 *   failed    → the turn could not be run after the retries
 *   cancelled → the person pressed Cancel, or the bot called cancel_followup
 *   dropped   → the chat, the bot or its workspace access went away before it fired
 *
 * A follow-up belongs to ONE chat lane: (user_id, agent_slug, thread_id), with
 * thread_id NULL for the main conversation — the same key agent_chat_messages
 * uses. `hop` counts follow-ups in a row with no message from the person
 * (settings.bot_followups_max_hops). `note` is the bot's own text; the table is
 * in SCRUBBED_TABLES so a secret-shaped value never lands in it.
 */
import type Database from 'better-sqlite3'

export function initBotFollowupsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      agent_slug TEXT NOT NULL,
      thread_id INTEGER,
      workspace TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL,
      card_id INTEGER,
      when_card_changes INTEGER NOT NULL DEFAULT 0,
      card_fingerprint TEXT,
      due_at TEXT NOT NULL,
      hop INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'fired', 'failed', 'cancelled', 'dropped')),
      fire_reason TEXT,
      end_reason TEXT,
      cancelled_by TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_until TEXT,
      last_error TEXT,
      reply_message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      fired_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bot_followups_due ON bot_followups(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_bot_followups_lane ON bot_followups(user_id, agent_slug, status);
  `)
  try {
    // Finished rows are the log; 90 days is plenty. A pending row is never pruned.
    db.prepare("DELETE FROM bot_followups WHERE status NOT IN ('pending', 'running') AND created_at < datetime('now', '-90 days')").run()
  } catch (err) {
    console.error('[bot-followups] prune failed:', (err as Error).message)
  }
}
