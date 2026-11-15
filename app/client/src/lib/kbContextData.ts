/* Context's data, as cached resources (obj 900867).

   The page tree, the "is file import on" flag and each workspace's graph are
   KbResourceSpecs: rendered from the per-user cache first, revalidated in the
   background (lib/kbResource.ts). `prefetchContext()` warms all of it — plus
   the page's code — when the pointer reaches the Context nav link, so even a
   first visit starts with its data in flight. */
import { api } from './api'
import { readKbCache, writeKbCache } from './kbCache'
import { prefetchKb, type KbResourceSpec } from './kbResource'
import type { WorkspaceGraphResponse } from './kbWiki'
import { wikiApi, wsQuery } from '../components/kb-wiki/wikiApi'

export interface KbTreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: KbTreeNode[]
}

export interface KnowledgeFolder {
  path: string
  label: string
}

/** GET /api/docs/tree — the one knowledge base (obj 720348); there is no source picker. */
export interface KbTreeResponse {
  root: string
  folders?: KnowledgeFolder[]
  writeRoots: string[]
  tree: KbTreeNode[]
}

export const KB_TREE: KbResourceSpec<KbTreeResponse> = {
  key: 'docs-tree',
  load: () => api.get<KbTreeResponse>('/docs/tree'),
}

/** Whether the knowledge-import starter pack is on (it also gates the Graph view). */
export const KB_IMPORT_ENABLED: KbResourceSpec<boolean> = {
  key: 'kb-import-enabled',
  load: () =>
    fetch('/api/kb-ingest/enabled', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : { pack_enabled: false }))
      .then((b: { pack_enabled?: unknown }) => b.pack_enabled === true),
}

export function kbGraphSpec(workspace: string): KbResourceSpec<WorkspaceGraphResponse> {
  return { key: `graph:${workspace}`, load: () => wikiApi<WorkspaceGraphResponse>(`/graph?${wsQuery(workspace)}`) }
}

// ── The graph's last workspace and layout ────────────────────────────────────

const LAST_GRAPH_WORKSPACE = 'graph-last-workspace'

/** The workspace whose graph was shown last — lets a return visit start the graph before the workspace list loads. */
export function lastGraphWorkspace(): string {
  const v = readKbCache<string>(LAST_GRAPH_WORKSPACE)?.value
  return typeof v === 'string' ? v : ''
}

export function rememberGraphWorkspace(ws: string): void {
  if (ws && lastGraphWorkspace() !== ws) writeKbCache(LAST_GRAPH_WORKSPACE, ws)
}

/** A finished layout: the graph signature it belongs to and every page's position. */
export interface SavedLayout {
  sig: string
  pos: Record<string, [number, number]>
}

const layoutKey = (ws: string) => `layout:${ws}`

export function savedLayout(ws: string): SavedLayout | null {
  const v = readKbCache<SavedLayout>(layoutKey(ws))?.value
  return v && typeof v.sig === 'string' && v.pos && typeof v.pos === 'object' ? v : null
}

export function saveLayout(ws: string, layout: SavedLayout): void {
  writeKbCache(layoutKey(ws), layout)
}

// ── Prefetch ─────────────────────────────────────────────────────────────────

let pageChunk: Promise<unknown> | null = null

/** Start loading the Context page's code (idempotent). */
export function preloadContextPage(): Promise<unknown> {
  if (!pageChunk) pageChunk = import('../components/DocsPage').catch(() => { pageChunk = null })
  return pageChunk
}

/**
 * Hover / focus / touch on the Context link: fetch the page's code, its tree,
 * the import flag and the last-shown workspace's graph in parallel. Anything
 * fetched in the last 15 s is not asked for again.
 */
export function prefetchContext(): void {
  void preloadContextPage()
  void prefetchKb(KB_TREE)
  void prefetchKb(KB_IMPORT_ENABLED)
  const ws = lastGraphWorkspace()
  if (ws) void prefetchKb(kbGraphSpec(ws))
}
