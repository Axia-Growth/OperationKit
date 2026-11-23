/**
 * Incremental embedding + resumable backfill for knowledge-base semantic
 * search (obj 900816).
 *
 * WRITE PATHS. Every server path that writes a knowledge-base note calls
 * `noteKbChanged(path)` (docs PUT / MCP write_doc, chat write_doc + file_answer,
 * document import, KB setup, wiki compile). That enqueues the file; one worker
 * drains the queue serially so a burst of imports never runs N models at once.
 * A periodic reconcile pass (mtime/size, then content hash) catches anything
 * written behind the server's back — Obsidian, git pulls, a host script.
 *
 * BACKFILL. `startBackfill()` walks the whole knowledge base as a job row in
 * `kb_embed_jobs` (progress on the Jobs page). It is resumable by
 * construction: a file whose content hash AND model id already match is
 * skipped, so re-running after a crash/restart only does the remaining work.
 * A run left `running` by a restart is marked `interrupted` at boot and a new
 * run picks up where it stopped. A model change makes every row stale, so the
 * same job re-embeds everything.
 *
 * NEVER EMBEDDED: anything the file-access denylist refuses (.env*, keys,
 * credential/secret files, .ssh …), files outside the knowledge base, and the
 * excluded system folders. Chunk text that looks like a credential is redacted
 * BEFORE it is embedded or stored.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { chunkMarkdown } from './chunk.js'
import type { EmbeddingProvider } from './providers.js'
import { allDocRows, ensureSchema, ensureVecTable, getDocRow, removeDoc, replaceDocChunks, touchDoc } from './store.js'
import { isEnvFileName } from '../file-access.js'
import { redactSecrets } from '../kb-setup/secrets.js'
import { workspaceOfVaultPath } from '../../lib/kb-workspace-scope.js'

export const EXCLUDE_DIRS = new Set(['.obsidian', '_import', '_system', 'node_modules', '.git', '.trash', '.cc-state'])
/**
 * A note whose NAME says it is a credential store (credentials.md, secrets.md,
 * api-keys.md, prod.env.md, passwords.md) is never embedded. A note that is
 * merely ABOUT secrets ("secrets-store-design.md") is fine: its content goes
 * through redactSecrets() like every other chunk.
 */
const CREDENTIAL_FILE = /^(\.?env|.*\.env|credentials?|secrets?|passwords?|api[-_ ]?keys?|tokens?|private[-_ ]?keys?)(\.[\w-]+|[-_ ](prod|production|dev|staging|local|backup|old|copy|\d+))?$/i
const DENY_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.secrets', '.claude-auth', 'secrets', 'credentials'])
const MAX_FILE_BYTES = 512 * 1024
const BATCH = 32

export interface IndexerDeps {
  db: Database.Database
  provider: EmbeddingProvider
  /** Knowledge base root; only files under it are indexed. */
  root: string
  log?: (msg: string) => void
}

/**
 * Workspace label stored with each chunk (KNN pre-filter only; the realpath wall is applied at query time).
 * A file inside a workspace's custom folder (`vault_path`) is labelled with that
 * workspace, by the same helper the search wall uses (obj 900963); otherwise the
 * label comes from the folder layout.
 */
export function workspaceLabel(root: string, file: string): string {
  const custom = workspaceOfVaultPath(file, root)
  if (custom) return custom
  const rel = path.relative(root, file).split(path.sep)
  if (rel.length >= 3 && rel[0] === 'workspaces') return rel[1]
  return rel.length >= 2 ? rel[0] : ''
}

/** Is this file one the semantic index may hold? Pure path check. */
export function isEmbeddable(root: string, file: string): boolean {
  const abs = path.resolve(file)
  const rel = path.relative(path.resolve(root), abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  if (!abs.toLowerCase().endsWith('.md')) return false
  const parts = rel.split(path.sep)
  if (parts.some(p => EXCLUDE_DIRS.has(p) || p.startsWith('.'))) return false
  const base = parts[parts.length - 1]
  if (base === 'index.md' || isEnvFileName(base)) return false
  if (CREDENTIAL_FILE.test(base.replace(/\.md$/i, ''))) return false
  if (parts.some(p => DENY_SEGMENTS.has(p.toLowerCase()))) return false
  return true
}

export function walkKnowledgeBase(root: string): string[] {
  const out: string[] = []
  const stack = [path.resolve(root)]
  while (stack.length) {
    const dir = stack.pop()!
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name) || e.name.startsWith('.')) continue
        stack.push(full)
      } else if (e.isFile() && isEmbeddable(root, full)) {
        out.push(full)
      }
    }
  }
  return out.sort()
}

export type IndexOutcome = 'embedded' | 'skipped' | 'removed' | 'ineligible' | 'failed'

/** Bring one file's chunks up to date. Never throws. */
export async function indexFile(deps: IndexerDeps, file: string): Promise<{ outcome: IndexOutcome; chunks: number; error?: string }> {
  const { db, provider, root } = deps
  const abs = path.resolve(file)
  try {
    ensureSchema(db)
    if (!isEmbeddable(root, abs)) {
      if (getDocRow(db, abs)) { removeDoc(db, abs); return { outcome: 'removed', chunks: 0 } }
      return { outcome: 'ineligible', chunks: 0 }
    }
    let st: fs.Stats
    try { st = fs.statSync(abs) } catch {
      if (getDocRow(db, abs)) { removeDoc(db, abs); return { outcome: 'removed', chunks: 0 } }
      return { outcome: 'ineligible', chunks: 0 }
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) {
      if (getDocRow(db, abs)) removeDoc(db, abs)
      return { outcome: 'ineligible', chunks: 0 }
    }
    // A changed label (a vault_path set or moved after the file was embedded)
    // makes the stored rows stale: the KNN pre-filter would look under the
    // wrong workspace, so the file is embedded again.
    const label = workspaceLabel(root, abs)
    const stored = getDocRow(db, abs)
    const existing = stored && stored.workspace === label ? stored : null
    if (existing && existing.model_id === provider.modelId && existing.mtime_ms === st.mtimeMs && existing.size === st.size) {
      return { outcome: 'skipped', chunks: existing.chunk_count }
    }
    const raw = fs.readFileSync(abs, 'utf8')
    const hash = createHash('sha256').update(raw).digest('hex')
    if (existing && existing.model_id === provider.modelId && existing.content_hash === hash) {
      touchDoc(db, abs, st.mtimeMs, st.size)
      return { outcome: 'skipped', chunks: existing.chunk_count }
    }
    const chunks = chunkMarkdown(raw, path.basename(abs, '.md').replace(/[-_]+/g, ' '))
      .map(c => {
        const text = redactSecrets(c.text).text
        return { ...c, text, embedText: redactSecrets(c.embedText).text }
      })
    const vectors: Float32Array[] = []
    for (let i = 0; i < chunks.length; i += BATCH) {
      vectors.push(...await provider.embed(chunks.slice(i, i + BATCH).map(c => c.embedText), 'document'))
    }
    const dim = vectors[0]?.length ?? provider.config.dimensions
    if (!ensureVecTable(db, dim)) return { outcome: 'failed', chunks: 0, error: 'sqlite-vec unavailable' }
    if (vectors.some(v => v.length !== dim)) return { outcome: 'failed', chunks: 0, error: 'inconsistent vector dimensions' }
    replaceDocChunks(db, {
      path: abs, workspace: label, mtimeMs: st.mtimeMs, size: st.size, contentHash: hash, modelId: provider.modelId,
    }, chunks.map((c, i) => ({ index: c.index, heading: c.heading, line: c.line, text: c.text, vector: vectors[i] })))
    return { outcome: 'embedded', chunks: chunks.length }
  } catch (err) {
    return { outcome: 'failed', chunks: 0, error: (err as Error).message.slice(0, 300) }
  }
}

// ── backfill job ────────────────────────────────────────────────────────────

export interface JobRow {
  id: number
  kind: string
  status: string
  trigger: string
  model_id: string
  total: number
  processed: number
  embedded: number
  skipped: number
  failed: number
  removed: number
  chunks: number
  current_path: string | null
  error: string | null
  started_at: string
  updated_at: string
  finished_at: string | null
}

export function latestJob(db: Database.Database): JobRow | null {
  ensureSchema(db)
  return (db.prepare('SELECT * FROM kb_embed_jobs ORDER BY id DESC LIMIT 1').get() as JobRow | undefined) ?? null
}

export function runningJob(db: Database.Database): JobRow | null {
  ensureSchema(db)
  return (db.prepare("SELECT * FROM kb_embed_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1").get() as JobRow | undefined) ?? null
}

/** At boot: a run that was `running` when the process died is `interrupted` (the next run resumes it). */
export function markInterruptedJobs(db: Database.Database): number {
  ensureSchema(db)
  return db.prepare("UPDATE kb_embed_jobs SET status = 'interrupted', finished_at = datetime('now'), updated_at = datetime('now') WHERE status = 'running'").run().changes
}

export function cancelJob(db: Database.Database): boolean {
  ensureSchema(db)
  return db.prepare("UPDATE kb_embed_jobs SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now') WHERE status = 'running'").run().changes > 0
}

/** Does the knowledge base need a backfill (never embedded, or embedded with another model)? */
export function needsBackfill(db: Database.Database, modelId: string): boolean {
  ensureSchema(db)
  const stale = db.prepare('SELECT 1 FROM kb_embed_docs WHERE model_id != ? LIMIT 1').get(modelId)
  const any = db.prepare('SELECT 1 FROM kb_embed_docs LIMIT 1').get()
  const last = latestJob(db)
  return !!stale || !any || !!(last && last.status === 'interrupted')
}

/**
 * Run a full pass. Resolves when the job ends. The caller decides whether to
 * await it (tests, CLI) or fire-and-forget (routes).
 */
export async function runBackfill(deps: IndexerDeps, opts: { trigger?: string; files?: string[] } = {}): Promise<JobRow> {
  const { db, provider } = deps
  ensureSchema(db)
  if (runningJob(db)) throw new Error('A knowledge-base embedding job is already running')
  const files = opts.files ?? walkKnowledgeBase(deps.root)
  const stale = db.prepare('SELECT 1 FROM kb_embed_docs WHERE model_id != ? LIMIT 1').get(provider.modelId)
  const kind = stale ? 'reembed' : 'backfill'
  const id = Number(db.prepare('INSERT INTO kb_embed_jobs (kind, status, trigger, model_id, total) VALUES (?, \'running\', ?, ?, ?)')
    .run(kind, opts.trigger ?? 'manual', provider.modelId, files.length).lastInsertRowid)
  const c = { processed: 0, embedded: 0, skipped: 0, failed: 0, removed: 0, chunks: 0 }
  let lastError: string | null = null
  const save = (current: string | null) => db.prepare(`UPDATE kb_embed_jobs SET processed = ?, embedded = ?, skipped = ?, failed = ?, removed = ?, chunks = ?,
      current_path = ?, error = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(c.processed, c.embedded, c.skipped, c.failed, c.removed, c.chunks, current, lastError, id)
  const stillRunning = () => (db.prepare('SELECT status FROM kb_embed_jobs WHERE id = ?').get(id) as { status: string }).status === 'running'
  let lastSave = 0
  try {
    for (const f of files) {
      if (!stillRunning()) break
      const r = await indexFile(deps, f)
      c.processed++
      if (r.outcome === 'embedded') { c.embedded++; c.chunks += r.chunks }
      else if (r.outcome === 'skipped') { c.skipped++; c.chunks += r.chunks }
      else if (r.outcome === 'removed') c.removed++
      else if (r.outcome === 'failed') { c.failed++; lastError = `${path.basename(f)}: ${r.error ?? 'failed'}` }
      if (Date.now() - lastSave > 1000) { save(f); lastSave = Date.now() }
      // A provider that fails on every file (no key, model missing) should stop the run, not grind through 10k files.
      if (c.failed >= 20 && c.embedded === 0 && c.skipped === 0) throw new Error(lastError ?? 'embedding failed')
    }
    // Prune rows for files that no longer exist / are no longer eligible.
    if (stillRunning() && !opts.files) {
      const present = new Set(files)
      for (const row of allDocRows(db)) {
        if (!present.has(row.path)) { removeDoc(db, row.path); c.removed++ }
      }
    }
    save(null)
    db.prepare("UPDATE kb_embed_jobs SET status = CASE WHEN status = 'running' THEN 'done' ELSE status END, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id)
    // Keep the run log bounded (a reconcile pass runs every 15 min).
    db.prepare('DELETE FROM kb_embed_jobs WHERE id NOT IN (SELECT id FROM kb_embed_jobs ORDER BY id DESC LIMIT 100)').run()
  } catch (err) {
    lastError = (err as Error).message.slice(0, 300)
    save(null)
    db.prepare("UPDATE kb_embed_jobs SET status = 'failed', finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id)
  }
  return db.prepare('SELECT * FROM kb_embed_jobs WHERE id = ?').get(id) as JobRow
}

// ── write-path queue ────────────────────────────────────────────────────────

export class WriteQueue {
  private pending = new Set<string>()
  private running: Promise<void> | null = null
  constructor(private getDeps: () => IndexerDeps | null) {}

  enqueue(file: string): void {
    if (typeof file !== 'string' || !file) return
    this.pending.add(path.resolve(file))
    if (!this.running) this.running = this.drain().finally(() => { this.running = null })
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  get size(): number { return this.pending.size }

  private async drain(): Promise<void> {
    // Yield once so a burst of writes in the same tick is coalesced.
    await new Promise(r => setTimeout(r, 25))
    while (this.pending.size) {
      const [next] = this.pending
      this.pending.delete(next)
      const deps = this.getDeps()
      if (!deps) { this.pending.clear(); return }
      const r = await indexFile(deps, next)
      if (r.outcome === 'failed') deps.log?.(`[kb-semantic] embed ${next} failed: ${r.error}`)
    }
  }
}
