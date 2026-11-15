/**
 * Needs You bulk triage audit (obj 900869). One `board_triage_batches` row per
 * bulk action a person confirms, one `board_triage_items` row per card it
 * touched (with the outcome). Additive CREATE TABLEs only; append-only by
 * convention — nothing in the code updates or deletes a row after the batch
 * finishes.
 *
 * The per-card status moves ALSO write the ordinary `objective_audit` row
 * (pathway `bulk-triage:<batch id>`), so the card's own history shows the move
 * without a join.
 */
import type Database from 'better-sqlite3'

export function initBoardTriageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_triage_batches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL CHECK (action IN ('approve', 'dismiss', 'reassign')),
      actor_user_id INTEGER,
      actor       TEXT NOT NULL,
      requested   INTEGER NOT NULL DEFAULT 0,
      ok          INTEGER NOT NULL DEFAULT 0,
      skipped     INTEGER NOT NULL DEFAULT 0,
      failed      INTEGER NOT NULL DEFAULT 0,
      -- The reassign target etc., as JSON. Never holds a secret: ids and a bot name.
      params_json TEXT,
      note        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_board_triage_batches_created ON board_triage_batches(created_at);

    CREATE TABLE IF NOT EXISTS board_triage_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id     INTEGER NOT NULL REFERENCES board_triage_batches(id) ON DELETE CASCADE,
      objective_id INTEGER NOT NULL,
      title_snapshot TEXT,
      workspace    TEXT,
      result       TEXT NOT NULL CHECK (result IN ('ok', 'skipped', 'failed')),
      from_status  TEXT,
      to_status    TEXT,
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_board_triage_items_batch ON board_triage_items(batch_id);
    CREATE INDEX IF NOT EXISTS idx_board_triage_items_objective ON board_triage_items(objective_id);
  `)
}
