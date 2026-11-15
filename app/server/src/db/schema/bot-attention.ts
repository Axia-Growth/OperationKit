/**
 * Bot "needs you" chat posts (obj 900947).
 *
 * One row per (card, reason) a bot has told a person about in its main chat.
 * The PRIMARY KEY is the dedupe: a card that stays over its ceiling for a week
 * produces ONE message, not one per poller tick. When the reason clears the row
 * is deleted, so the same card going over its (raised) ceiling again is a new
 * occurrence and posts again.
 *
 * Additive: a new table only. The chat history itself stays in
 * agent_chat_messages; this table never holds the message text.
 */
import type Database from 'better-sqlite3'

export function initBotAttentionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_attention_posts (
      objective_id INTEGER NOT NULL,
      reason       TEXT    NOT NULL CHECK (reason IN ('approval_beyond_grant', 'over_ceiling', 'decision', 'blocker')),
      agent_slug   TEXT    NOT NULL,
      user_id      INTEGER,
      message_id   INTEGER,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (objective_id, reason)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_attention_posts_slug ON bot_attention_posts(agent_slug);
  `)
}
