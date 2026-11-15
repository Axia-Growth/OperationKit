/**
 * Storage for knowledge-base chunk embeddings (obj 900816): sqlite-vec inside
 * the existing SQLite DB. No vector server.
 *
 * The `vec0` virtual table is created on first use with the dimension of the
 * configured model. If the model's dimension changes, the table is dropped and
 * recreated and every doc row is invalidated so the backfill re-embeds. If the
 * sqlite-vec extension cannot be loaded (e.g. a server deployed without an
 * image rebuild), `vecReady()` returns false and search degrades to keyword —
 * nothing else on the DB is affected because only this module touches kb_vec.
 */
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { initKbEmbeddingsSchema } from '../../db/schema/kb-embeddings.js'

const VEC_DIM_KEY = 'kb_embed_vec_dim'
const loaded = new WeakMap<Database.Database, { ok: boolean; error?: string }>()
const schemaDone = new WeakSet<Database.Database>()

export function ensureSchema(db: Database.Database): void {
  if (schemaDone.has(db)) return
  initKbEmbeddingsSchema(db)
  schemaDone.add(db)
}

/** Load the sqlite-vec extension onto this connection once. Never throws. */
export function loadVecExtension(db: Database.Database): { ok: boolean; error?: string } {
  const prior = loaded.get(db)
  if (prior) return prior
  let r: { ok: boolean; error?: string }
  try {
    const req = createRequire(import.meta.url)
    const sqliteVec = req('sqlite-vec') as { load(db: unknown): void }
    sqliteVec.load(db)
    r = { ok: true }
  } catch (err) {
    r = { ok: false, error: (err as Error).message.slice(0, 300) }
  }
  loaded.set(db, r)
  return r
}

function readSetting(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch { return null }
}
function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name)
}

/**
 * Make sure kb_vec exists with `dim` dimensions. Returns false when the
 * extension is unavailable. A dimension change drops every stored vector.
 */
export function ensureVecTable(db: Database.Database, dim: number): boolean {
  ensureSchema(db)
  if (!loadVecExtension(db).ok) return false
  if (!Number.isInteger(dim) || dim <= 0 || dim > 8192) return false
  const current = parseInt(readSetting(db, VEC_DIM_KEY) ?? '', 10)
  const exists = tableExists(db, 'kb_vec')
  if (exists && current === dim) return true
  db.transaction(() => {
    if (exists) db.exec('DROP TABLE kb_vec')
    db.exec('DELETE FROM kb_embed_chunks')
    db.exec('DELETE FROM kb_embed_docs')
    db.exec(`CREATE VIRTUAL TABLE kb_vec USING vec0(embedding float[${dim}] distance_metric=cosine, workspace text)`)
    writeSetting(db, VEC_DIM_KEY, String(dim))
  })()
  return true
}

export function vecReady(db: Database.Database): boolean {
  ensureSchema(db)
  return loadVecExtension(db).ok && tableExists(db, 'kb_vec')
}

export interface DocRow {
  path: string
  workspace: string
  mtime_ms: number
  size: number
  content_hash: string
  model_id: string
  chunk_count: number
}

export function getDocRow(db: Database.Database, path: string): DocRow | null {
  ensureSchema(db)
  return (db.prepare('SELECT path, workspace, mtime_ms, size, content_hash, model_id, chunk_count FROM kb_embed_docs WHERE path = ?').get(path) as DocRow | undefined) ?? null
}

export function allDocRows(db: Database.Database): DocRow[] {
  ensureSchema(db)
  return db.prepare('SELECT path, workspace, mtime_ms, size, content_hash, model_id, chunk_count FROM kb_embed_docs').all() as DocRow[]
}

export interface ChunkInput {
  index: number
  heading: string
  line: number
  text: string
  vector: Float32Array
}

const vecBuf = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)

/** Replace every chunk of `path` atomically. */
export function replaceDocChunks(
  db: Database.Database,
  doc: { path: string; workspace: string; mtimeMs: number; size: number; contentHash: string; modelId: string },
  chunks: ChunkInput[],
): void {
  db.transaction(() => {
    deleteDocChunksInTx(db, doc.path)
    const insChunk = db.prepare('INSERT INTO kb_embed_chunks (path, workspace, chunk_index, heading, line, text, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insVec = db.prepare('INSERT INTO kb_vec (rowid, embedding, workspace) VALUES (?, ?, ?)')
    for (const c of chunks) {
      const r = insChunk.run(doc.path, doc.workspace, c.index, c.heading, c.line, c.text, doc.modelId)
      insVec.run(BigInt(r.lastInsertRowid), vecBuf(c.vector), doc.workspace)
    }
    db.prepare(`INSERT INTO kb_embed_docs (path, workspace, mtime_ms, size, content_hash, model_id, chunk_count, embedded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(path) DO UPDATE SET workspace = excluded.workspace, mtime_ms = excluded.mtime_ms, size = excluded.size,
                  content_hash = excluded.content_hash, model_id = excluded.model_id, chunk_count = excluded.chunk_count,
                  embedded_at = excluded.embedded_at`)
      .run(doc.path, doc.workspace, doc.mtimeMs, doc.size, doc.contentHash, doc.modelId, chunks.length)
  })()
}

/** Record that a doc's mtime moved without its content changing (no re-embed). */
export function touchDoc(db: Database.Database, path: string, mtimeMs: number, size: number): void {
  db.prepare('UPDATE kb_embed_docs SET mtime_ms = ?, size = ? WHERE path = ?').run(mtimeMs, size, path)
}

function deleteDocChunksInTx(db: Database.Database, path: string): void {
  const ids = db.prepare('SELECT id FROM kb_embed_chunks WHERE path = ?').all(path) as { id: number }[]
  if (ids.length && tableExists(db, 'kb_vec')) {
    const del = db.prepare('DELETE FROM kb_vec WHERE rowid = ?')
    for (const { id } of ids) del.run(BigInt(id))
  }
  db.prepare('DELETE FROM kb_embed_chunks WHERE path = ?').run(path)
}

export function removeDoc(db: Database.Database, path: string): void {
  ensureSchema(db)
  db.transaction(() => {
    deleteDocChunksInTx(db, path)
    db.prepare('DELETE FROM kb_embed_docs WHERE path = ?').run(path)
  })()
}

export interface ChunkHit {
  chunkId: number
  path: string
  heading: string
  line: number
  text: string
  distance: number
}

/**
 * K nearest chunks to `query`. `workspaces` pre-filters inside the KNN (the
 * caller still applies the realpath workspace wall afterwards).
 */
export function knnChunks(db: Database.Database, query: Float32Array, k: number, modelId: string, workspaces?: string[]): ChunkHit[] {
  if (!vecReady(db)) return []
  const kk = Math.max(1, Math.min(k, 4096))
  let rows: { rowid: number; distance: number }[]
  if (workspaces && workspaces.length) {
    const ws = [...new Set(workspaces)].slice(0, 16)
    rows = db.prepare(`SELECT rowid, distance FROM kb_vec WHERE embedding MATCH ? AND k = ? AND workspace IN (${ws.map(() => '?').join(',')}) ORDER BY distance`)
      .all(vecBuf(query), kk, ...ws) as { rowid: number; distance: number }[]
  } else {
    rows = db.prepare('SELECT rowid, distance FROM kb_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance')
      .all(vecBuf(query), kk) as { rowid: number; distance: number }[]
  }
  if (rows.length === 0) return []
  // A chunk embedded by another model lives in a different vector space: skip it
  // (they are re-embedded by the backfill after a model change).
  const get = db.prepare('SELECT id, path, heading, line, text FROM kb_embed_chunks WHERE id = ? AND model_id = ?')
  const out: ChunkHit[] = []
  for (const r of rows) {
    const c = get.get(r.rowid, modelId) as { id: number; path: string; heading: string; line: number; text: string } | undefined
    if (c) out.push({ chunkId: c.id, path: c.path, heading: c.heading, line: c.line, text: c.text, distance: r.distance })
  }
  return out
}

/** The stored vectors of one doc (for "related by similarity"). */
export function docVectors(db: Database.Database, path: string, max = 8): Float32Array[] {
  if (!vecReady(db)) return []
  const ids = db.prepare('SELECT id FROM kb_embed_chunks WHERE path = ? ORDER BY chunk_index LIMIT ?').all(path, max) as { id: number }[]
  const get = db.prepare('SELECT embedding FROM kb_vec WHERE rowid = ?')
  const out: Float32Array[] = []
  for (const { id } of ids) {
    const row = get.get(BigInt(id)) as { embedding: Buffer } | undefined
    if (row) out.push(new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength)))
  }
  return out
}

export interface IndexStats {
  docs: number
  chunks: number
  docsCurrentModel: number
  dim: number | null
}

export function indexStats(db: Database.Database, modelId: string): IndexStats {
  ensureSchema(db)
  const docs = (db.prepare('SELECT COUNT(*) AS n FROM kb_embed_docs').get() as { n: number }).n
  const chunks = (db.prepare('SELECT COUNT(*) AS n FROM kb_embed_chunks').get() as { n: number }).n
  const cur = (db.prepare('SELECT COUNT(*) AS n FROM kb_embed_docs WHERE model_id = ?').get(modelId) as { n: number }).n
  const dim = parseInt(readSetting(db, VEC_DIM_KEY) ?? '', 10)
  return { docs, chunks, docsCurrentModel: cur, dim: Number.isFinite(dim) ? dim : null }
}
