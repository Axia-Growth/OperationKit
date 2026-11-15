// Hybrid knowledge-base search (keyword + semantic) — client types and helpers
// for /api/docs/search, /api/docs/related and the admin /api/admin/kb-search
// status/settings/backfill routes.
import { api } from './api'

export type KbSearchMode = 'hybrid' | 'keyword' | 'semantic'
export type KbMatch = 'exact' | 'both' | 'keyword' | 'semantic'

export interface KbSearchResult {
  path: string
  snippet: string
  score: number
  match: KbMatch
  heading?: string
  line?: number
  keyword_rank?: number | null
  semantic_rank?: number | null
  similarity?: number | null
}

export interface KbSemanticState {
  available: boolean
  reason?: string
}

export interface KbSearchResponse {
  results: KbSearchResult[]
  mode: KbSearchMode
  mode_used: KbSearchMode
  semantic: KbSemanticState
}

export interface KbRelatedItem {
  path: string
  heading: string
  similarity: number
  snippet: string
}

export interface KbRelatedResponse {
  path: string
  related: KbRelatedItem[]
  semantic: KbSemanticState
}

export type KbProvider = 'local' | 'openai' | 'voyage' | 'off'

export interface KbProviderDefaults {
  model: string
  baseUrl: string
  apiKeySecret: string
  dimensions: number
}

export type KbJobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface KbIndexJob {
  id: number
  kind: 'backfill' | 'reembed'
  status: KbJobStatus
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

export interface KbSearchStatus {
  config: {
    provider: KbProvider
    model: string
    base_url: string
    api_key_secret: string
    api_key_configured: boolean | null
    dimensions: number
    model_id: string
    local_model_present: boolean | null
  }
  availability: KbSemanticState
  index: { docs: number; chunks: number; docsCurrentModel: number; dim: number | null }
  job: KbIndexJob | null
  queue: number
  providers: {
    local: KbProviderDefaults
    openai: KbProviderDefaults
    voyage: KbProviderDefaults
    off: null
  }
  reembed?: unknown
}

export interface KbSearchSettingsInput {
  provider: KbProvider
  model: string
  base_url: string
  api_key_secret: string
  dimensions: number | string
}

export const MODE_OPTIONS: Array<{ value: KbSearchMode; label: string }> = [
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'keyword', label: 'Keyword' },
  { value: 'semantic', label: 'Semantic' },
]

export const MATCH_LABEL: Record<KbMatch, string> = {
  exact: 'Exact',
  both: 'Keyword+Meaning',
  keyword: 'Keyword',
  semantic: 'Meaning',
}

export const PROVIDER_LABEL: Record<KbProvider, string> = {
  local: 'Local — offline',
  openai: 'OpenAI-compatible',
  voyage: 'Voyage',
  off: 'Off',
}

export function searchKb(q: string, mode: KbSearchMode, limit = 20, workspace?: string): Promise<KbSearchResponse> {
  const params = new URLSearchParams({ q, mode, limit: String(limit) })
  if (workspace && workspace !== 'all') params.set('workspace', workspace)
  return api.get<KbSearchResponse>(`/docs/search?${params.toString()}`)
}

export function relatedDocs(path: string, limit = 8): Promise<KbRelatedResponse> {
  return api.get<KbRelatedResponse>(`/docs/related?path=${encodeURIComponent(path)}&limit=${limit}`)
}

export const getKbSearchStatus = () => api.get<KbSearchStatus>('/admin/kb-search')
export const saveKbSearchSettings = (body: KbSearchSettingsInput) =>
  api.put<KbSearchStatus>('/admin/kb-search/settings', body)
export const startKbBackfill = () => api.post<{ started: boolean; reason?: string }>('/admin/kb-search/backfill')
export const cancelKbJob = () => api.post<unknown>('/admin/kb-search/cancel')

/** File name without folder or `.md`. */
export function docTitle(p: string): string {
  const base = p.split('/').filter(Boolean).pop() ?? p
  return base.replace(/\.md$/i, '')
}

/** Folder of `p`, relative to `root` when it sits under it. */
export function docFolder(p: string, root?: string): string {
  const dir = p.split('/').slice(0, -1).join('/')
  if (root && (dir === root || dir.startsWith(root + '/'))) return dir.slice(root.length + 1)
  return dir
}

/** `0.033` for a fused/keyword score; `82%` for a semantic similarity. */
export function formatScore(r: Pick<KbSearchResult, 'score' | 'similarity'>, mode: KbSearchMode): string {
  if (mode === 'semantic' && typeof r.similarity === 'number') return formatPct(r.similarity)
  return Number.isFinite(r.score) ? r.score.toFixed(3) : ''
}

export function formatPct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`
}

/** One-line note when semantic search is not doing its share. */
export function degradedNote(res: Pick<KbSearchResponse, 'mode' | 'mode_used' | 'semantic'>): string | null {
  if (res.mode_used === res.mode && res.semantic.available) return null
  if (res.mode === 'keyword' && res.mode_used === 'keyword') return null
  const reason = res.semantic.reason?.trim() || 'Semantic search is unavailable'
  if (res.mode_used !== 'keyword') return reason
  return `${reason.replace(/\.$/, '')} — showing keyword results`
}

/** SQLite `datetime('now')` (UTC, no zone) or ISO → a local date-time label. */
export function formatJobTime(s: string | null | undefined): string {
  if (!s) return ''
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
