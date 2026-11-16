/**
 * Decision briefings + their Q&A threads (obj 901059).
 *
 * `decisions` is the queryable learning log: every decision a bot or worker
 * raised, with its briefing (context / question / options with pros and cons /
 * recommendation), the choice the person made, and what that choice actually
 * did to the card (`outcome` + the one-line `outcome_text` they were shown).
 *
 * `decision_messages` is the per-decision Q&A thread: the person's questions
 * and the raising bot's answers. Recent human questions are fed back into the
 * briefing prompts so future briefings answer them up front.
 *
 * Additive: new tables only. Nothing here changes an existing table.
 */
import type Database from 'better-sqlite3'

export function initDecisionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id     INTEGER NOT NULL,
      workspace        TEXT    NOT NULL DEFAULT '',
      agent_slug       TEXT,
      source           TEXT    NOT NULL CHECK (source IN ('worker', 'bot', 'job_disposition', 'owner')),
      state            TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'decided', 'withdrawn')),
      incomplete       INTEGER NOT NULL DEFAULT 0,
      flags            TEXT,
      context          TEXT    NOT NULL DEFAULT '',
      question         TEXT    NOT NULL DEFAULT '',
      options          TEXT    NOT NULL DEFAULT '[]',
      recommended      TEXT,
      recommended_why  TEXT,
      raw_note         TEXT,
      chosen           TEXT,
      decided_by       TEXT,
      decided_at       TEXT,
      decision_note    TEXT,
      outcome          TEXT,
      outcome_text     TEXT,
      withdrawn_reason TEXT,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_objective ON decisions(objective_id, state);
    CREATE INDEX IF NOT EXISTS idx_decisions_workspace ON decisions(workspace, created_at);

    CREATE TABLE IF NOT EXISTS decision_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id  INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      role         TEXT    NOT NULL CHECK (role IN ('human', 'bot', 'system')),
      author       TEXT,
      body         TEXT    NOT NULL,
      status       TEXT    CHECK (status IS NULL OR status IN ('pending', 'answered', 'failed')),
      in_reply_to  INTEGER,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_messages_decision ON decision_messages(decision_id, id);
  `)
  // obj 901151 — an answer on a finished bot card is DELIVERED to the bot that
  // owns it (its chat + its next session) instead of dead-ending in "Reopen and
  // apply". Additive columns: who it went to, and when a session picked it up.
  const cols = new Set((db.prepare('PRAGMA table_info(decisions)').all() as { name: string }[]).map(c => c.name))
  const add = (name: string, type: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE decisions ADD COLUMN ${name} ${type}`)
  }
  add('delivered_to', 'TEXT')
  add('delivered_user_id', 'INTEGER')
  add('delivered_at', 'TEXT')
  add('delivered_consumed_at', 'TEXT')
  add('delivered_consumed_by', 'INTEGER')
  // A session that RENDERED a delivered answer into its prompt claims it; the
  // claim becomes `delivered_consumed_*` only once that session really started
  // (a failed spawn's claim is released or lapses, so the answer is not lost).
  add('delivered_claimed_by', 'INTEGER')
  add('delivered_claimed_at', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_decisions_delivered ON decisions(delivered_to, delivered_consumed_at)')
}
