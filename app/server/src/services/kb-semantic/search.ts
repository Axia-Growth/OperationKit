/**
 * Hybrid knowledge-base search (obj 900816): FTS5 keyword + sqlite-vec semantic,
 * fused with Reciprocal Rank Fusion, exact matches first.
 *
 * Modes:
 *   hybrid   (default) keyword ∪ semantic, RRF-fused; docs holding an exact
 *            query token (card number, ID, slug, quoted phrase) are pinned on top.
 *            Degrades to keyword when semantic is unavailable (`mode_used` says so).
 *   keyword  the pre-existing FTS5 ranking, grep fallback — unchanged behaviour.
 *   semantic nearest chunks only.
 *
 * Scoping: the workspace argument is a WALL (realpath containment via
 * filterToWorkspaceScope) applied to both rankers before fusion, and the
 * caller's `allow` predicate (read roots, agent-key workspaces) is applied
 * before the limit, so a hidden doc can never take a slot or leak a snippet.
 * Both are applied INSIDE each ranker, before its top-N is taken (obj 900962):
 * the keyword rows and nearest chunks are the best N the caller may see, not
 * the best N of the whole knowledge base filtered afterwards.
 */
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { getDb } from '../../db/index.js'
import { knowledgeBaseRoot } from '../../lib/knowledge-base-root.js'
import { filterToWorkspaceScope, isValidWorkspaceSlug } from '../../lib/kb-workspace-scope.js'
import { exactPhraseMatches, keywordRanked, snippetFor, snippetTerms } from '../vault-index.js'
import { searchKnowledgeGrep } from '../knowledge-search.js'
import { countExact, exactTokens, fuseRankings } from './fusion.js'
import type { EmbeddingProvider } from './providers.js'
import { docVectors, knnChunks, vecReady, type ChunkHit } from './store.js'
import { activeProvider, semanticAvailability, type SemanticAvailability } from './service.js'
import { withoutHeldAnswers } from '../../lib/kb-answer-hold.js'

export type SearchMode = 'hybrid' | 'keyword' | 'semantic'
export const SEARCH_MODES: SearchMode[] = ['hybrid', 'keyword', 'semantic']

export function parseSearchMode(v: unknown): SearchMode | null {
  if (v === undefined || v === null || v === '') return 'hybrid'
  return typeof v === 'string' && (SEARCH_MODES as string[]).includes(v) ? v as SearchMode : null
}

export interface KbSearchHit {
  path: string
  snippet: string
  /** Fused score, higher = better. Exact-tier hits are ≥ 1. */
  score: number
  /** Which ranker(s) found it. */
  match: 'exact' | 'both' | 'keyword' | 'semantic'
  /** Heading trail of the best-matching chunk (semantic hits). */
  heading?: string
  /** 1-based line of the best-matching chunk. */
  line?: number
  keyword_rank?: number | null
  semantic_rank?: number | null
  /** Cosine similarity of the best chunk, 0..1. */
  similarity?: number | null
}

export interface KbSearchResult {
  results: KbSearchHit[]
  mode: SearchMode
  mode_used: SearchMode
  semantic: SemanticAvailability
}

export interface SearchOptions {
  mode?: SearchMode
  workspace?: string | null
  limit?: number
  /** Extra visibility predicate (read roots, agent-key workspaces). Applied before the limit. */
  allow?: (path: string) => boolean
  /** Injection for tests / evals. */
  db?: Database.Database
  provider?: EmbeddingProvider | null
  root?: string
  /**
   * Minimum cosine similarity (0..1) for a semantic hit to count as relevant
   * (issue #134). Chunks below it are dropped before fusion, so an unrelated
   * note never rides the KNN into the results; keyword/exact hits are unaffected.
   * Default DEFAULT_MIN_SIMILARITY (0.2). 0 disables the floor.
   */
  minSimilarity?: number
}

const SNIPPET_CHARS = 400
const KEYWORD_DEPTH = 50
const KNN_CHUNKS = 150
/** Cosine-similarity floor for semantic hits (issue #134); 0.2 ≈ "shares the topic". */
export const DEFAULT_MIN_SIMILARITY = 0.2

function chunkSnippet(c: ChunkHit): string {
  const t = c.text.replace(/\s+/g, ' ').trim()
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t
}

/** `scoped` = the caller passed a predicate; without one the ranker queries are the unscoped ones. */
interface Scope { allow: (p: string) => boolean; scoped: boolean }

function keywordList(query: string, workspace: string | null | undefined, { allow, scoped }: Scope): string[] {
  let rows: string[] = []
  try {
    rows = keywordRanked(query, workspace, KEYWORD_DEPTH, scoped ? allow : undefined).map(r => r.path)
  } catch { rows = [] }
  if (rows.length === 0) rows = searchKnowledgeGrep(query, workspace).map(h => h.path)
  return rows.filter(allow)
}

async function semanticList(
  query: string, workspace: string | null | undefined, { allow, scoped }: Scope,
  db: Database.Database, provider: EmbeddingProvider, root: string, minSimilarity: number,
): Promise<{ paths: string[]; best: Map<string, ChunkHit> }> {
  const [qv] = await provider.embed([query.slice(0, 2000)], 'query')
  let chunks = knnChunks(db, qv, KNN_CHUNKS, provider.modelId, workspace ? [workspace] : undefined, inScope(workspace, scoped ? allow : undefined, root))
  // issue #134: drop chunks below the similarity floor before the per-doc dedupe.
  if (minSimilarity > 0) chunks = chunks.filter(c => 1 - c.distance >= minSimilarity)
  if (workspace) chunks = filterToWorkspaceScope(chunks, workspace, root)
  const best = new Map<string, ChunkHit>()
  for (const c of chunks) {
    if (!best.has(c.path) && allow(c.path)) best.set(c.path, c)
  }
  return { paths: [...best.keys()], best }
}

/** Workspace wall + caller predicate as one path test for the vector query; undefined when there is no scope at all. */
function inScope(workspace: string | null | undefined, allow: ((p: string) => boolean) | undefined, root: string): ((p: string) => boolean) | undefined {
  if (!workspace && !allow) return undefined
  return (p) => (!workspace || filterToWorkspaceScope([{ path: p }], workspace, root).length > 0) && (!allow || allow(p))
}

function readHead(p: string): string {
  try { return fs.readFileSync(p, 'utf8').slice(0, 65536) } catch { return '' }
}

export async function searchKnowledgeBase(query: string, opts: SearchOptions = {}): Promise<KbSearchResult> {
  const mode = opts.mode ?? 'hybrid'
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 50))
  const workspace = opts.workspace || null
  // A saved answer held for review (obj 901746) never takes a slot or shows a snippet.
  const allow = withoutHeldAnswers(opts.allow)
  const scope: Scope = { allow, scoped: !!opts.allow }
  // realpath when the root exists (macOS /var → /private/var); a missing root stays
  // lexical so the rankers below degrade to empty results instead of throwing ENOENT.
  const rootArg = opts.root ?? knowledgeBaseRoot()
  const root = fs.existsSync(rootArg) ? fs.realpathSync(rootArg) : path.resolve(rootArg)
  const minSimilarity = Math.max(0, Math.min(opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY, 1))
  const q = query.trim()
  if (workspace && !isValidWorkspaceSlug(workspace)) return { results: [], mode, mode_used: mode, semantic: { available: false, reason: 'invalid workspace' } }

  const provider = opts.provider !== undefined ? opts.provider : activeProvider()
  const db = opts.db ?? (provider ? getDb() : null)
  let semantic: SemanticAvailability = opts.provider !== undefined
    ? (provider ? { available: true } : { available: false, reason: 'off' })
    : semanticAvailability()
  if (semantic.available && db && !vecReady(db)) semantic = { available: false, reason: 'The knowledge base has not been embedded yet (Jobs → Knowledge index).' }

  const wantsSemantic = mode !== 'keyword' && semantic.available && !!provider && !!db
  const kw = mode === 'semantic' ? [] : keywordList(q, workspace, scope)
  let sem: { paths: string[]; best: Map<string, ChunkHit> } = { paths: [], best: new Map() }
  if (wantsSemantic) {
    try {
      sem = await semanticList(q, workspace, scope, db!, provider!, root, minSimilarity)
    } catch (err) {
      semantic = { available: false, reason: `Semantic search failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
  const modeUsed: SearchMode = mode === 'keyword' ? 'keyword' : semantic.available ? mode : 'keyword'
  const terms = snippetTerms(q)

  if (modeUsed === 'keyword' && mode !== 'semantic') {
    const results = kw.slice(0, limit).map((p, i) => ({
      path: p, snippet: safeSnippet(p, terms), score: round(1 / (60 + i + 1)), match: 'keyword' as const, keyword_rank: i + 1, semantic_rank: null,
    }))
    return { results, mode, mode_used: 'keyword', semantic }
  }
  if (mode === 'semantic' && !semantic.available) return { results: [], mode, mode_used: 'semantic', semantic }

  // Exact tier: FTS phrase matches for exact tokens, plus a literal check of
  // every candidate (file path + content) so "#900816" or "sqlite-vec" in a
  // note always lands it on top.
  let exact = new Map<string, number>()
  if (mode === 'hybrid') {
    const tokens = exactTokens(q)
    if (tokens.length) {
      const phrase = exactPhraseMatches(tokens, workspace, 30, opts.allow ? allow : undefined)
      const candidates = new Set([...kw.slice(0, 30), ...sem.paths.slice(0, 30), ...phrase.keys()])
      for (const p of candidates) {
        if (!allow(p)) continue
        // Relative path, so the knowledge-base root's own folder names never count.
        const rel = path.relative(root, p)
        // A token in the FILE NAME counts double: "obj719092" means the note named for it,
        // ahead of a log that merely mentions it.
        const n = countExact(`${rel}\n${readHead(p)}`, tokens) + countExact(rel, tokens)
        if (n > 0) exact.set(p, n)
      }
    }
  }
  const fused = fuseRankings({ keyword: kw, semantic: sem.paths, exact })
  const results: KbSearchHit[] = []
  for (const f of fused) {
    if (results.length >= limit) break
    if (!allow(f.key)) continue
    const best = sem.best.get(f.key)
    const snippet = f.match === 'semantic' && best ? chunkSnippet(best) : safeSnippet(f.key, terms, best)
    if (snippet === null) continue
    results.push({
      path: f.key,
      snippet,
      score: round(f.score),
      match: f.match,
      ...(best ? { heading: best.heading, line: best.line } : {}),
      keyword_rank: f.keywordRank,
      semantic_rank: f.semanticRank,
      similarity: best ? round(1 - best.distance) : null,
    })
  }
  return { results, mode, mode_used: modeUsed, semantic }
}

function safeSnippet(p: string, terms: string[], fallback?: ChunkHit): string {
  try {
    return snippetFor(p, terms)
  } catch {
    return fallback ? chunkSnippet(fallback) : ''
  }
}

const round = (n: number) => Math.round(n * 10000) / 10000

/**
 * Docs most similar to `docPath` (mean of its chunk vectors → nearest chunks →
 * rolled up per doc, self excluded). [] when semantic is unavailable.
 */
export async function relatedDocs(docPath: string, opts: { workspace?: string | null; limit?: number; allow?: (p: string) => boolean; db?: Database.Database; provider?: EmbeddingProvider | null; root?: string } = {}): Promise<Array<{ path: string; heading: string; similarity: number; snippet: string }>> {
  const provider = opts.provider !== undefined ? opts.provider : activeProvider()
  if (!provider) return []
  const db = opts.db ?? getDb()
  if (!vecReady(db)) return []
  const vecs = docVectors(db, docPath)
  if (vecs.length === 0) return []
  const mean = new Float32Array(vecs[0].length)
  for (const v of vecs) for (let i = 0; i < v.length; i++) mean[i] += v[i]
  let n = 0
  for (let i = 0; i < mean.length; i++) n += mean[i] * mean[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < mean.length; i++) mean[i] /= n
  const allow = withoutHeldAnswers(opts.allow)
  const root = opts.root ?? knowledgeBaseRoot()
  let chunks = knnChunks(db, mean, 120, provider.modelId, opts.workspace ? [opts.workspace] : undefined, inScope(opts.workspace, opts.allow ? allow : undefined, root))
  // issue #134: same floor as search — "related" should mean actually related.
  chunks = chunks.filter(c => 1 - c.distance >= DEFAULT_MIN_SIMILARITY)
  if (opts.workspace) chunks = filterToWorkspaceScope(chunks, opts.workspace, root)
  const out: Array<{ path: string; heading: string; similarity: number; snippet: string }> = []
  const seen = new Set<string>([docPath])
  for (const c of chunks) {
    if (seen.has(c.path) || !allow(c.path)) continue
    seen.add(c.path)
    out.push({ path: c.path, heading: c.heading, similarity: round(1 - c.distance), snippet: chunkSnippet(c).slice(0, 200) })
    if (out.length >= (opts.limit ?? 8)) break
  }
  return out
}
