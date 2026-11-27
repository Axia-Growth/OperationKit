/**
 * Outcome-first intake (obj 901764). Additive CREATE TABLE only; no existing
 * table is altered.
 *
 * `outcome_proposals` — one row per `propose_outcome` chat tool call: the
 * breakdown a bot proposed for an outcome the person stated. Nothing is filed
 * while it is `pending`. Status:
 *
 *   pending    → waiting for the person (they can edit it)
 *   approving  → the person pressed Approve; the cards are being filed (a claim,
 *                so a double click never files twice)
 *   approved   → filed; `card_id` is the outcome card, `child_ids` its children
 *   discarded  → the person threw it away
 *
 * It belongs to ONE chat lane (user_id, agent_slug, thread_id) — the person who
 * was chatting is the only one who may approve it.
 *
 * `outcome_rules` — standing outcome rules per workspace ("before-and-after
 * screenshots on every PR"). Saved only from the person's own approve click,
 * never by a bot on its own. Removal is a soft delete (`deleted_at`) so a card
 * that froze a rule into its criteria can still say where it came from.
 *
 * Both tables hold free text a bot or person typed, so they are in
 * SCRUBBED_TABLES (a secret-shaped value never lands in them).
 */
import type Database from 'better-sqlite3'

export function initOutcomeIntakeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcome_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      agent_slug TEXT NOT NULL,
      thread_id INTEGER,
      workspace TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approving', 'approved', 'discarded')),
      card_id INTEGER,
      child_ids TEXT,
      start_note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outcome_proposals_lane ON outcome_proposals(user_id, agent_slug, status);

    CREATE TABLE IF NOT EXISTS outcome_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      text TEXT NOT NULL,
      applies_to TEXT NOT NULL DEFAULT 'pr' CHECK (applies_to IN ('pr', 'all')),
      created_by INTEGER,
      source_proposal_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      deleted_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outcome_rules_ws ON outcome_rules(workspace, deleted_at);
  `)
}
