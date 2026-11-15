import { useCallback, useEffect, useMemo, useState } from 'react'
import { commandPaletteShortcut } from '../lib/platform'
import { Archive, Inbox, ListChecks, Plus, Search, Workflow } from 'lucide-react'
import { EmptyState } from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import { BoardSkeleton } from './BoardSkeleton'
import {
  OBJECTIVE_STATUSES,
  type Objective,
  type ObjectiveStatus,
  type Workspace,
} from '@operationkit/shared'
import { useObjectives } from '../hooks/useObjectives'
import { useSlashSearch } from '../hooks/useSlashSearch'
import { useIsBoardMobile } from '../hooks/useMediaQuery'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from '../context/nav'
import { groupObjectives } from '../lib/groupObjectives'
import { scopeObjectives } from '../lib/scopeObjectives'
import { boardColumnOf, orderBoardColumns } from '../lib/boardColumns'
import {
  UNASSIGNED_TOKEN,
  matchesAssigneeFilter,
  assigneeRoster,
  botRoster,
  defaultAssigneeSelection,
  loadAssigneeSelection,
  saveAssigneeSelection,
} from '../lib/assigneeFilter'
import {
  ALL_PROJECTS,
  matchesProjectFilter,
  loadProjectSelection,
  saveProjectSelection,
  type ProjectSelection,
} from '../lib/projectFilter'
import { useProjects, ALL_ORGS } from '../hooks/useProjects'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { ProjectFilterBar } from '../components/ProjectFilterBar'
import { OwnerFilterSelect } from '../components/OwnerFilterSelect'
import { api } from '../lib/api'
import { STATUS_META } from '../components/design/primitives'
import { SessionViewer } from '../components/SessionViewer'
import { ObjectiveModal } from '../components/ObjectiveModal'
import { ObjectiveSearchPanel } from '../components/lazy-overlays'
import { NewWorkflowDialog } from '../components/jobs/NewWorkflowDialog'
import { Button, Eyebrow } from '../components/ui'
import { PreviewCard } from './PreviewCard'
import { NeedsYouTriageBar } from '../components/NeedsYouTriageBar'
import { pruneSelection, toggleSelection } from '../lib/triage'
import { ColumnScroller } from './ColumnScroller'

interface PreviewBoardProps {
  /** Selected org slugs. Empty = All organizations. */
  workspaces: Workspace[]
}

/** Empty-column copy (polish F8): a calm line about what lands here, instead
 *  of a blank strip under the column header. */
const COLUMN_EMPTY: Record<ObjectiveStatus, { title: string; description: string }> = {
  planning: { title: 'Nothing in planning', description: 'Cards being scoped land here.' },
  queue: { title: 'Queue is empty', description: 'New cards wait here until a session starts.' },
  working: { title: 'Nothing running', description: 'Cards with a live session show up here.' },
  ai_review: { title: 'Nothing in AI review', description: 'Finished work is checked here before it reaches you.' },
  review: { title: 'Nothing needs you', description: 'Cards waiting on your decision land here.' },
  done: { title: 'Nothing done yet', description: 'Finished cards collect here.' },
  cancelled: { title: 'Nothing retired', description: 'Retired cards collect here.' },
}

export function PreviewBoard({ workspaces }: PreviewBoardProps) {
  const {
    objectives, loading, error, changeStatus, connectionState,
    createObjective, updateObjective, deleteObjective,
    doneObjectives, doneLoading, doneLoaded, doneHasMore, loadMoreDone,
  } = useObjectives(workspaces)
  const isMobile = useIsBoardMobile()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [sessionObjective, setSessionObjective] = useState<Objective | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingObjective, setEditingObjective] = useState<Objective | null>(null)
  const [searchOpen, setSearchOpen] = useSlashSearch()
  // For a non-admin member of exactly one org, effectiveOrg is that org even
  // when selectedWorkspaces is still [] (the brief window between auth
  // resolving and the App.tsx clamp effect firing).  Admins are kept on their
  // selected value.
  const effectiveOrg: Workspace | null = (() => {
    if (workspaces.length === 1) return workspaces[0]
    if (workspaces.length === 0 && user?.role !== 'admin') {
      const userWs = user?.workspaces
      if (userWs?.length === 1) return userWs[0].workspace as Workspace
    }
    return null
  })()
  const modalWorkspace: Workspace = effectiveOrg ?? 'all'
  const wsKey = workspaces.slice().sort().join(',')

  const [assigneeSel, setAssigneeSel] = useState<string[]>(
    () => loadAssigneeSelection(wsKey || 'all') ?? defaultAssigneeSelection(user?.username)
  )
  useEffect(() => {
    setAssigneeSel(loadAssigneeSelection(wsKey || 'all') ?? defaultAssigneeSelection(user?.username))
  }, [wsKey, user?.username])

  const selectedAssignees = useMemo(() => new Set(assigneeSel), [assigneeSel])

  // ── Project (organization subfolder) filter — obj 708826 ─────────────────
  // A project belongs to exactly ONE organization, so the picker only appears
  // in a single-org view. The selection is stored under the workspace key,
  // which is also what makes it reset on an org switch: the new org reads its
  // own (usually empty) slot and falls back to All projects.
  const projectWorkspace = effectiveOrg
  // obj 900197: the project row used to vanish whenever the board spanned more
  // than one org (`projectWorkspace` null), which is the default
  // All-Organizations view — so most of the time there was no project filter at
  // all. Now the scope follows the board: one org → that org, a multi-select →
  // those orgs, All → every org the caller can access.
  const projectScope = projectWorkspace ?? (workspaces.length > 0 ? workspaces : ALL_ORGS)
  const {
    projects, refresh: refreshProjects, createProject, renameProject, deleteProject,
  } = useProjects(projectScope)
  const [projectSel, setProjectSel] = useState<ProjectSelection>(
    () => loadProjectSelection(wsKey || 'all') ?? ALL_PROJECTS
  )
  useEffect(() => {
    setProjectSel(loadProjectSelection(wsKey || 'all') ?? ALL_PROJECTS)
  }, [wsKey])
  const selectProject = useCallback((next: ProjectSelection) => {
    setProjectSel(next)
    saveProjectSelection(wsKey || 'all', next)
  }, [wsKey])
  // Saving an objective can move it into or out of a project, which changes the
  // per-chip objective counts — re-read them rather than leaving a stale number
  // on the chip the user just filled.
  const createObjectiveInProject = useCallback(async (data: Parameters<typeof createObjective>[0]) => {
    const created = await createObjective(data)
    void refreshProjects()
    return created
  }, [createObjective, refreshProjects])
  const updateObjectiveInProject = useCallback(async (id: number, data: Parameters<typeof updateObjective>[1]) => {
    const updated = await updateObjective(id, data)
    void refreshProjects()
    return updated
  }, [updateObjective, refreshProjects])
  // A stored id can outlive its project (deleted here or in another tab) — fall
  // back to All rather than showing an empty board with no visible cause.
  useEffect(() => {
    if (typeof projectSel !== 'number') return
    if (projects.length === 0) return
    if (!projects.some(p => p.id === projectSel)) selectProject(ALL_PROJECTS)
  }, [projects, projectSel, selectProject])

  // ── Organizations (obj 900197; the switcher moved to the top bar in obj 900666)───────────────────────────────
  // Admins see every active org; a member sees only the ones they belong to.
  const { workspaces: orgRecords, shortOf: orgShortOf, labelOf: orgLabelOf } =
    useWorkspaces()
  // "New workflow" (obj 900642, card B6): a goal → a builder card on this board.
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const isAdmin = user?.role === 'admin'
  const orgOptions = useMemo(() => {
    const memberSlugs = new Set((user?.workspaces ?? []).map(w => w.workspace))
    return orgRecords
      .filter(w => isAdmin || memberSlugs.has(w.slug))
      .map(w => ({ slug: w.slug, label: w.name || w.slug }))
  }, [orgRecords, isAdmin, user?.workspaces])

  const toggleAssignee = useCallback((token: string) => {
    setAssigneeSel(prev => {
      const next = prev.includes(token) ? prev.filter(t => t !== token) : [...prev, token]
      saveAssigneeSelection(wsKey || 'all', next)
      return next
    })
  }, [wsKey])

  useEffect(() => {
    if (!loading && !doneLoaded && !doneLoading) loadMoreDone()
  }, [loading, doneLoaded, doneLoading, loadMoreDone])

  const { childrenByParent, topLevel } = useMemo(() => {
    const live = groupObjectives(scopeObjectives(objectives, workspaces))
    const done = groupObjectives(scopeObjectives(doneObjectives, workspaces))
    const byParent = new Map(live.childrenByParent)
    for (const [id, kids] of done.childrenByParent) {
      const existing = byParent.get(id) || []
      byParent.set(id, [...existing, ...kids.filter(k => !existing.some(e => e.id === k.id))])
    }
    return {
      childrenByParent: byParent,
      topLevel: live.topLevel.filter(o => o.routine_id == null),
    }
  }, [objectives, doneObjectives, workspaces])

  const assigneeOptions = useMemo(() => {
    const roster = assigneeRoster([...topLevel, ...doneObjectives])
    if (user?.username && !roster.includes(user.username)) {
      roster.push(user.username)
      roster.sort((a, b) => a.localeCompare(b))
    }
    return roster
  }, [topLevel, doneObjectives, user?.username])

  // obj 900869: bots are owners too — the filter lists every bot on a card.
  const botOptions = useMemo(
    () => botRoster([...topLevel, ...doneObjectives]),
    [topLevel, doneObjectives],
  )

  const allOwnerTokens = useMemo(
    () => [UNASSIGNED_TOKEN, ...assigneeOptions, ...botOptions.map(b => b.token)],
    [assigneeOptions, botOptions],
  )
  const everyoneSelected = allOwnerTokens.length > 0 && allOwnerTokens.every(t => selectedAssignees.has(t))

  const selectEveryone = useCallback(() => {
    const next = everyoneSelected
      ? defaultAssigneeSelection(user?.username)
      : allOwnerTokens
    saveAssigneeSelection(wsKey || 'all', next)
    setAssigneeSel(next)
  }, [allOwnerTokens, everyoneSelected, user?.username, wsKey])

  const filteredTopLevel = useMemo(
    () => topLevel.filter(o =>
      matchesAssigneeFilter(o, selectedAssignees) && matchesProjectFilter(o, projectSel)
    ),
    [topLevel, selectedAssignees, projectSel],
  )

  const grouped = useMemo(() => {
    const map: Record<ObjectiveStatus, Objective[]> = {
      planning: [], queue: [], working: [], ai_review: [], review: [], done: [], cancelled: [],
    }
    for (const obj of filteredTopLevel) {
      const col = boardColumnOf(obj, childrenByParent.get(obj.id))
      map[col]?.push(obj)
    }
    const seen = new Set(map.done.map(o => o.id))
    for (const o of doneObjectives) {
      if (o.routine_id != null) continue
      if (!matchesAssigneeFilter(o, selectedAssignees)) continue
      // The lazily-fetched Done backlog bypasses `filteredTopLevel`, so the
      // project gate is re-applied here too.
      if (!matchesProjectFilter(o, projectSel)) continue
      if (!seen.has(o.id)) {
        map.done.push(o)
        seen.add(o.id)
      }
    }
    return map
  }, [filteredTopLevel, childrenByParent, doneObjectives, selectedAssignees, projectSel])

  const columns = useMemo(() => {
    const transient: ObjectiveStatus[] = ['planning', 'ai_review']
    const cols = OBJECTIVE_STATUSES.filter(s => {
      if (s === 'cancelled') return false
      if (transient.includes(s)) return grouped[s].length > 0
      return true
    })
    return orderBoardColumns(cols, isMobile)
  }, [grouped, isMobile])

  // ── Needs You bulk triage (obj 900869) ───────────────────────────────────
  // Selection lives only in this view. It is always pruned to the cards the
  // Needs You column shows right now, so a card that leaves the column while
  // selected (a bot picks it up, someone else approves it) cannot be acted on.
  const [triageMode, setTriageMode] = useState(false)
  const [triageSel, setTriageSel] = useState<Set<number>>(() => new Set())
  const [triageAnchor, setTriageAnchor] = useState<number | null>(null)
  const needsYouIds = useMemo(() => grouped.review.map(o => o.id), [grouped.review])
  const triageSelected = useMemo(() => {
    const live = pruneSelection(triageSel, needsYouIds)
    return grouped.review.filter(o => live.has(o.id))
  }, [triageSel, needsYouIds, grouped.review])
  const toggleTriage = useCallback((id: number, shift: boolean) => {
    setTriageSel(prev => toggleSelection(pruneSelection(prev, needsYouIds), id, { range: shift, anchor: triageAnchor, order: needsYouIds }))
    setTriageAnchor(id)
  }, [needsYouIds, triageAnchor])
  const exitTriage = useCallback(() => {
    setTriageMode(false)
    setTriageSel(new Set())
    setTriageAnchor(null)
  }, [])
  useEffect(() => {
    if (triageMode && needsYouIds.length === 0) exitTriage()
  }, [triageMode, needsYouIds.length, exitTriage])

  const handleOpen = useCallback((o: Objective) => {
    setSessionObjective(o)
  }, [])

  const handleNewObjective = useCallback(() => {
    setEditingObjective(null)
    setModalOpen(true)
  }, [])

  const handleEditObjective = useCallback((o: Objective) => {
    setEditingObjective(o)
    setModalOpen(true)
  }, [])

  const handleModalClose = useCallback(() => {
    setModalOpen(false)
    setEditingObjective(null)
  }, [])

  const handleChangeStatus = useCallback(async (id: number, status: ObjectiveStatus) => {
    await changeStatus(id, status)
  }, [changeStatus])

  const openInNewTab = useCallback((id: number) => {
    window.open(`/o/${id}`, '_blank', 'noopener')
  }, [])

  const openObjectiveById = useCallback(async (id: number) => {
    try {
      const full = await api.get<Objective>(`/objectives/${id}`)
      setSessionObjective(full)
    } catch {
      /* search result may 404 if RBAC hides it */
    }
  }, [])

  if (loading) {
    return <BoardSkeleton />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── One-line board header (obj 900666) ─────────────────────────────
          Project ▾ and Owner ▾ on the left, Search / Archive / New on the
          right — everything on one line, then the board. The organization is
          no longer chosen here: the top-bar switcher next to "Jump to" sets it
          for the whole app. */}
      {/* obj 900807: ONE row at every width. At 390px it used to wrap to two
          rows (filters, then actions), so the top bar + this header took ~140px
          before the first card. The filters now scroll sideways in their own
          strip (its right edge fades, so it reads as scrollable); the actions
          stay pinned on the right. */}
      <div
        data-testid="board-header"
        className="flex flex-nowrap items-center gap-2 border-b border-line px-3 py-2 sm:px-4"
      >
        <div
          data-testid="board-filters"
          className="-my-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1 pr-4 [mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)] [scrollbar-width:none] sm:flex-none sm:overflow-visible sm:pr-0 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden"
        >
        <ProjectFilterBar
          projects={projects}
          selection={projectSel}
          onSelect={selectProject}
          workspace={projectWorkspace}
          orgOptions={orgOptions}
          orgLabelOf={orgShortOf}
          onCreate={(name, ws) => createProject(name, ws ? { workspace: ws } : undefined)}
          onRename={renameProject}
          onDelete={deleteProject}
        />
        <OwnerFilterSelect
          options={assigneeOptions}
          bots={botOptions}
          selected={selectedAssignees}
          everyoneSelected={everyoneSelected}
          currentUser={user?.username}
          onToggle={toggleAssignee}
          onEveryone={selectEveryone}
        />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* obj 900669 — the "need you" count is the Needs You column's own
              length (same array, same filters), so the header can never report
              fewer cards than the column shows. Cards with an agent still
              running on them sit in Working, not here (boardColumnOf). */}
          {grouped.review.length > 0 && (
            <span
              data-testid="board-needs-you-count"
              className="hidden items-center gap-1 whitespace-nowrap text-xs text-fg-1 sm:inline-flex"
            >
              <span className="font-mono font-semibold text-accent">{grouped.review.length}</span>
              need you
            </span>
          )}
          <span
            className="hidden items-center gap-1.5 whitespace-nowrap text-xs text-fg-3 lg:inline-flex"
            title={connectionState === 'connected' ? 'Live updates on' : 'Live updates paused'}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                connectionState === 'connected' ? 'bg-[color:var(--ok-verify)]'
                  : connectionState === 'reconnecting' ? 'bg-[color:var(--ok-amber)]'
                  : 'bg-[color:var(--ok-alarm)]'
              }`}
            />
            {connectionState === 'connected' ? '' : connectionState === 'reconnecting' ? 'Reconnecting… · ' : 'Disconnected · '}
            {filteredTopLevel.length === topLevel.length
              ? `${topLevel.length} cards`
              : `${filteredTopLevel.length} of ${topLevel.length} cards`}
          </span>
          {/* The ONE card search. It is not the top bar's "Jump to" (⌘K),
              which goes to pages; this one finds cards — so it says so. */}
          {/* Header actions are all Button sm (32px), so New (primary, no
              visible border) is the same height as its neighbours (polish F4). */}
          <Button
            size="sm"
            onClick={() => setSearchOpen(true)}
            aria-label="Search cards"
            title={`Search cards — every stage, including done. Press /. (To go to a page, use Jump to ${commandPaletteShortcut()} in the top bar.)`}
            leftIcon={<Search className="h-4 w-4" />}
          >
            <span className="hidden md:inline">Search cards</span>
            <kbd className="hidden font-mono text-xs text-fg-3 md:inline">/</kbd>
          </Button>
          <Button
            size="sm"
            onClick={() => navigate('/archive')}
            aria-label="Archive"
            title="Full done / retired library"
            leftIcon={<Archive className="h-4 w-4" />}
          >
            <span className="hidden md:inline">Archive</span>
          </Button>
          {orgRecords.length > 0 && (
            <Button
              size="sm"
              onClick={() => setWorkflowOpen(true)}
              title="New workflow: describe a goal and a builder agent drafts and self-tests it"
              aria-label="New workflow"
              data-testid="board-new-workflow"
              leftIcon={<Workflow className="h-4 w-4" />}
            >
              <span className="hidden md:inline">Workflow</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            onClick={handleNewObjective}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            New
          </Button>
        </div>
      </div>
      {error && (
        <div className="border-b border-line px-4 py-1.5 text-xs text-[color:var(--ok-alarm)]">{error}</div>
      )}
      {triageMode && (
        <NeedsYouTriageBar
          selected={triageSelected}
          columnCount={grouped.review.length}
          onSelectAll={() => setTriageSel(new Set(needsYouIds))}
          onClear={() => setTriageSel(new Set())}
          onExit={exitTriage}
          onFinished={r => {
            // Drop the cards that changed; keep skipped/failed ones selected so
            // they can be looked at or retried.
            const changed = new Set(r.items.filter(i => i.result === 'ok').map(i => i.objective_id))
            setTriageSel(prev => new Set([...prev].filter(id => !changed.has(id))))
          }}
        />
      )}
      <ColumnScroller className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 sm:p-4">
        {columns.map(status => (
          <section key={status} data-status={status} className="cc-ws-col max-h-full w-[300px] shrink-0 overflow-hidden">
            {/* Header text sits on the same left edge as the card text below:
                the list's px-2 + the card's 1px border + its px-3 (polish F4). */}
            <div className="flex items-center px-2 pb-2 pt-2.5">
              <div className="flex flex-1 items-center border-x border-transparent px-3">
                <Eyebrow className="text-fg-2">{STATUS_META[status].label}</Eyebrow>
                {status === 'review' && grouped.review.length > 0 && !triageMode && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setTriageMode(true)}
                    data-testid="triage-toggle"
                    title="Select cards in Needs You to approve, reassign or dismiss them in a batch"
                    leftIcon={<ListChecks className="h-3.5 w-3.5" aria-hidden="true" />}
                    className="-my-1 ml-2 text-fg-2"
                  >
                    Select
                  </Button>
                )}
                <span data-testid={`column-count-${status}`} className="ml-auto text-xs tabular-nums text-fg-3">{grouped[status].length}</span>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-3">
              {grouped[status].length === 0 && (status !== 'done' || (doneLoaded && !doneLoading && !doneHasMore)) && (
                <EmptyState
                  compact
                  icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
                  title={COLUMN_EMPTY[status].title}
                  description={COLUMN_EMPTY[status].description}
                  className="px-2"
                />
              )}
              {grouped[status].map(obj => (
                <PreviewCard
                  key={obj.id}
                  objective={obj}
                  children={childrenByParent.get(obj.id)}
                  onOpen={handleOpen}
                  onEdit={handleEditObjective}
                  onChangeStatus={handleChangeStatus}
                  showOrgChip={workspaces.length !== 1}
                  workspaceLabel={orgLabelOf}
                  selectable={triageMode && status === 'review'}
                  selected={triageMode && status === 'review' && triageSel.has(obj.id)}
                  onToggleSelect={toggleTriage}
                />
              ))}
              {status === 'done' && (
                <>
                  {doneLoading && (
                    <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading done cards">
                      <Skeleton className="h-14 w-full rounded-md" />
                      <Skeleton className="h-14 w-full rounded-md" />
                    </div>
                  )}
                  {!doneLoading && (doneHasMore || !doneLoaded) && (
                    <Button
                      size="sm"
                      onClick={() => loadMoreDone()}
                      className="w-full border-dashed bg-transparent text-xs text-fg-2"
                    >
                      {doneLoaded ? 'Load more done' : 'Load done'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate('/archive')}
                    className="w-full text-xs text-fg-2"
                  >
                    View full archive
                  </Button>
                </>
              )}
            </div>
          </section>
        ))}
      </ColumnScroller>

      {/* Mounted only while open, like ObjectiveModal below: the board does not
          render the dialog's Modal until someone asks for a workflow. */}
      {workflowOpen && (
        <NewWorkflowDialog
          open
          onClose={() => setWorkflowOpen(false)}
          workspaces={orgOptions.map(o => o.slug)}
          defaultWorkspace={projectWorkspace}
          labelOf={orgLabelOf}
        />
      )}

      <ObjectiveSearchPanel
        open={searchOpen}
        workspace={modalWorkspace}
        onClose={() => setSearchOpen(false)}
        onSelect={openObjectiveById}
      />

      {modalOpen && (
        <ObjectiveModal
          objective={editingObjective}
          workspace={modalWorkspace}
          defaultProjectId={typeof projectSel === 'number' ? projectSel : null}
          onClose={handleModalClose}
          onCreate={createObjectiveInProject}
          onUpdate={updateObjectiveInProject}
          onDelete={deleteObjective}
          onReopen={(id) => {
            const target = editingObjective?.status === 'cancelled' ? 'queue' : 'working'
            void handleChangeStatus(id, target)
            handleModalClose()
          }}
        />
      )}

      {sessionObjective && (
        <SessionViewer
          objective={sessionObjective}
          chrome="dialog"
          onClose={() => setSessionObjective(null)}
          onChangeStatus={handleChangeStatus}
          onOpenInNewTab={() => openInNewTab(sessionObjective.id)}
          onEdit={() => {
            handleEditObjective(sessionObjective)
            setSessionObjective(null)
          }}
        />
      )}
    </div>
  )
}
