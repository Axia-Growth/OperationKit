/**
 * Restart-durable per-session retry counters (obj 900911, systems audit #4).
 *
 * `autoResumeCounts`, `overloadRetryCounts` and `turnsContinueCounts`
 * (session-death.ts) were module-level `Map`s. A restart — including a
 * supported in-session self-deploy — emptied them, so a session that had
 * already burned its limit-rotation / 529 / max-turns budget got a fresh one.
 * obj 900322 already made the per-OBJECTIVE `noop_respawn` counter durable
 * (job-accounting.ts); these three are keyed by SESSION id (sendFollowUp keeps
 * the id across respawns), so they get their own small table.
 *
 * {@link DurableRetryCounter} keeps the `Map` surface the call sites already use
 * (`get` / `set` / `delete` / `has` / `clear`) and writes through to SQLite. If
 * the DB is unavailable it degrades to an in-memory map rather than throwing:
 * a counter must never be the reason a dead session is not handled.
 *
 * `overloadRetryPending` stays in memory on purpose: it marks a backoff
 * `setTimeout` that only exists in THIS process. After a restart that timer is
 * gone, so a persisted "pending" flag would wrongly hide the session from the
 * poller forever.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'

export const SESSION_RETRY_COUNTERS_TABLE = 'session_retry_counters'
/** Rows untouched this long are dropped (a session that old is long finished). */
const STALE_DAYS = 30
const PRUNE_EVERY_MS = 60 * 60_000

export function initSessionRetryCountersSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SESSION_RETRY_COUNTERS_TABLE} (
      session_id TEXT    NOT NULL,
      kind       TEXT    NOT NULL,
      count      INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, kind)
    );
  `)
}

const initialised = new WeakSet<Database.Database>()

export class DurableRetryCounter {
  private readonly memory = new Map<string, number>()
  private lastPrune = 0

  constructor(
    readonly kind: string,
    private readonly db: () => Database.Database = getDb,
  ) {}

  private conn(): Database.Database | null {
    try {
      const d = this.db()
      if (!initialised.has(d)) {
        initSessionRetryCountersSchema(d)
        initialised.add(d)
      }
      return d
    } catch (err) {
      console.warn(`[retry-counters] ${this.kind}: DB unavailable, using in-memory counter:`, err instanceof Error ? err.message : err)
      return null
    }
  }

  get(sessionId: string): number | undefined {
    const d = this.conn()
    if (!d) return this.memory.get(sessionId)
    try {
      const row = d.prepare(`SELECT count FROM ${SESSION_RETRY_COUNTERS_TABLE} WHERE session_id = ? AND kind = ?`)
        .get(sessionId, this.kind) as { count: number } | undefined
      return row ? Number(row.count) : undefined
    } catch {
      return this.memory.get(sessionId)
    }
  }

  has(sessionId: string): boolean {
    return this.get(sessionId) !== undefined
  }

  set(sessionId: string, count: number): this {
    this.memory.set(sessionId, count)
    const d = this.conn()
    if (!d) return this
    try {
      d.prepare(
        `INSERT INTO ${SESSION_RETRY_COUNTERS_TABLE} (session_id, kind, count, updated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(session_id, kind) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`,
      ).run(sessionId, this.kind, count)
      this.maybePrune(d)
    } catch (err) {
      console.warn(`[retry-counters] ${this.kind}: write failed, kept in memory:`, err instanceof Error ? err.message : err)
    }
    return this
  }

  delete(sessionId: string): boolean {
    const had = this.memory.delete(sessionId)
    const d = this.conn()
    if (!d) return had
    try {
      const r = d.prepare(`DELETE FROM ${SESSION_RETRY_COUNTERS_TABLE} WHERE session_id = ? AND kind = ?`).run(sessionId, this.kind)
      return r.changes > 0 || had
    } catch {
      return had
    }
  }

  clear(): void {
    this.memory.clear()
    const d = this.conn()
    if (!d) return
    try { d.prepare(`DELETE FROM ${SESSION_RETRY_COUNTERS_TABLE} WHERE kind = ?`).run(this.kind) } catch { /* best effort */ }
  }

  private maybePrune(d: Database.Database): void {
    const now = Date.now()
    if (now - this.lastPrune < PRUNE_EVERY_MS) return
    this.lastPrune = now
    try {
      d.prepare(`DELETE FROM ${SESSION_RETRY_COUNTERS_TABLE} WHERE updated_at < datetime('now', ?)`).run(`-${STALE_DAYS} days`)
    } catch { /* best effort */ }
  }
}
