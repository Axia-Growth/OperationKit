/**
 * Knowledge-gap flags (obj 901767).
 *
 * A worker, a chat bot, an outside agent or a person reports a defect in the
 * knowledge base while they work: something MISSING, something WRONG, or
 * something STALE, optionally with a suggested fix and a link to the card or
 * trace it came from. A flag is a queue row, never a wiki edit: nothing here
 * changes a page. The Cleanup tab lists open flags beside the lint report, and
 * a later curator run reads them from `GET /api/kb-wiki/flags`.
 *
 * Additive: one new table. Nothing here changes an existing table.
 */
import type Database from 'better-sqlite3'

export function initKbFlagsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_flags (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace       TEXT    NOT NULL,
      kind            TEXT    NOT NULL CHECK (kind IN ('missing', 'wrong', 'stale')),
      subject         TEXT    NOT NULL,
      page            TEXT,
      detail          TEXT    NOT NULL,
      suggested_fix   TEXT,
      objective_id    INTEGER,
      trace           TEXT,
      source          TEXT    NOT NULL CHECK (source IN ('worker', 'reviewer', 'bot', 'agent', 'person')),
      filed_by        TEXT    NOT NULL DEFAULT '',
      status          TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
      dedupe_key      TEXT    NOT NULL,
      seen_count      INTEGER NOT NULL DEFAULT 1,
      last_seen_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      resolution_note TEXT,
      resolved_by     TEXT,
      resolved_at     TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kb_flags_workspace ON kb_flags(workspace, status, id);
    CREATE INDEX IF NOT EXISTS idx_kb_flags_dedupe ON kb_flags(workspace, dedupe_key, status);
  `)
}
