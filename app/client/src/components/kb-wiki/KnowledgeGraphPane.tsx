import { useEffect, useState } from 'react'
import { Network } from 'lucide-react'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { WorkspaceGraph } from './WorkspaceGraph'
import { Select } from '../ui/Select'
import { Skeleton } from '../ui'
import { lastGraphWorkspace, rememberGraphWorkspace } from '../../lib/kbContextData'

/* KnowledgeGraphPane (obj 900674) — the Knowledge base page's default view:
   the Obsidian-style graph of how every page in a workspace connects. Shown
   whenever no page is open, and from the toolbar's "Graph" toggle. Clicking a
   dot opens that page in the page's own editor. */
export function KnowledgeGraphPane({
  workspace,
  onOpenPath,
  refreshKey = 0,
}: {
  /** The board's workspace selection; 'all' lets the user pick one here. */
  workspace: string
  /** Open an absolute page path in the editor. */
  onOpenPath: (absPath: string) => void
  refreshKey?: number
}) {
  const { slugs, labelOf } = useWorkspaces()
  // Board selection wins when it names one workspace. Otherwise start on the
  // workspace shown last (obj 900867) — its graph is cached and can be drawn
  // before the workspace list arrives — and fall back to the first one this
  // user has once the list says that one is gone.
  const [ws, setWs] = useState(() => (workspace && workspace !== 'all' ? workspace : lastGraphWorkspace()))

  useEffect(() => {
    if (workspace && workspace !== 'all') setWs(workspace)
    else if ((!ws || !slugs.includes(ws)) && slugs.length) setWs(slugs[0])
  }, [workspace, slugs, ws])

  useEffect(() => { if (ws) rememberGraphWorkspace(ws) }, [ws])

  // Let the page shell and tree paint first; the graph (thousands of SVG nodes,
  // even when drawn straight from the cache) mounts one frame later (obj 900867).
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const picker = slugs.length > 1 && workspace === 'all'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight text-fg-0">
            <Network className="h-4 w-4 text-accent" aria-hidden="true" />
            How your Context connects
          </h2>
          <p className="max-w-[72ch] text-sm leading-relaxed text-fg-2">
            Every page is a dot; every link, mention, source and saved answer between two pages is a line.
          </p>
        </div>
        {picker && (
          <label className="flex items-center gap-2 text-sm text-fg-2">
            Workspace
            <Select
              aria-label="Workspace"
              value={ws}
              onChange={v => setWs(v)}
            >
              {slugs.map(s => <option key={s} value={s}>{labelOf(s)}</option>)}
            </Select>
          </label>
        )}
      </div>
      {ws && !mounted && (
        <div className="flex flex-col gap-3" aria-busy="true">
          <span className="sr-only">Loading the graph…</span>
          <Skeleton className="h-9 w-full sm:w-72" />
          <Skeleton className="h-[420px] w-full rounded-md sm:h-[560px]" />
        </div>
      )}
      {ws && mounted && (
        <WorkspaceGraph
          workspace={ws}
          fill
          refreshKey={refreshKey}
          onOpenNote={(rel, root) => { if (root) onOpenPath(`${root.replace(/\/+$/, '')}/${rel}`) }}
        />
      )}
    </div>
  )
}
