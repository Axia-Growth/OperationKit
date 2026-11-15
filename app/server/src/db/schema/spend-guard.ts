/**
 * Spend guard state (obj 900909, systems audit #10).
 *
 * One row per card the guard has looked at. Additive: a new table, nothing in
 * `objective_job_accounting` is touched, so an explicit ceiling somebody already
 * set keeps its value and its source.
 *
 * The row holds:
 *  - the latest measurement the card UI shows (ceiling, spend, burn rate,
 *    projection), so the panel never re-parses transcripts on a page load;
 *  - the stage of the warn → degrade → park chain, so a server restart does not
 *    re-warn or skip a step;
 *  - the effort and model the card had before the guard degraded it, so the
 *    per-effort default ceiling is still read from the ORIGINAL effort (dropping
 *    `ultracode` to `high` must not also halve the card's budget);
 *  - the last spawn/respawn refusal reason, so the card can say why it did not start.
 */
import type Database from 'better-sqlite3'

export function initSpendGuardSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_spend_guard (
      objective_id         INTEGER PRIMARY KEY,
      stage                TEXT    NOT NULL DEFAULT 'none',
      stage_at             TEXT,
      warned_at            TEXT,
      degraded_at          TEXT,
      parked_at            TEXT,
      ceiling_usd          REAL,
      ceiling_source       TEXT,
      spent_usd            REAL    NOT NULL DEFAULT 0,
      burn_usd_per_min     REAL,
      projected_usd        REAL,
      horizon_minutes      REAL,
      measured_at          TEXT,
      original_effort      TEXT,
      original_model       TEXT,
      degrade_allowed      INTEGER,
      last_action          TEXT,
      last_action_at       TEXT,
      last_refusal         TEXT,
      last_refusal_at      TEXT,
      created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `)
}
