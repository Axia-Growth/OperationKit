import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { Objective, SessionIntel, Workspace } from '@operationkit/shared'
import { useAuth } from '../context/AuthContext'
import { useObjectives } from '../hooks/useObjectives'
import { groupObjectives } from '../lib/groupObjectives'
import { api } from '../lib/api'
import { friendlyError } from '../lib/format'
import { filesFromIntel, mergeAttachments, type TouchedFile } from '../lib/touchedFiles'
import { SessionViewer } from '../components/SessionViewer'
import { ObjectiveModal } from '../components/ObjectiveModal'
import { FileRail } from './FileRail'
import { SubObjectiveRail } from './SubObjectiveRail'
import { SubCardPopup } from './SubCardPopup'
import { FileQuestion, TriangleAlert } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Skeleton, SkeletonText } from '../components/ui/Skeleton'

function idFromPath(pathname: string, param?: string): number {
  if (param && Number.isFinite(Number(param))) return Number(param)
  const m = pathname.match(/^\/(?:preview\/)?o\/(\d+)/)
  return m ? Number(m[1]) : NaN
}

export function PreviewWorkspace({ workspaces }: { workspaces: Workspace[] }) {
  const { id: paramId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const objectiveId = idFromPath(location.pathname, paramId)
  const { objectives, changeStatus, createObjective, updateObjective, deleteObjective } = useObjectives(workspaces)
  const { user } = useAuth()
  const [detail, setDetail] = useState<Objective | null>(null)
  const [intel, setIntel] = useState<SessionIntel[]>([])
  const [uploads, setUploads] = useState<Array<{ name: string; path: string }>>([])
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null)
  const [designMode, setDesignMode] = useState(false)
  const [editing, setEditing] = useState(false)
  // obj 901083: the sub-card open in a pop-up over this card (null = none).
  // Kept as an id so the pop-up follows live updates to the sub-card's row.
  const [peekId, setPeekId] = useState<number | null>(null)
  // Defensive: a non-admin member of one org still gets a scoped workspace
  // while selectedWorkspaces is resolving from [] to [org] in App.tsx.
  const modalWorkspace: Workspace = (() => {
    if (workspaces.length === 1) return workspaces[0]
    if (workspaces.length === 0 && user?.role !== 'admin') {
      const userWs = user?.workspaces
      if (userWs?.length === 1) return userWs[0].workspace as Workspace
    }
    return 'all'
  })()

  useEffect(() => {
    if (!Number.isFinite(objectiveId)) return
    let cancelled = false
    setError(null)
    setDetail(null)
    setDesignMode(false)
    setPeekId(null)
    api.get<Objective>(`/objectives/${objectiveId}`)
      .then(row => { if (!cancelled) setDetail(row) })
      .catch(err => {
        if (cancelled) return
        const status = (err as { status?: number } | null)?.status
        setError({
          message: err instanceof Error ? err.message : 'Not found',
          // 404, or 403 when RBAC hides the card: to this viewer it does not exist.
          notFound: status === 404 || status === 403 || !(err instanceof Error),
        })
      })
    api.get<SessionIntel[]>(`/objectives/${objectiveId}/intel`)
      .then(rows => { if (!cancelled) setIntel(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (!cancelled) setIntel([]) })
    api.get<{ files: Array<{ name: string; path: string }> }>(`/objectives/${objectiveId}/uploads`)
      .then(data => { if (!cancelled) setUploads(data.files || []) })
      .catch(() => { if (!cancelled) setUploads([]) })
    return () => { cancelled = true }
  }, [objectiveId])

  const fromBoard = objectives.find(o => o.id === objectiveId)
  const objective = detail ?? fromBoard ?? null

  const children = useMemo(() => {
    const grouped = groupObjectives(objectives)
    if (objective) return grouped.childrenByParent.get(objective.id) ?? []
    return objectives.filter(o => o.parent_id === objectiveId)
  }, [objectives, objective, objectiveId])

  const peek = peekId == null ? null : (children.find(o => o.id === peekId) ?? objectives.find(o => o.id === peekId) ?? null)

  const files: TouchedFile[] = useMemo(
    () => mergeAttachments(filesFromIntel(intel), uploads),
    [intel, uploads],
  )

  const backToBoard = (
    <Button variant="primary" onClick={() => navigate('/')}>Back to the board</Button>
  )

  if (!Number.isFinite(objectiveId)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8" data-testid="objective-not-found">
        <EmptyState
          icon={<FileQuestion className="h-5 w-5" aria-hidden="true" />}
          title="Card not found"
          description="This link is missing a card number."
          action={backToBoard}
        />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8" data-testid={error.notFound ? 'objective-not-found' : 'objective-error'}>
        <EmptyState
          icon={error.notFound
            ? <FileQuestion className="h-5 w-5" aria-hidden="true" />
            : <TriangleAlert className="h-5 w-5" aria-hidden="true" />}
          title={error.notFound ? 'Card not found' : "Couldn't open this card"}
          description={error.notFound
            ? `Card #${objectiveId} doesn't exist, was deleted, or isn't shared with you.`
            : friendlyError(error.message).message}
          action={backToBoard}
        />
      </div>
    )
  }

  if (!objective) {
    return <ObjectiveSkeleton />
  }

  return (
    <div className="flex min-h-0 flex-1">
      {!designMode && (
        <SubObjectiveRail
          items={children}
          activeId={peek?.id ?? objective.id}
          onOpen={o => setPeekId(o.id)}
        />
      )}
      <div className="relative min-h-0 min-w-0 flex-1">
        <SessionViewer
          objective={objective}
          chrome="page"
          onClose={() => navigate('/')}
          onChangeStatus={(oid, status) => { void changeStatus(oid, status) }}
          onDesignModeChange={setDesignMode}
          onEdit={() => setEditing(true)}
        />
      </div>
      {!designMode && <FileRail files={files} />}
      {peek && (
        <SubCardPopup
          objective={peek}
          onClose={() => setPeekId(null)}
          onOpenFull={o => { setPeekId(null); navigate(`/o/${o.id}`) }}
        />
      )}
      {editing && (
        <ObjectiveModal
          objective={objective}
          workspace={(objective.workspace as Workspace) || modalWorkspace}
          onClose={() => setEditing(false)}
          onCreate={createObjective}
          onUpdate={async (id, data) => {
            const updated = await updateObjective(id, data)
            setDetail(prev => prev ? { ...prev, ...updated } : updated)
            setEditing(false)
            return updated
          }}
          onDelete={async (id) => {
            await deleteObjective(id)
            navigate('/')
          }}
        />
      )}
    </div>
  )
}

/** Placeholder while a deep-linked card loads (polish F8; was "Opening objective…"). */
function ObjectiveSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label="Opening card" data-testid="objective-skeleton">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Skeleton className="h-6 w-6 rounded" />
        <Skeleton className="h-4 w-64 max-w-[50%]" />
        <Skeleton className="ml-auto h-7 w-20 rounded-md" />
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-hidden p-6">
        <SkeletonText lines={3} />
        <SkeletonText lines={4} />
        <SkeletonText lines={2} />
      </div>
    </div>
  )
}
