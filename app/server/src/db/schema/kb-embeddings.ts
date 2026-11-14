/**
 * Knowledge-base semantic index (obj 900816).
 *
 * Chunk embeddings live in the main SQLite DB next to everything else:
 *   kb_embed_docs    one row per indexed file: content hash + the model it was embedded with
 *   kb_embed_chunks  one row per chunk: file path, heading trail, start line, (redacted) text
 *   kb_vec           sqlite-vec `vec0` table, rowid = kb_embed_chunks.id. Created lazily by
 *                    services/kb-semantic/store.ts because its dimension depends on the
 *                    configured model and it needs the sqlite-vec extension loaded.
 *   kb_embed_jobs    backfill / re-embed runs (progress shown on the Jobs page)
 *
 * Additive + idempotent, like every schema module. Called from initDb() and lazily
 * by the store so test DBs work.
 */
import type Database from 'better-sqlite3'

export function initKbEmbeddingsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_embed_docs (
      path          TEXT PRIMARY KEY,
      workspace     TEXT NOT NULL DEFAULT '',
      mtime_ms      REAL NOT NULL DEFAULT 0,
      size          INTEGER NOT NULL DEFAULT 0,
      content_hash  TEXT NOT NULL,
      model_id      TEXT NOT NULL,
      chunk_count   INTEGER NOT NULL DEFAULT 0,
      embedded_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kb_embed_docs_model ON kb_embed_docs(model_id);

    CREATE TABLE IF NOT EXISTS kb_embed_chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      path         TEXT NOT NULL,
      workspace    TEXT NOT NULL DEFAULT '',
      chunk_index  INTEGER NOT NULL,
      heading      TEXT NOT NULL DEFAULT '',
      line         INTEGER NOT NULL DEFAULT 1,
      text         TEXT NOT NULL,
      model_id     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_embed_chunks_path ON kb_embed_chunks(path);

    CREATE TABLE IF NOT EXISTS kb_embed_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 'backfill' (whole knowledge base) | 'reembed' (model changed)
      kind          TEXT NOT NULL DEFAULT 'backfill',
      -- running | done | failed | cancelled | interrupted
      status        TEXT NOT NULL DEFAULT 'running',
      trigger       TEXT NOT NULL DEFAULT 'manual',
      model_id      TEXT NOT NULL,
      total         INTEGER NOT NULL DEFAULT 0,
      processed     INTEGER NOT NULL DEFAULT 0,
      embedded      INTEGER NOT NULL DEFAULT 0,
      skipped       INTEGER NOT NULL DEFAULT 0,
      failed        INTEGER NOT NULL DEFAULT 0,
      removed       INTEGER NOT NULL DEFAULT 0,
      chunks        INTEGER NOT NULL DEFAULT 0,
      current_path  TEXT,
      error         TEXT,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at   TEXT
    );
  `)
}
