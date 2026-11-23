import type Database from 'better-sqlite3'

/**
 * Per-bot secret access (obj 901484). Three tables. A grant row = ONE chat bot may send ONE named
 * secret to the listed exact hosts with the listed methods, in ONE workspace.
 *
 * Additive only: three new tables, nothing altered. It never holds a value, and it
 * never touches a `secrets` row or the workspace-wide `secrets_broker_policy`
 * setting (Settings → Secrets → Bot access), which keeps working unchanged.
 * Read and written only by services/agent-chat/bot-secret-access.ts.
 */
export function initBotSecretAccessSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_chat_bot_secret_grants (
      slug TEXT NOT NULL COLLATE NOCASE,
      workspace TEXT NOT NULL,
      secret_name TEXT NOT NULL,
      hosts TEXT NOT NULL,
      methods TEXT NOT NULL,
      granted_by INTEGER,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (slug, workspace, secret_name)
    );
    -- "All secrets" switch: ONE bot may use every Workspace-scope secret of ONE
    -- workspace (also ones added later). mode = 'read' (GET, HEAD) or 'write'.
    CREATE TABLE IF NOT EXISTS agent_chat_bot_secret_all (
      slug TEXT NOT NULL COLLATE NOCASE,
      workspace TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'read',
      granted_by INTEGER,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (slug, workspace)
    );
    -- The host(s) an admin confirmed for one secret in one workspace, once per
    -- key (not per bot). Read ONLY for bots with the All secrets switch; it
    -- gives nothing to any other bot.
    CREATE TABLE IF NOT EXISTS agent_chat_secret_hosts (
      workspace TEXT NOT NULL,
      secret_name TEXT NOT NULL,
      hosts TEXT NOT NULL,
      confirmed_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace, secret_name)
    );
  `)
}
