/**
 * "Deploy on your word" audit (obj 901393). Additive CREATE TABLE only.
 *
 * One row per call of the chat deploy tool (services/chat-deploy.ts), allowed or
 * refused: who said so, in which chat thread and message, which bot, the commit
 * range, the pull requests it carried, the mode and the outcome.
 *
 * outcome:
 *   refused     — nothing was deployed; `reason` is the refusal code
 *   started     — self-deploy.sh is running (detached); the reconciler settles it
 *   deployed    — live: the checkout reached `to_commit` and the deploy passed
 *   rolled_back — the health gate failed and self-deploy.sh rolled back
 *   failed      — anything else (main moved, script error, no result)
 * `reported_at` is set once the outcome line was posted back into the chat thread.
 */
import type Database from 'better-sqlite3'

export function initChatDeploysSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      agent_slug TEXT NOT NULL,
      bot_name TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL DEFAULT '',
      thread_id INTEGER,
      message_id INTEGER,
      from_commit TEXT,
      to_commit TEXT,
      prs_json TEXT NOT NULL DEFAULT '[]',
      mode TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('refused', 'started', 'deployed', 'rolled_back', 'failed')),
      reason TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      reported_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_deploys_created ON chat_deploys(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_deploys_outcome ON chat_deploys(outcome);
    CREATE INDEX IF NOT EXISTS idx_chat_deploys_message ON chat_deploys(message_id);
  `)
}
