import Database from 'better-sqlite3'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { knowledgeBaseRoot } from '../lib/knowledge-base-root.js'
import { filterToWorkspaceScope } from '../lib/kb-workspace-scope.js'

/**
 * Semantic vault index for spawn-context KB injection (ST6).
 *
 * BACKGROUND: the original retrieval path (knowledge-search.ts) is grep-only —
 * a bounded `/usr/bin/grep` sweep with IDF ranking, chosen in 2026-06-12 because
 * "there is no qmd binary, hybrid-search service, or sqlite/FTS index anywhere
 * on this host" and rg was not installed in the container. That host constraint
 * is now lifted: `better-sqlite3` (already a runtime dependency) ships SQLite
 * with FTS5 compiled in, verified working in-container. FTS5 gives us BM25
 * relevance ranking + Porter stemming, and a curated synonym-expansion layer
 * bridges true paraphrase ("outage" -> "incident", "availability" -> "uptime")
 * that a lexical grep can never reach.
 *
 * Why FTS5 and not embeddings: the vault is ~1.4k markdown files / <10 MB.
 * Per personal/decisions/2026-04-24-kb-retrieval-approach.md, that scale is too
 * small for vector retrieval to earn its keep, and there is no offline embedding
 * model or runtime in the container — embeddings would require a network model
 * download, i.e. a hard new infra dependency we are told to avoid. FTS5 is
 * self-contained, drift-free (rebuilt from the vault on a content signature),
 * and degrades safely: any failure here returns [] and knowledge-search.ts
 * falls back to the original grep path.
 *
 * Synchronous throughout (better-sqlite3 is sync) to match the synchronous
 * buildContext() / searchKnowledge() call path.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'what', 'when',
  'where', 'which', 'will', 'should', 'would', 'could', 'have', 'has', 'had',
  'are', 'was', 'were', 'been', 'being', 'not', 'but', 'all', 'any', 'can',
  'may', 'must', 'our', 'your', 'their', 'its', 'use', 'using', 'used', 'via',
  'per', 'each', 'also', 'more', 'most', 'some', 'such', 'then', 'than',
  'them', 'they', 'you', 'how', 'why', 'who', 'out', 'get', 'set', 'new',
  'add', 'fix', 'run', 'make', 'need', 'needs', 'needed', 'does', 'doing',
  'done', 'only', 'just', 'here', 'there', 'about', 'after', 'before',
  'between', 'over', 'under', 'these', 'those', 'other', 'same', 'very',
  'objective', 'context', 'session', 'sessions', 'task', 'tasks', 'file',
  'files', 'currently', 'ensure', 'create', 'update', 'inject', 'support',
])

/**
 * Curated bidirectional synonym clusters for the ops/agent/infra vocabulary
 * this vault is written in. Each query term is expanded to its cluster
 * siblings before the FTS MATCH, so a paraphrase that shares no surface tokens
 * with a document ("service outage" vs a doc that only ever says "incident" /
 * "uptime") still retrieves it. Porter stemming inside FTS5 handles morphology
 * (plurals, -ing/-ed) on top of this, so clusters list lemmas, not every form.
 * This is the deliberate, documented "semantic" lever over plain grep.
 */
const SYNONYM_CLUSTERS: string[][] = [
  ['outage', 'incident', 'downtime', 'disruption', 'failure'],
  ['availability', 'uptime', 'reliability', 'liveness'],
  ['monitor', 'monitoring', 'observability', 'alerting', 'telemetry'],
  ['retrieval', 'search', 'lookup', 'recall', 'fetch'],
  ['embedding', 'vector', 'semantic'],
  ['worker', 'agent', 'subagent', 'delegate'],
  ['spawn', 'launch', 'provision', 'bootstrap'],
  ['deploy', 'deployment', 'release', 'ship', 'rollout'],
  ['schedule', 'scheduling', 'cron', 'recurring'],
  ['vault', 'knowledgebase', 'secondbrain'],
  ['credential', 'secret', 'token', 'apikey', 'auth'],
  ['email', 'mail', 'inbox', 'message'],
  ['cost', 'budget', 'spend', 'pricing'],
  ['error', 'failure', 'bug', 'fault'],
  ['migration', 'schema'],
]

const SYNONYMS: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>()
  for (const cluster of SYNONYM_CLUSTERS) {
    for (const term of cluster) {
      const others = cluster.filter((t) => t !== term)
      m.set(term, [...(m.get(term) || []), ...others])
    }
  }
  return m
})()

export interface VaultHit {
  path: string
  snippet: string
}

const SNIPPET_CHARS = 400
const MAX_DOCS = 5000
const MAX_HITS = 5
const EXCLUDE_DIRS = new Set(['.obsidian', '_import', '_system', 'node_modules', '.git'])

function extractTerms(query: string, max = 8): string[] {
  const seen = new Set<string>()
  for (const raw of query.toLowerCase().split(/[^a-z0-9-]+/)) {
    const word = raw.replace(/^-+|-+$/g, '')
    if (word.length < 3 || word.length > 40) continue
    if (/^\d+$/.test(word)) continue
    if (STOPWORDS.has(word)) continue
    seen.add(word)
    if (seen.size >= max) break
  }
  return [...seen]
}

function expandTerms(terms: string[]): string[] {
  const out = new Set<string>()
  for (const t of terms) {
    out.add(t)
    for (const syn of SYNONYMS.get(t) || []) out.add(syn)
  }
  return [...out]
}

interface VaultDoc {
  path: string
  mtimeMs: number
}

/** Walk the vault collecting indexable markdown docs (same scope as the grep path). */
function collectDocs(root: string): VaultDoc[] {
  const docs: VaultDoc[] = []
  const stack: string[] = [root]
  while (stack.length > 0 && docs.length < MAX_DOCS) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (EXCLUDE_DIRS.has(ent.name)) continue
        stack.push(join(dir, ent.name))
      } else if (ent.isFile() && ent.name.endsWith('.md') && ent.name !== 'index.md') {
        const full = join(dir, ent.name)
        try {
          docs.push({ path: full, mtimeMs: statSync(full).mtimeMs })
        } catch {
          // unreadable — skip
        }
      }
    }
  }
  return docs
}

/** Cheap content signature so the index rebuilds only when the vault changes. */
function signatureOf(docs: VaultDoc[]): string {
  let maxMtime = 0
  for (const d of docs) if (d.mtimeMs > maxMtime) maxMtime = d.mtimeMs
  return `${docs.length}:${Math.round(maxMtime)}`
}

function stripFrontmatter(text: string): { title: string; tags: string; body: string } {
  let title = ''
  let tags = ''
  let body = text
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end > 0) {
      const fm = text.slice(3, end)
      body = text.slice(end + 4)
      const tm = fm.match(/(?:^|\n)\s*title:\s*"?([^"\n]+)"?/i)
      if (tm) title = tm[1].trim()
      const gm = fm.match(/(?:^|\n)\s*tags:\s*\[([^\]]*)\]/i)
      if (gm) tags = gm[1].replace(/[\[\]"']/g, ' ')
    }
  }
  return { title, tags, body }
}

interface CachedIndex {
  db: Database.Database
  signature: string
}

let cache: CachedIndex | null = null

function buildIndex(root: string, docs: VaultDoc[]): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = OFF')
  db.exec(
    "CREATE VIRTUAL TABLE docs USING fts5(" +
      "path UNINDEXED, title, tags, body, " +
      "tokenize = 'porter unicode61 remove_diacritics 2')"
  )
  const insert = db.prepare('INSERT INTO docs (path, title, tags, body) VALUES (?, ?, ?, ?)')
  const tx = db.transaction((rows: VaultDoc[]) => {
    for (const d of rows) {
      let raw: string
      try {
        raw = readFileSync(d.path, 'utf8').slice(0, 65536)
      } catch {
        continue
      }
      const { title, tags, body } = stripFrontmatter(raw)
      insert.run(d.path, title, tags, body)
    }
  })
  tx(docs)
  return db
}

function getIndex(root: string): Database.Database | null {
  const docs = collectDocs(root)
  if (docs.length === 0) return null
  const sig = signatureOf(docs)
  if (cache && cache.signature === sig) return cache.db
  if (cache) {
    try {
      cache.db.close()
    } catch {
      // ignore
    }
    cache = null
  }
  const db = buildIndex(root, docs)
  cache = { db, signature: sig }
  return db
}

function makeSnippet(file: string, terms: string[]): string {
  let text = readFileSync(file, 'utf8').slice(0, 65536)
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end > 0) text = text.slice(end + 4)
  }
  const lower = text.toLowerCase()
  let pos = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (pos < 0 || i < pos)) pos = i
  }
  const start = Math.max(0, (pos < 0 ? 0 : pos) - 120)
  const snippet = text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + snippet + (start + SNIPPET_CHARS < text.length ? '…' : '')
}

export interface KeywordRow {
  path: string
  /** bm25 score: negative, lower = more relevant. */
  score: number
}

/** The FTS MATCH expression for a query (terms + synonym expansion, OR-ed). Null when no usable terms. */
function matchExpression(query: string): { match: string; expanded: string[] } | null {
  const baseTerms = extractTerms(query.slice(0, 600))
  if (baseTerms.length === 0) return null
  const expanded = expandTerms(baseTerms)
  // Quote each term as a bareword string so FTS5 never parses a term as an
  // operator; OR them so a paraphrase matching on synonyms still ranks.
  return { match: expanded.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), expanded }
}

/**
 * Rows from a ranked query, filtered by `keep`, deepened until `limit` of them
 * survive (obj 900962). `fetch(depth)` returns the best `depth` rows. With no
 * scope this is exactly one fetch. With a scope, a page that came back full
 * but left fewer than `limit` in-scope rows is re-fetched 4x deeper, so decoys
 * outside the caller's scope cannot crowd an in-scope row out of the result.
 * It stops when the index has no more rows, so it always terminates.
 */
function scopedTop<T>(fetch: (depth: number) => T[], keep: ((rows: T[]) => T[]) | null, limit: number, firstDepth: number): T[] {
  let depth = firstDepth
  for (;;) {
    const rows = fetch(depth)
    if (!keep) return rows
    const kept = keep(rows)
    if (kept.length >= limit || rows.length < depth) return kept
    depth *= 4
  }
}

/**
 * Keyword ranking (obj 900816): the FTS5 rows for `query`, workspace-walled,
 * best first, up to `limit`. Used by the hybrid ranker; throws on index errors
 * (callers decide the fallback).
 *
 * `accept` (obj 900962) is the caller's visibility predicate. It is applied
 * INSIDE the ranking, before the top `limit` is taken, together with the
 * workspace wall. Without it and without a workspace, the query and its
 * ordering are what they always were.
 */
export function keywordRanked(query: string, workspace?: string | null, limit = 50, accept?: (path: string) => boolean): KeywordRow[] {
  const root = knowledgeBaseRoot()
  if (!existsSync(root)) return []
  const m = matchExpression(query)
  if (!m) return []
  const db = getIndex(root)
  if (!db) return []
  // bm25() returns a negative score; lower (more negative) is more relevant.
  // Boost title and tags columns over body. Over-fetch so the workspace wall
  // below still leaves `limit` rows.
  const stmt = db.prepare('SELECT path, bm25(docs, 10.0, 5.0, 1.0) AS score FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?')
  // obj 900321 (C13): a workspace argument is a WALL, not a -2.0 bm25 nudge.
  // Out-of-scope docs are removed BEFORE ranking, so no score, stem or synonym
  // expansion can promote another workspace's note into the result set.
  const keep = workspace || accept
    ? (rows: KeywordRow[]) => {
        const walled = workspace ? filterToWorkspaceScope(rows, workspace, root) : rows
        return accept ? walled.filter((r) => accept(r.path)) : walled
      }
    : null
  const ranked = scopedTop((depth) => stmt.all(m.match, depth) as KeywordRow[], keep, limit, workspace ? limit * 6 : limit)
  ranked.sort((a, b) => a.score - b.score)
  return ranked.slice(0, limit)
}

/**
 * Docs that contain each exact token as a phrase (obj 900816): card numbers,
 * IDs, slugs, quoted phrases. FTS tokenises the token the same way it
 * tokenised the docs, so "obj-900816" matches the adjacent tokens obj, 900816.
 * Returns path → how many distinct tokens matched. Never throws.
 * `accept` is the caller's visibility predicate, applied before the per-token
 * caps (obj 900962). Without it the queries are what they always were.
 */
export function exactPhraseMatches(tokens: string[], workspace?: string | null, perToken = 30, accept?: (path: string) => boolean): Map<string, number> {
  const out = new Map<string, number>()
  try {
    const root = knowledgeBaseRoot()
    if (!existsSync(root) || tokens.length === 0) return out
    const db = getIndex(root)
    if (!db) return out
    const stmt = db.prepare('SELECT path FROM docs WHERE docs MATCH ? ORDER BY bm25(docs, 10.0, 5.0, 1.0) LIMIT ?')
    // IDs often live only in the FILE NAME (decisions/2026-11-11-obj900510-….md),
    // so the path is matched too — relative to the root, so the root's own
    // folder names never match.
    const byPath = db.prepare("SELECT path FROM docs WHERE path LIKE ? ESCAPE '\\' LIMIT ?")
    const rootLen = root.endsWith(sep) ? root.length : root.length + 1
    const inScope = (rows: { path: string }[]) => {
      const walled = workspace ? filterToWorkspaceScope(rows, workspace, root) : rows
      return accept ? walled.filter((r) => accept(r.path)) : walled
    }
    // Only a caller predicate deepens these queries; the workspace-only path keeps its old depth.
    const keep = accept ? inScope : null
    for (const t of tokens.slice(0, 8)) {
      const pathHits = new Set<string>()
      if (t.length >= 3) {
        const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        const named = (rows: { path: string }[]) => rows.filter((r) => r.path.slice(rootLen).toLowerCase().includes(t))
        const hits = scopedTop((depth) => byPath.all(like, depth) as { path: string }[], keep ? (rows) => keep(named(rows)) : null, 200, 200)
        for (const r of named(hits)) pathHits.add(r.path)
      }
      const words = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
      let rows: { path: string }[] = []
      if (words.length) {
        try {
          const phrase = `"${words.join(' ')}"`
          rows = scopedTop((depth) => stmt.all(phrase, depth) as { path: string }[], keep, perToken, perToken)
        } catch { rows = [] }
      }
      for (const p of pathHits) if (!rows.some((r) => r.path === p)) rows.push({ path: p })
      const scoped = inScope(rows)
      for (const r of scoped) out.set(r.path, (out.get(r.path) ?? 0) + 1)
    }
  } catch {
    // keyword index unavailable — no exact tier
  }
  return out
}

/** Snippet around the first occurrence of any term (exported for the hybrid ranker). */
export function snippetFor(file: string, terms: string[]): string {
  return makeSnippet(file, terms)
}

/** Query terms incl. synonyms, for snippet placement. */
export function snippetTerms(query: string): string[] {
  return matchExpression(query)?.expanded ?? []
}

/**
 * Semantic search over the vault via FTS5 (BM25 + Porter stemming + synonym
 * expansion). Returns [] on any failure or empty result so the caller can fall
 * back to the grep path. Never throws.
 */
export function searchVaultIndex(query: string, workspace?: string | null): VaultHit[] {
  try {
    const ranked = keywordRanked(query, workspace, MAX_HITS)
    if (ranked.length === 0) return []
    const expanded = snippetTerms(query)
    const hits: VaultHit[] = []
    for (const r of ranked) {
      try {
        hits.push({ path: r.path, snippet: makeSnippet(r.path, expanded) })
      } catch {
        // unreadable — skip
      }
    }
    return hits
  } catch {
    return []
  }
}

/** Test/maintenance hook: drop the cached in-memory index. */
export function resetVaultIndexCache(): void {
  if (cache) {
    try {
      cache.db.close()
    } catch {
      // ignore
    }
    cache = null
  }
}
