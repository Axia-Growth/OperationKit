/**
 * Production issue intake (obj 901771). Additive CREATE TABLE only.
 *
 * Turns a signal from a client's PRODUCTION app (a monitor alert, an error
 * report, a pasted log) into a bug card on the board. This heals the client's
 * app, not the board: the board's own self-healing (stall watchdog, session
 * retry, High Agency) is unrelated.
 *
 *   production_intake_sources — one row per webhook an admin created. The
 *     token is stored as a sha256 hash only (shown once at creation), and the
 *     row pins the workspace and project every card from it lands in, so a
 *     token holder can never pick another workspace.
 *   production_signals — one row per signal received, whatever happened to it
 *     (filed a card, added to an open card, ignored as a recovery, rate
 *     limited, refused while the switch is off). `evidence_json` is the
 *     normalised evidence the card shows; `raw_json` is the body as received
 *     (capped). Both are secret-scrubbed on write (SCRUBBED_TABLES).
 *
 * Nothing here merges or deploys anything: the card a signal files is
 * `origin = 'production-issue'`, and every bot / background merge path refuses
 * that origin (services/production-intake.ts → isProductionIssueCard).
 */
import type Database from 'better-sqlite3'

export function initProductionIntakeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS production_intake_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      name TEXT NOT NULL,
      project TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      auto_start INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_production_intake_sources_ws ON production_intake_sources(workspace);

    CREATE TABLE IF NOT EXISTS production_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER,
      workspace TEXT NOT NULL,
      project TEXT,
      via TEXT NOT NULL CHECK (via IN ('webhook', 'pasted')),
      vendor TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      environment TEXT,
      service TEXT,
      url TEXT,
      occurred_at TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      outcome TEXT NOT NULL CHECK (outcome IN ('filed', 'appended', 'ignored', 'rate_limited', 'disabled', 'failed')),
      outcome_reason TEXT,
      objective_id INTEGER,
      reported_by INTEGER,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_production_signals_ws ON production_signals(workspace, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_production_signals_objective ON production_signals(objective_id);
    CREATE INDEX IF NOT EXISTS idx_production_signals_source ON production_signals(source_id, received_at DESC);
  `)
}
