/**
 * Knowledge-gap flags (obj 901767) — the store behind "this knowledge is
 * missing / wrong / out of date".
 *
 * Workers, chat bots, outside agents and people file a flag while they work,
 * the way they already raise a decision. Filing is NOT a wiki edit: this module
 * only writes `kb_flags` rows and never touches a page. The busy worker reports;
 * a person (Cleanup tab) or a later curator run (`listKbFlags`) acts on it.
 *
 * Filing the same open defect again (same workspace + kind + page + subject)
 * bumps `seen_count` on the existing row instead of stacking duplicates, and
 * fills in a suggested fix / card link the first report lacked.
 */
import type Database from 'better-sqlite3'
import {
  KB_FLAG_KINDS, KB_FLAG_LIMITS, KB_FLAG_STATUSES, kbFlagDedupeKey,
  type CleanKbFlagInput, type KbFlag, type KbFlagKind, type KbFlagSource, type KbFlagStatus,
} from '@operationkit/shared'

export class KbFlagError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

export interface FileKbFlagMeta {
  workspace: string
  source: KbFlagSource
  filedBy: string
}

/** File a flag (or bump the matching open one). `reused` = an open flag for the same defect already existed. */
export function fileKbFlag(db: Database.Database, input: CleanKbFlagInput, meta: FileKbFlagMeta): { flag: KbFlag; reused: boolean } {
  if (!meta.workspace) throw new KbFlagError('A flag needs a workspace.')
  const key = kbFlagDedupeKey(input)
  const filedBy = meta.filedBy.slice(0, 200)
  return db.transaction(() => {
    const open = db.prepare(`SELECT id FROM kb_flags WHERE workspace = ? AND dedupe_key = ? AND status = 'open' ORDER BY id LIMIT 1`)
      .get(meta.workspace, key) as { id: number } | undefined
    if (open) {
      db.prepare(`
        UPDATE kb_flags SET
          seen_count    = seen_count + 1,
          last_seen_at  = datetime('now'),
          updated_at    = datetime('now'),
          suggested_fix = COALESCE(suggested_fix, ?),
          objective_id  = COALESCE(objective_id, ?),
          trace         = COALESCE(trace, ?)
        WHERE id = ?
      `).run(input.suggested_fix, input.objective_id, input.trace, open.id)
      return { flag: getKbFlag(db, open.id)!, reused: true }
    }
    const r = db.prepare(`
      INSERT INTO kb_flags (workspace, kind, subject, page, detail, suggested_fix, objective_id, trace, source, filed_by, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(meta.workspace, input.kind, input.subject, input.page, input.detail, input.suggested_fix,
      input.objective_id, input.trace, meta.source, filedBy, key)
    return { flag: getKbFlag(db, Number(r.lastInsertRowid))!, reused: false }
  })()
}

export function getKbFlag(db: Database.Database, id: number): KbFlag | undefined {
  return db.prepare('SELECT * FROM kb_flags WHERE id = ?').get(id) as KbFlag | undefined
}

export interface ListKbFlagsOptions {
  /** 'all' = every status. Default 'open'. */
  status?: KbFlagStatus | 'all'
  kind?: KbFlagKind
  /** Only flags filed from this card. */
  objectiveId?: number
  /** Only flags with id > this (a curator's cursor). */
  afterId?: number
  limit?: number
  offset?: number
}

export const MAX_KB_FLAGS_PAGE = 200

/** Flags for one workspace, oldest first (queue order), plus the total matching and the open count. */
export function listKbFlags(db: Database.Database, workspace: string, o: ListKbFlagsOptions = {}): { flags: KbFlag[]; total: number; open: number } {
  const where = ['workspace = ?']
  const args: unknown[] = [workspace]
  const status = o.status ?? 'open'
  if (status !== 'all') { where.push('status = ?'); args.push(status) }
  if (o.kind) { where.push('kind = ?'); args.push(o.kind) }
  if (o.objectiveId !== undefined) { where.push('objective_id = ?'); args.push(o.objectiveId) }
  if (o.afterId !== undefined) { where.push('id > ?'); args.push(o.afterId) }
  const sql = where.join(' AND ')
  const limit = Math.max(1, Math.min(MAX_KB_FLAGS_PAGE, Math.floor(o.limit ?? 50)))
  const offset = Math.max(0, Math.floor(o.offset ?? 0))
  const flags = db.prepare(`SELECT * FROM kb_flags WHERE ${sql} ORDER BY id ASC LIMIT ? OFFSET ?`).all(...args, limit, offset) as KbFlag[]
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM kb_flags WHERE ${sql}`).get(...args) as { n: number }).n
  const open = (db.prepare(`SELECT COUNT(*) AS n FROM kb_flags WHERE workspace = ? AND status = 'open'`).get(workspace) as { n: number }).n
  return { flags, total, open }
}

/**
 * Close (or reopen) a flag. Recording what happened is all this does: a
 * resolved flag never edits a page — whoever fixed the knowledge did that
 * through the normal write paths.
 */
export function setKbFlagStatus(db: Database.Database, workspace: string, id: number, status: KbFlagStatus, by: string, note?: string | null): KbFlag {
  if (!(KB_FLAG_STATUSES as readonly string[]).includes(status)) throw new KbFlagError('status must be "open", "resolved" or "dismissed".')
  const flag = getKbFlag(db, id)
  if (!flag || flag.workspace !== workspace) throw new KbFlagError('That flag was not found.', 404)
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, KB_FLAG_LIMITS.resolution_note) : null
  if (status === 'open') {
    db.prepare(`UPDATE kb_flags SET status = 'open', resolution_note = NULL, resolved_by = NULL, resolved_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(id)
  } else {
    db.prepare(`UPDATE kb_flags SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(status, cleanNote, by.slice(0, 200), id)
  }
  return getKbFlag(db, id)!
}

export function isKbFlagKind(v: unknown): v is KbFlagKind {
  return typeof v === 'string' && (KB_FLAG_KINDS as readonly string[]).includes(v)
}

export function isKbFlagStatus(v: unknown): v is KbFlagStatus {
  return typeof v === 'string' && (KB_FLAG_STATUSES as readonly string[]).includes(v)
}
