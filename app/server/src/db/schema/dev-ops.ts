/**
 * Operation Kit Dev operator tools (obj 901424). Additive CREATE TABLEs only.
 *
 * `agent_chat_dev_ops` is the ONE admin switch. Only the `operation-kit-dev`
 * chat bot is ever eligible (services/dev-ops/switch.ts); for it, NO ROW = ON,
 * so the owner's approval needs no setup. A row with enabled = 0 turns every
 * dev-ops tool off for that bot. A row for any other slug is ignored.
 *
 * `dev_ops_audit` is the audit trail: one row for EVERY dev-ops tool call,
 * allowed or refused, plus one per background step (branch update, merge on
 * green, deploy settled). `detail` is redacted before it is written.
 *
 * `dev_ops_pending_merges` holds a merge waiting for CI on a branch the tool
 * just updated from its base (GitHub update-branch). The background tick merges
 * it, pinned to the new head, once CI on that head is green.
 *
 * Since obj 901463 the `waiting` rows of one repo are an ordered merge queue
 * (lowest id = head). Two additive columns: `stage` (`queued` = the branch has
 * not been touched since the merge was asked for; `updated` = update-branch was
 * called and the update commit is expected; rows from before the queue are
 * `updated`) and `head_at` (when the row became the head; NULL = only queued so
 * far). `updates` counts branch updates, which only ever happen at the head.
 *
 * `dev_ops_deploys` is one row per update.sh deploy started from chat. The host
 * runner writes the outcome to a file; the tick settles it into this row.
 */
import type Database from 'better-sqlite3'

export function initDevOpsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_chat_dev_ops (
      slug TEXT PRIMARY KEY COLLATE NOCASE,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dev_ops_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      bot_slug TEXT NOT NULL,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      target TEXT,
      objective_id INTEGER,
      outcome TEXT NOT NULL,
      code TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dev_ops_audit_at ON dev_ops_audit(at);
    CREATE INDEX IF NOT EXISTS idx_dev_ops_audit_obj ON dev_ops_audit(objective_id);

    CREATE TABLE IF NOT EXISTS dev_ops_pending_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      previous_head_sha TEXT NOT NULL,
      bot_slug TEXT NOT NULL,
      user_id INTEGER,
      username TEXT,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'merged', 'failed', 'expired')),
      updates INTEGER NOT NULL DEFAULT 1,
      last_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dev_ops_pending_merges_status ON dev_ops_pending_merges(status);

    CREATE TABLE IF NOT EXISTS dev_ops_deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_slug TEXT NOT NULL,
      user_id INTEGER,
      username TEXT,
      status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'deployed', 'unchanged', 'rolled_back', 'rollback_failed', 'failed')),
      step TEXT,
      from_sha TEXT,
      to_sha TEXT,
      backup_dir TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
  `)
  // obj 901463: merge queue columns (additive; old rows read as already-updated).
  const cols = new Set((db.prepare('PRAGMA table_info(dev_ops_pending_merges)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('stage')) db.exec("ALTER TABLE dev_ops_pending_merges ADD COLUMN stage TEXT NOT NULL DEFAULT 'updated'")
  if (!cols.has('head_at')) db.exec('ALTER TABLE dev_ops_pending_merges ADD COLUMN head_at TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_dev_ops_pending_merges_repo ON dev_ops_pending_merges(repo, status)')
  widenDeployStatus(db)
}

/**
 * obj 901479: `unchanged` = the deploy ran but the code source had nothing newer
 * (same commit before and after). SQLite cannot alter a CHECK, so a table made
 * before this status existed is rebuilt once, rows and ids kept.
 */
function widenDeployStatus(db: Database.Database): void {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dev_ops_deploys'").get() as { sql: string } | undefined)?.sql ?? ''
  if (!sql || sql.includes("'unchanged'")) return
  db.transaction(() => {
    db.exec(`
      CREATE TABLE dev_ops_deploys_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_slug TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'deployed', 'unchanged', 'rolled_back', 'rollback_failed', 'failed')),
        step TEXT,
        from_sha TEXT,
        to_sha TEXT,
        backup_dir TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
      INSERT INTO dev_ops_deploys_new (id, bot_slug, user_id, username, status, step, from_sha, to_sha, backup_dir, detail, created_at, finished_at)
        SELECT id, bot_slug, user_id, username, status, step, from_sha, to_sha, backup_dir, detail, created_at, finished_at FROM dev_ops_deploys;
      DROP TABLE dev_ops_deploys;
      ALTER TABLE dev_ops_deploys_new RENAME TO dev_ops_deploys;
    `)
  })()
}
