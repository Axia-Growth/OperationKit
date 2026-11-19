/**
 * Delegated approvals (obj 900839): owner-issued, scoped "approve on my behalf"
 * grants for bots, and the audit trail of every use. Additive CREATE TABLEs
 * only — nothing here alters an existing table, and with no rows the approval
 * gate behaves exactly as before (default deny).
 *
 * A grant is immutable once written except for revocation: there is no column
 * a later request can bump to extend it. To change one, revoke it and issue a
 * new one — which only the owner, signed in to the web UI, can do.
 */
import type Database from 'better-sqlite3'

export function initDelegationGrantsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegation_grants (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      -- The owner the bot approves on behalf of.
      granting_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- Canonical bot-registry id (services/bots/bot-registry.ts). Matched against
      -- the bot a message declares itself to be.
      bot_name             TEXT NOT NULL,
      -- The chat bot page the grant was issued from (display only).
      agent_slug           TEXT,
      workspace            TEXT NOT NULL,
      allow_merge          INTEGER NOT NULL DEFAULT 0 CHECK (allow_merge IN (0, 1)),
      allow_prod_migration INTEGER NOT NULL DEFAULT 0 CHECK (allow_prod_migration IN (0, 1)),
      allow_deploy         INTEGER NOT NULL DEFAULT 0 CHECK (allow_deploy IN (0, 1)),
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      -- Required. UTC, SQLite datetime format, compared against datetime('now').
      expires_at           TEXT NOT NULL,
      revoked_at           TEXT,
      revoked_by           TEXT,
      created_by           TEXT NOT NULL,
      CHECK (allow_merge + allow_prod_migration + allow_deploy > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_grants_lookup ON delegation_grants(bot_name, workspace);

    -- Server audit log: grant lifecycle and every delegated approval, allowed or
    -- refused. Append-only; never updated.
    CREATE TABLE IF NOT EXISTS delegation_audit (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event            TEXT NOT NULL CHECK (event IN ('grant_created', 'grant_revoked', 'approval_used', 'approval_denied')),
      grant_id         INTEGER,
      objective_id     INTEGER,
      workspace        TEXT,
      bot_name         TEXT,
      action           TEXT,
      actor            TEXT,
      agent_key_id     INTEGER,
      agent_key_label  TEXT,
      reason           TEXT,
      message_excerpt  TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_grant ON delegation_audit(grant_id);
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_objective ON delegation_audit(objective_id);
  `)

  // obj 901388: "Merge without asking me each time" — a standing merge, opt-in
  // per grant. Additive, default 0, so every grant that exists today stays off
  // and nothing merges on its own until the owner issues a grant with it ticked.
  // Like the rest of a grant it is set once, at creation; there is no update path.
  const cols = new Set((db.prepare('PRAGMA table_info(delegation_grants)').all() as { name: string }[]).map(c => c.name))
  if (!cols.has('standing_merge')) {
    db.exec('ALTER TABLE delegation_grants ADD COLUMN standing_merge INTEGER NOT NULL DEFAULT 0 CHECK (standing_merge IN (0, 1))')
  }
}
