/**
 * Bot-to-bot messaging (obj 900859). Additive CREATE TABLEs only.
 *
 * A BOT CONVERSATION is a durable thread between exactly two bots inside ONE
 * workspace. Every entry on it is a row in `bot_messages`:
 *
 *   kind 'message' — a bot sent this to the other bot (message_bot). It is the
 *                    only kind that is DELIVERED: an outbox row (status
 *                    pending → delivering → delivered | failed) that wakes the
 *                    recipient.
 *   kind 'reply'   — the recipient's final answer to one 'message' (in_reply_to).
 *                    Never delivered as a wake, so one message costs exactly one
 *                    wake and two bots cannot ping-pong on their own.
 *   kind 'tool'    — one line per tool the recipient used while answering.
 *   kind 'error' / 'notice' — a failed wake, a refused delivery, a retry note.
 *
 * `workspace` is stored on the conversation AND on every message, so every read
 * is ONE `workspace IN (...)` predicate over the row being returned — there is no
 * join through which a row of another workspace could ride along.
 *
 * `sent_by_user_id` is the person whose chat (or whose bot's wake) sent the
 * message: the recipient's wake acts for that person, under the same
 * (person ∩ bot) workspace rule every chat tool uses. `origin_*` is the chat
 * lane the message came from, so the reply can be posted back where the person
 * is reading (NULL for a message sent from inside another wake).
 */
import type Database from 'better-sqlite3'

export function initBotMessagesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      initiator_slug TEXT NOT NULL,
      recipient_slug TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      started_by_user_id INTEGER,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bot_conversations_ws ON bot_conversations(workspace, last_message_at);
    CREATE INDEX IF NOT EXISTS idx_bot_conversations_initiator ON bot_conversations(initiator_slug, workspace);
    CREATE INDEX IF NOT EXISTS idx_bot_conversations_recipient ON bot_conversations(recipient_slug, workspace);

    CREATE TABLE IF NOT EXISTS bot_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES bot_conversations(id) ON DELETE CASCADE,
      workspace TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('message', 'reply', 'tool', 'error', 'notice')),
      from_slug TEXT NOT NULL,
      to_slug TEXT,
      body TEXT NOT NULL DEFAULT '',
      tool_name TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      in_reply_to INTEGER,
      sent_by_user_id INTEGER,
      origin_user_id INTEGER,
      origin_agent_slug TEXT,
      origin_thread_id INTEGER,
      status TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'none')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_until TEXT,
      last_error TEXT,
      provider TEXT,
      model TEXT,
      meta TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bot_messages_conversation ON bot_messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_bot_messages_outbox ON bot_messages(status, next_attempt_at);
  `)
}
