import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, Pencil, Search, SearchX } from 'lucide-react'
import { EmptyState } from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import type { Objective, ObjectiveStatus, UpdateObjectiveRequest, Workspace } from '@operationkit/shared'
import { useArchiveLibrary } from '../hooks/useArchiveLibrary'
import { useSlashSearch } from '../hooks/useSlashSearch'
import { useNavigate } from '../context/nav'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { useAuth } from '../context/AuthContext'
import { groupObjectives } from '../lib/groupObjectives'
import { scopeObjectives } from '../lib/scopeObjectives'
import { api } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { AgentMonogram, STATUS_META } from '../components/design/primitives'
import { ObjectiveModal } from '../components/ObjectiveModal'
import { ObjectiveSearchPanel } from '../components/lazy-overlays'
import { SessionViewer } from '../components/SessionViewer'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Button, IconButton, RowButton, SearchInput } from '../components/ui'
import { WorkspaceChip } from '../components/WorkspaceChip'
import { REOPEN_LABEL } from '../lib/statusActions'

type Tab = 'done' | 'cancelled'

function matchesQuery(obj: Objective, q: string): boolean {
  if (!q) return true
  const hay = [
    obj.title,
    obj.project,
    obj.agent_context,
    obj.workspace,
    String(obj.id),
    ...(obj.assigned_usernames ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

export function PreviewArchive({ workspaces }: { workspaces: Workspace[] }) {
  const {
    done, cancelled, doneLoading, cancelledLoading, cancelledLoaded, error, loadCancelled, applyUpdate,
  } = useArchiveLibrary(workspaces)
  const { labelOf } = useWorkspaces()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('done')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useSlashSearch()
  const [sessionObjective, setSessionObjective] = useState<Objective | null>(null)
  const [editingObjective, setEditingObjective] = useState<Objective | null>(null)
  // Defensive: a non-admin member of one org still gets a scoped workspace
  // while selectedWorkspaces is resolving from [] to [org] in App.tsx.
  const searchWorkspace: Workspace = (() => {
    if (workspaces.length === 1) return workspaces[0]
    if (workspaces.length === 0 && user?.role !== 'admin') {
      const userWs = user?.workspaces
      if (userWs?.length === 1) return userWs[0].workspace as Workspace
    }
    return 'all'
  })()

  useEffect(() => {
    if (tab === 'cancelled' && !cancelledLoaded && !cancelledLoading) {
      void loadCancelled()
    }
  }, [tab, cancelledLoaded, cancelledLoading, loadCancelled])

  const source = tab === 'done' ? done : cancelled
  const loading = tab === 'done' ? doneLoading : cancelledLoading

  const { childrenByParent, topLevel } = useMemo(() => {
    const scoped = scopeObjectives(source, workspaces)
    const grouped = groupObjectives(scoped)
    return {
      childrenByParent: grouped.childrenByParent,
      topLevel: grouped.topLevel.filter(o => o.routine_id == null),
    }
  }, [source, workspaces])

  const q = query.trim().toLowerCase()
  const rows = useMemo(
    () => topLevel.filter(o => matchesQuery(o, q)),
    [topLevel, q],
  )

  const openById = useCallback(async (id: number) => {
    try {
      const full = await api.get<Objective>(`/objectives/${id}`)
      setSessionObjective(full)
    } catch {
      /* search result may 404 if RBAC hides it */
    }
  }, [])

  const handleChangeStatus = useCallback(async (id: number, status: ObjectiveStatus) => {
    const updated = await api.patch<Objective>(`/objectives/${id}/status`, { status })
    applyUpdate(updated)
    setSessionObjective(null)
    setEditingObjective(null)
    if (status !== 'done' && status !== 'cancelled') navigate('/')
  }, [navigate, applyUpdate])

  const handleReopen = useCallback((obj: Objective) => {
    const target = obj.status === 'cancelled' ? 'queue' : 'working'
    return handleChangeStatus(obj.id, target)
  }, [handleChangeStatus])

  const handleUpdate = useCallback(async (id: number, data: UpdateObjectiveRequest) => {
    const updated = await api.put<Objective>(`/objectives/${id}`, data)
    applyUpdate(updated)
    return updated
  }, [applyUpdate])

  const handleDelete = useCallback(async (id: number) => {
    await api.del(`/objectives/${id}`)
    applyUpdate({ id, status: 'working' } as Objective)
  }, [applyUpdate])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <h1 className="text-base font-medium text-fg-0">Archive</h1>
        <SegmentedControl
          label="Archive list"
          value={tab}
          onChange={k => setTab(k as Tab)}
          items={[
            { key: 'done', label: 'Done', count: done.length },
            { key: 'cancelled', label: 'Retired', ...(cancelledLoaded ? { count: cancelled.length } : {}) },
          ]}
        />
        <SearchInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={tab === 'done' ? 'Filter done cards…' : 'Filter retired cards…'}
          aria-label="Filter this list"
          wrapClassName="min-w-[180px] max-w-md flex-1"
          className="min-h-8 sm:min-h-8"
        />
        {/* One search story (obj 900807): the same "Search cards /" control as
            the board (every stage). The field beside it only narrows this list. */}
        <Button
          size="sm"
          onClick={() => setSearchOpen(true)}
          aria-label="Search cards"
          title="Search cards — every stage, including done. Press /."
          leftIcon={<Search className="h-4 w-4" />}
        >
          <span className="hidden md:inline">Search cards</span>
          <kbd className="hidden font-mono text-xs text-fg-3 md:inline">/</kbd>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => navigate('/')}>
          Back to board
        </Button>
      </div>

      {error && (
        <div className="border-b border-line px-4 py-2 text-base text-[color:var(--ok-alarm)]">{error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && !loading ? (
          q ? (
            <EmptyState
              icon={<SearchX className="h-5 w-5" aria-hidden="true" />}
              title="No matches"
              description={`Nothing in ${tab === 'done' ? 'Done' : 'Retired'} matches “${query.trim()}”. Try a different word, or search every card.`}
              action={<Button onClick={() => setSearchOpen(true)} leftIcon={<Search className="h-4 w-4" aria-hidden="true" />}>Search all cards</Button>}
            />
          ) : (
            <EmptyState
              icon={<Archive className="h-5 w-5" aria-hidden="true" />}
              title={tab === 'done' ? 'No finished cards yet' : 'No retired cards'}
              description={tab === 'done'
                ? 'Cards you mark done move here, so the board stays about what is still open.'
                : 'Cards you retire from the board are kept here, and you can reopen them any time.'}
              action={<Button onClick={() => navigate('/')}>Back to board</Button>}
            />
          )
        ) : (
          <ul>
            {rows.map(obj => {
              const kids = childrenByParent.get(obj.id) ?? []
              const meta = STATUS_META[obj.status]
              return (
                <li key={obj.id} className="border-b border-line">
                  <div className="flex items-start gap-1 px-2 py-1 hover:bg-surface-3">
                    <RowButton
                      onClick={() => setSessionObjective(obj)}
                      className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-2"
                    >
                      <AgentMonogram agent={obj.agent_context} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-medium text-fg-0">{obj.title || 'Untitled'}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-2">
                          <span className={meta.tone}>{meta.label}</span>
                          {obj.project && <span>{obj.project}</span>}
                          {obj.assigned_usernames && obj.assigned_usernames.length > 0 ? (
                            <span>{obj.assigned_usernames.join(', ')}</span>
                          ) : (
                            <span className="text-fg-3">Unassigned</span>
                          )}
                          {kids.length > 0 && <span>{kids.length} {kids.length === 1 ? 'sub-card' : 'sub-cards'}</span>}
                          {obj.pr_url && <span>#{obj.pr_number ?? 'PR'}</span>}
                          {obj.workspace && <WorkspaceChip label={labelOf(obj.workspace as Workspace)} />}
                        </div>
                      </div>
                      <span className="shrink-0 pt-0.5 text-xs tabular-nums text-fg-3" title={formatDateTime(obj.updated_at).title}>{formatDateTime(obj.updated_at).label}</span>
                    </RowButton>
                    <div className="mt-1.5 flex shrink-0 items-center gap-1">
                      {(obj.status === 'cancelled' || obj.status === 'done') && (
                        <Button size="xs" onClick={() => void handleReopen(obj)}>
                          {REOPEN_LABEL}
                        </Button>
                      )}
                      <IconButton
                        size="sm"
                        label="Edit card"
                        onClick={() => setEditingObjective(obj)}
                        className="text-fg-3"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {loading && (
          <div role="status" aria-busy="true" aria-label={source.length > 0 ? `Loading archive, ${source.length} so far` : 'Loading archive'} data-testid="archive-skeleton">
            {Array.from({ length: source.length > 0 ? 2 : 6 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 border-b border-line px-4 py-3">
                <Skeleton className="h-6 w-6 shrink-0 rounded" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className={i % 2 ? 'h-3.5 w-2/5' : 'h-3.5 w-3/5'} />
                  <Skeleton className="h-3 w-1/3" />
                </div>
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
        )}
        {!loading && q && rows.length !== topLevel.length && (
          <div className="px-4 py-3 text-center text-xs text-fg-3">
            Showing {rows.length} of {topLevel.length}
          </div>
        )}
      </div>

      <ObjectiveSearchPanel
        open={searchOpen}
        workspace={searchWorkspace}
        onClose={() => setSearchOpen(false)}
        onSelect={openById}
      />

      {editingObjective && (
        <ObjectiveModal
          objective={editingObjective}
          workspace={searchWorkspace}
          onClose={() => setEditingObjective(null)}
          onCreate={async () => { throw new Error('create is not available from archive') }}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onReopen={() => {
            if (editingObjective) void handleReopen(editingObjective)
          }}
        />
      )}

      {sessionObjective && (
        <SessionViewer
          objective={sessionObjective}
          chrome="dialog"
          onClose={() => setSessionObjective(null)}
          onChangeStatus={handleChangeStatus}
          onOpenInNewTab={() => window.open(`/o/${sessionObjective.id}`, '_blank', 'noopener')}
          onEdit={() => {
            setEditingObjective(sessionObjective)
            setSessionObjective(null)
          }}
        />
      )}
    </div>
  )
}
