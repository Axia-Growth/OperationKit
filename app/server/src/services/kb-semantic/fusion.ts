/**
 * Hybrid ranking for knowledge-base search (obj 900816).
 *
 * Two rankers run over the same knowledge base:
 *   - KEYWORD: the existing FTS5 index (BM25 + Porter + synonyms, vault-index.ts)
 *   - SEMANTIC: nearest chunks by embedding (sqlite-vec), rolled up to the doc
 *
 * and are fused with Reciprocal Rank Fusion: score(d) = Σ wᵢ / (k + rankᵢ(d)).
 * RRF uses ranks only, so the two scorers never have to be calibrated against
 * each other (BM25 is unbounded, cosine distance is in [0, 2]).
 *
 * EXACT MATCHES WIN. A query that names a card number, an ID, a file/slug or a
 * quoted phrase is asking for THAT thing, and a semantically "close" note must
 * never outrank it. Any doc that literally contains an exact token from the
 * query is placed in a tier above every fused result (ordered by how many exact
 * tokens it holds, then by its keyword rank). Pure functions; no I/O.
 */

export const RRF_K = 60

export interface FuseInput {
  /** Doc keys in keyword-rank order (best first). */
  keyword: string[]
  /** Doc keys in semantic-rank order (best first). */
  semantic: string[]
  /** Doc keys that literally contain exact query tokens → how many distinct tokens each holds. */
  exact?: Map<string, number>
  k?: number
  keywordWeight?: number
  semanticWeight?: number
}

export interface FusedHit {
  key: string
  /** Fused score; higher is better. Exact-tier docs carry +1 so the number sorts the same way as the list. */
  score: number
  keywordRank: number | null
  semanticRank: number | null
  exact: boolean
  /** Which ranker(s) found it. */
  match: 'exact' | 'both' | 'keyword' | 'semantic'
}

export function fuseRankings(input: FuseInput): FusedHit[] {
  const k = input.k ?? RRF_K
  const wk = input.keywordWeight ?? 1
  const ws = input.semanticWeight ?? 1
  const exact = input.exact ?? new Map<string, number>()
  const kwRank = new Map<string, number>()
  input.keyword.forEach((key, i) => { if (!kwRank.has(key)) kwRank.set(key, i + 1) })
  const semRank = new Map<string, number>()
  input.semantic.forEach((key, i) => { if (!semRank.has(key)) semRank.set(key, i + 1) })

  const keys = new Set<string>([...kwRank.keys(), ...semRank.keys(), ...exact.keys()])
  const hits: FusedHit[] = []
  for (const key of keys) {
    const kr = kwRank.get(key) ?? null
    const sr = semRank.get(key) ?? null
    let score = 0
    if (kr !== null) score += wk / (k + kr)
    if (sr !== null) score += ws / (k + sr)
    const isExact = (exact.get(key) ?? 0) > 0
    hits.push({
      key,
      score: isExact ? 1 + score : score,
      keywordRank: kr,
      semanticRank: sr,
      exact: isExact,
      match: isExact ? 'exact' : kr !== null && sr !== null ? 'both' : kr !== null ? 'keyword' : 'semantic',
    })
  }
  hits.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1
    if (a.exact && b.exact) {
      const d = (exact.get(b.key) ?? 0) - (exact.get(a.key) ?? 0)
      if (d !== 0) return d
      const ar = a.keywordRank ?? Number.MAX_SAFE_INTEGER
      const br = b.keywordRank ?? Number.MAX_SAFE_INTEGER
      if (ar !== br) return ar - br
    }
    if (b.score !== a.score) return b.score - a.score
    return a.key.localeCompare(b.key)
  })
  return hits
}

/**
 * Tokens in a query that ask for an exact thing rather than a topic:
 *   - card / issue numbers: `#900816`, `900816`, `obj-900816` (3+ digits)
 *   - identifiers: anything mixing letters with digits, `-`, `_`, `.` or `/`
 *     (`sqlite-vec`, `kb_embed_provider`, `self-deploy.sh`, `v0.1.9`)
 *   - quoted or backticked phrases: "reciprocal rank fusion", `write_doc`
 *   - names: 2+ consecutive Capitalised words (`Dana Ruiz`), or an ALL-CAPS /
 *     camelCase word (`GHL`, `EmailBison`)
 * Returned lower-cased, de-duplicated, longest first.
 */
export function exactTokens(query: string): string[] {
  const out = new Set<string>()
  const q = query.slice(0, 600)
  for (const m of q.matchAll(/"([^"]{2,80})"|`([^`]{2,80})`|“([^”]{2,80})”/g)) out.add((m[1] ?? m[2] ?? m[3]).trim().toLowerCase())
  const unquoted = q.replace(/"[^"]*"|`[^`]*`|“[^”]*”/g, ' ')
  for (const raw of unquoted.split(/\s+/)) {
    const w = raw.replace(/^[^\w#]+|[^\w]+$/g, '')
    if (!w) continue
    const num = w.match(/^#?(\d{3,})$/)
    if (num) { out.add(num[1]); continue }
    if (/^[\w./-]+$/.test(w) && /[a-z]/i.test(w) && (/\d/.test(w) || /[\w][-_./][\w]/.test(w)) && w.length >= 3) {
      out.add(w.toLowerCase())
      continue
    }
    if (/^[A-Z]{3,}[A-Z0-9]*$/.test(w) || /^[A-Z]?[a-z]+[A-Z][A-Za-z]*$/.test(w)) out.add(w.toLowerCase())
  }
  for (const m of unquoted.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
    const words = m[1].split(/\s+/)
    while (words.length && SENTENCE_STARTERS.has(words[0].toLowerCase())) words.shift()
    if (words.length >= 2) out.add(words.join(' ').toLowerCase())
  }
  return [...out].sort((a, b) => b.length - a.length)
}

const SENTENCE_STARTERS = new Set([
  'what', 'how', 'why', 'when', 'where', 'who', 'which', 'is', 'are', 'do', 'does', 'did',
  'the', 'a', 'an', 'show', 'find', 'list', 'give', 'tell', 'can', 'should', 'my', 'our',
])

/**
 * How many of `tokens` appear literally (case-insensitive) in `haystack`, as a
 * WHOLE token: "cto" must not match "factor", "442" must not match "14421".
 * A number may follow letters ("900510" matches "obj900510", the way IDs are
 * written in file names) but never sits inside a longer number.
 */
export function countExact(haystack: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const h = haystack.toLowerCase()
  let n = 0
  for (const t of tokens) if (containsToken(h, t)) n++
  return n
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const tokenRes = new Map<string, RegExp>()

function containsToken(h: string, t: string): boolean {
  let re = tokenRes.get(t)
  if (!re) {
    const before = /^\d+$/.test(t) ? '(?<![0-9])' : '(?<![a-z0-9])'
    re = new RegExp(`${before}${esc(t).replace(/\s+/g, '\\s+')}(?![a-z0-9])`)
    if (tokenRes.size > 500) tokenRes.clear()
    tokenRes.set(t, re)
  }
  return re.test(h)
}
