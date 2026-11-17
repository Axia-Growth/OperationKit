/**
 * needs_agent card wakes for Operation Kit chat bots (obj 901328). Additive
 * CREATE TABLEs only.
 *
 * `bot_card_wakes` is the outbox: one row per needs_agent event the enqueue tick
 * (services/agent-webhooks.ts) routed to an in-product chat bot instead of a
 * webhook. Status: pending → running → done | failed, or `skipped` straight
 * away when the dedupe / rate limit swallowed it (the row stays so the reason
 * is visible). `event_id` is UNIQUE, so the same event can never queue twice.
 *
 * `agent_chat_card_wakes` is the per-bot switch. NO ROW = ON: the feature needs
 * no setup. A row with enabled = 0 turns the bot's card wakes off; its
 * needs_agent events then go to the webhook path exactly as before.
 */
import type Database from 'better-sqlite3'

export function initBotCardWakesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_card_wakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL,
      objective_id INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      source_event_id INTEGER,
      need_kind TEXT NOT NULL,
      need_why TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
      skip_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_until TEXT,
      last_error TEXT,
      thread_id INTEGER,
      reply_message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bot_card_wakes_due ON bot_card_wakes(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_bot_card_wakes_pair ON bot_card_wakes(slug, objective_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_chat_card_wakes (
      slug TEXT PRIMARY KEY COLLATE NOCASE,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  try {
    db.prepare("DELETE FROM bot_card_wakes WHERE created_at < datetime('now', '-30 days')").run()
  } catch (err) {
    console.error('[card-wakes] prune failed:', (err as Error).message)
  }
}
