/**
 * Long chat turns run as a background job (obj 901491).
 *
 * `agent_chat_turn_jobs` is one row per chat turn that ran under the long-turn
 * budget: who asked, which bot, which lane, the budget it ran under, how far it
 * got and how it ended. It is the turn-level audit record (each tool action is
 * still its own chat row and its own tool audit row, unchanged), it is what
 * the composer reads to say "step 12 of 60", and it is how a server restart
 * finds the turns it cut off so none of them ends without a word.
 *
 * `agent_chat_turn_limits` is the admin's per-bot budget. NO ROW = the install
 * default (settings `agent_chat_turn_max_steps` / `agent_chat_turn_max_minutes`,
 * else 60 steps / 30 minutes). It lives in its own table, like the bot's other
 * switches, so "Reset to file" on the bot page never changes it.
 *
 * Additive CREATE TABLEs only; nothing here alters an existing table.
 */
import type Database from 'better-sqlite3'

export function initChatTurnJobsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_chat_turn_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      agent_slug TEXT NOT NULL,
      thread_id INTEGER,
      -- running | answered | limit | stopped | failed | interrupted
      status TEXT NOT NULL DEFAULT 'running',
      -- 1 once the HTTP request that started the turn was answered "working on it"
      background INTEGER NOT NULL DEFAULT 0,
      -- 1 when the turn was started by a message typed in a signed-in browser
      browser_session INTEGER NOT NULL DEFAULT 0,
      max_steps INTEGER NOT NULL,
      max_seconds INTEGER NOT NULL,
      steps INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      -- steps | time, when status = 'limit'
      limit_reason TEXT,
      -- first chat row of the turn, so a report can list what the turn did
      first_message_id INTEGER,
      note TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      detached_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_chat_turn_jobs_lane ON agent_chat_turn_jobs(user_id, agent_slug, status);

    CREATE TABLE IF NOT EXISTS agent_chat_turn_limits (
      slug TEXT PRIMARY KEY COLLATE NOCASE,
      max_steps INTEGER,
      max_minutes INTEGER,
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}
