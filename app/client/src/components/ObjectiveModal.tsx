import { memo, useState, useEffect, useRef, type FormEvent, type ChangeEvent } from 'react'
import { X, Plus, Check } from 'lucide-react'
import { Button, IconButton, Input, Modal, RowButton, Textarea, cn, useConfirm } from './ui'
import { useAuth } from '../context/AuthContext'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { api } from '../lib/api'
import { useProjects } from '../hooks/useProjects'
import type {
  Objective,
  CreateObjectiveRequest,
  UpdateObjectiveRequest,
  Workspace,
  ModelsConfig,
  ModelRow,
  User,
} from '@operationkit/shared'
import { fieldCls, labelCls } from './objective-modal/form-tokens'
import { validateOwnerBot, OWNER_BOT_MAX_LENGTH } from '@operationkit/shared'
import { FooterActions } from './objective-modal/FooterActions'
import { parseDuplicateError, cardHref, type DuplicateCard } from '../lib/duplicateGuard'
import { Select } from './ui/Select'
import { ModelPicker } from './ModelPicker'
import { friendlyError } from '../lib/format'

interface ObjectiveModalProps {
  objective: Objective | null
  workspace: Workspace
  onClose: () => void
  onCreate: (data: CreateObjectiveRequest) => Promise<Objective>
  onUpdate: (id: number, data: UpdateObjectiveRequest) => Promise<Objective>
  onDelete: (id: number) => Promise<void>
  onReopen?: (id: number) => void
  /** Project (org subfolder) to preselect when CREATING from inside an open
   *  project on the board. Ignored in edit mode. Null = no project. */
  defaultProjectId?: number | null
}

function ObjectiveModalImpl({ objective, workspace, onClose, onCreate, onUpdate, onDelete, onReopen, defaultProjectId = null }: ObjectiveModalProps) {
  const { user: currentUser } = useAuth()
  const { confirm, confirmDialog } = useConfirm()
  const isAdmin = currentUser?.role === 'admin'
  const isEdit = !!objective
  const [title, setTitle] = useState(objective?.title || '')
  const [description, setDescription] = useState(objective?.description || '')
  const [descHydrated, setDescHydrated] = useState(!objective)
  // All / multi-org views must not silently default to Example — that routed
  // Example Project creates into the wrong organization.
  const [objWorkspace, setObjWorkspace] = useState(
    objective?.workspace || (workspace && workspace !== 'all' ? workspace : ''),
  )
  const [objProjectId, setObjProjectId] = useState<number | null>(
    objective ? objective.project_id ?? null : defaultProjectId
  )
  const [loading, setLoading] = useState(false)
  const [error, setErrorText] = useState('')
  const [errorDetail, setErrorDetail] = useState('')
  const setError = (msg: string) => { setErrorText(msg); setErrorDetail('') }
  const showError = (err: unknown) => {
    const f = friendlyError(err)
    setErrorText(f.message)
    setErrorDetail(f.detail)
  }
  // obj 64: a create refused as a same-title duplicate (409 duplicate_24h) — shown
  // with a link to the existing card and a "Create anyway" (force: true) action.
  const [duplicate, setDuplicate] = useState<DuplicateCard | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)

  // Model selection
  const [models, setModels] = useState<ModelRow[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [model, setModel] = useState(objective?.model || '')
  // obj 900270: optional owning Grok bot. Blank = unowned.
  const initialOwnerBot = objective?.owner_bot ?? ''
  const [ownerBot, setOwnerBot] = useState(initialOwnerBot)

  // Delegator mode (admin-only)
  const [delegateMode, setDelegateMode] = useState(objective?.delegate_mode ?? false)

  // Assign to users (admin-only, ordered — first id is primary)
  const [users, setUsers] = useState<Array<{ id: number; username: string }>>([])
  const [assignedUserIds, setAssignedUserIds] = useState<number[]>(() => {
    if (objective?.assigned_user_ids?.length) return objective.assigned_user_ids
    if (objective?.assigned_user_id) return [objective.assigned_user_id]
    return []
  })

  // File attachments
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)

  const { slugs: wsSlugs, labelOf } = useWorkspaces()

  const workspaceOptions: string[] = isAdmin
    ? wsSlugs
    : (currentUser?.workspaces?.map(w => w.workspace) || [])

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [title])

  useEffect(() => {
    const el = descRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [description])

  // Hydrate description for edit mode
  useEffect(() => {
    if (!objective) { setDescHydrated(true); return }
    let cancelled = false
    setDescHydrated(false)
    api.get<Objective>(`/objectives/${objective.id}`)
      .then(full => {
        if (cancelled) return
        if (typeof full.description === 'string') setDescription(full.description)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDescHydrated(true) })
    return () => { cancelled = true }
  }, [objective?.id])

  // Load enabled models from registry
  useEffect(() => {
    api.get<ModelsConfig>('/models')
      .then(data => {
        const enabled = (data.models || []).filter(m => m.enabled)
        setModels(enabled)
        setDefaultModel(data.default || '')
        // Pre-select: in edit mode use the objective's model; else use registry default
        if (!isEdit && !model) setModel(data.default || '')
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit])

  // Load users for assignee picker (admin-only; silently skip on 403)
  useEffect(() => {
    if (!isAdmin) return
    api.get<User[]>('/admin/users')
      .then(list => setUsers(list.map(u => ({ id: u.id, username: u.username }))))
      .catch(() => {})
  }, [isAdmin])

  const { projects: availableProjects, createProject } = useProjects(objWorkspace)

  useEffect(() => {
    if (objProjectId == null) return
    if (availableProjects.length === 0) return
    if (!availableProjects.some(p => p.id === objProjectId)) setObjProjectId(null)
  }, [availableProjects, objProjectId])

  async function handleCreateProject() {
    const name = newProjectName.trim()
    if (!name) return
    setProjectBusy(true)
    setError('')
    try {
      const created = await createProject(name)
      setObjProjectId(created.id)
      setCreatingProject(false)
      setNewProjectName('')
    } catch (err) {
      showError(err)
    } finally {
      setProjectBusy(false)
    }
  }

  async function uploadFiles(objectiveId: number) {
    if (pendingFiles.length === 0) return
    const form = new FormData()
    for (const f of pendingFiles) form.append('files', f)
    await fetch(`/api/objectives/${objectiveId}/upload`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    await submit(false)
  }

  async function submit(force: boolean) {
    if (!objWorkspace) {
      setError('Pick a workspace')
      return
    }
    const owner = validateOwnerBot(ownerBot)
    if (!owner.ok) {
      setError(owner.error)
      return
    }
    // Only send owner_bot when it changed, so an edit never clears it by accident.
    const ownerChanged = (owner.value ?? '') !== initialOwnerBot.trim()
    setLoading(true)
    setError('')
    setDuplicate(null)

    try {
      if (isEdit) {
        await onUpdate(objective.id, {
          title,
          description,
          workspace: objWorkspace,
          project_id: objProjectId,
          model: model || undefined,
          delegate_mode: isAdmin ? delegateMode : undefined,
          assigned_user_ids: isAdmin ? assignedUserIds : undefined,
          ...(ownerChanged ? { owner_bot: owner.value ?? null } : {}),
        })
        if (pendingFiles.length > 0) {
          setUploading(true)
          await uploadFiles(objective.id)
          setPendingFiles([])
        }
      } else {
        const created = await onCreate({
          title,
          description,
          workspace: objWorkspace,
          project_id: objProjectId,
          model: model || undefined,
          delegate_mode: isAdmin ? delegateMode : undefined,
          assigned_user_ids: isAdmin ? assignedUserIds : undefined,
          ...(owner.value ? { owner_bot: owner.value } : {}),
          ...(force ? { force: true } : {}),
        })
        if (pendingFiles.length > 0 && created?.id) {
          setUploading(true)
          await uploadFiles(created.id)
        }
      }
      onClose()
    } catch (err) {
      const dup = isEdit ? null : parseDuplicateError(err)
      if (dup) setDuplicate(dup)
      else showError(err)
    } finally {
      setLoading(false)
      setUploading(false)
    }
  }

  async function handleDelete() {
    if (!objective) return
    if (!(await confirm({
      title: 'Delete this card?',
      message: 'This permanently removes the card and its run history. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return
    setLoading(true)
    try {
      await onDelete(objective.id)
      onClose()
    } catch (err) {
      showError(err)
    } finally {
      setLoading(false)
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    setPendingFiles(prev => [...prev, ...files])
    e.target.value = ''
  }

  function removeFile(name: string) {
    setPendingFiles(prev => prev.filter(f => f.name !== name))
  }

  return (
    <Modal
      open
      onClose={onClose}
      variant="center"
      labelledBy="objective-modal-title"
      size="lg"
    >
      <div className="p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="objective-modal-title" className="text-lg font-semibold tracking-tight text-fg-0">
            {isEdit ? 'Edit card' : 'New card'}
          </h2>
          <IconButton label="Close" onClick={onClose} className="-mr-1.5 text-fg-2">
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-flag-blocked/30 bg-flag-blocked/10 px-3 py-2 text-base text-flag-blocked">
            {error}
            {errorDetail && (
              <details className="mt-1 text-xs text-fg-3">
                <summary className="cursor-pointer">Details</summary>
                {errorDetail}
              </details>
            )}
          </div>
        )}

        {duplicate && (
          <div
            data-testid="duplicate-notice"
            role="alert"
            className="mb-4 rounded-md border border-flag-blocked/30 bg-flag-blocked/10 px-3 py-2 text-base text-fg-1"
          >
            <p>
              An open card with this title was created in the last 24h:{' '}
              <a href={cardHref(duplicate.id)} className="font-medium underline" data-testid="duplicate-link">
                #{duplicate.id}{duplicate.title ? ` ${duplicate.title}` : ''}
              </a>
              {duplicate.status ? ` (${duplicate.status})` : ''}. Not created.
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="xs"
                data-testid="create-anyway"
                disabled={loading}
                onClick={() => { void submit(true) }}
              >
                Create anyway
              </Button>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={labelCls}>Title</label>
            <Textarea
              ref={titleRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              rows={1}
              aria-label="Title"
              className={cn(fieldCls, 'resize-none overflow-y-auto')}
              placeholder="What needs to be done?"
              autoFocus
              required
            />
          </div>

          <div>
            <label className={labelCls}>Description / instructions</label>
            <Textarea
              ref={descRef}
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={5}
              aria-label="Description / instructions"
              className={cn(fieldCls, 'resize-none overflow-y-auto')}
              placeholder="Detailed context and instructions for the bot…"
            />
          </div>

          <div>
            <label className={labelCls}>Workspace</label>
            <Select className="w-full"
              value={objWorkspace}
              onChange={v => setObjWorkspace(v)}
              required
              aria-invalid={!objWorkspace}
              aria-label="Workspace"
            >
              <option value="" disabled>
                Select workspace…
              </option>
              {workspaceOptions.map(ws => (
                <option key={ws} value={ws}>{labelOf(ws)}</option>
              ))}
            </Select>
          </div>

          <div>
            <label className={labelCls}>Project</label>
            {creatingProject ? (
              <div className="flex items-center gap-2">
                <Input
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); void handleCreateProject() }
                    if (e.key === 'Escape') { setCreatingProject(false); setNewProjectName('') }
                  }}
                  placeholder="New project name"
                  aria-label="New project name"
                  autoFocus
                  className={fieldCls}
                />
                <IconButton
                  onClick={() => void handleCreateProject()}
                  disabled={projectBusy || !newProjectName.trim()}
                  label="Create project"
                  className="shrink-0 text-fg-2"
                >
                  <Check className="h-4 w-4" />
                </IconButton>
                <IconButton
                  onClick={() => { setCreatingProject(false); setNewProjectName('') }}
                  label="Cancel new project"
                  className="shrink-0 text-fg-2"
                >
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Select className="w-full"
                  value={objProjectId == null ? '' : String(objProjectId)}
                  aria-label="Project"
                  onChange={v => setObjProjectId(v ? Number(v) : null)}
                >
                  <option value="">No project</option>
                  {availableProjects.map(proj => (
                    <option key={proj.id} value={proj.id}>{proj.name}</option>
                  ))}
                </Select>
                <Button
                  type="button"
                  onClick={() => { setCreatingProject(true); setNewProjectName('') }}
                  aria-label="New project"
                  title="Create a project in this workspace"
                  leftIcon={<Plus className="h-3.5 w-3.5" />}
                  className="shrink-0 gap-1 px-2.5"
                >
                  New
                </Button>
              </div>
            )}
          </div>

          {/* Model selection — shown when the registry returns at least one enabled model */}
          {models.length > 0 && (
            <div>
              <label className={labelCls}>Model</label>
              <ModelPicker
                models={models}
                value={model || defaultModel}
                aria-label="Model"
                onChange={v => setModel(v)}
              />
            </div>
          )}

          {/* Owner bot (obj 900270): which Grok bot owns this card. Optional; it rides
              on the needs_agent webhook so the General can route the wake. */}
          <div>
            <label htmlFor="objective-owner-bot" className={labelCls}>Owner bot</label>
            <Input
              id="objective-owner-bot"
              type="text"
              value={ownerBot}
              onChange={e => setOwnerBot(e.target.value)}
              maxLength={OWNER_BOT_MAX_LENGTH}
              placeholder="Unowned — e.g. Research bot"
              className={fieldCls}
              autoComplete="off"
            />
          </div>

          {/* Assignee picker — admin-only, multi-owner ordered chip list */}
          {isAdmin && users.length > 0 && (
            <div>
              <label className={labelCls}>Assign to</label>
              {assignedUserIds.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {assignedUserIds.map((uid, idx) => {
                    const u = users.find(x => x.id === uid)
                    return (
                      <span
                        key={uid}
                        className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-3 px-2.5 py-0.5 text-xs text-fg-1"
                      >
                        {u?.username ?? uid}
                        {idx === 0 && (
                          <span className="ml-0.5 rounded-sm border border-[color:var(--accent-line)] px-1 py-px text-xs font-semibold uppercase tracking-eyebrow text-accent">
                            primary
                          </span>
                        )}
                        <RowButton
                          aria-label={`Remove ${u?.username ?? uid}`}
                          onClick={() => setAssignedUserIds(ids => ids.filter(id => id !== uid))}
                          className="ml-0.5 rounded-sm text-fg-3 hover:text-fg-0"
                        >
                          <X className="h-3 w-3" />
                        </RowButton>
                      </span>
                    )
                  })}
                </div>
              )}
              <Select className="w-full"
                value=""
                onChange={v => {
                  const id = Number(v)
                  if (!id) return
                  setAssignedUserIds(ids => ids.includes(id) ? ids : [...ids, id])
                }}
                aria-label="Add owner"
              >
                <option value="">{assignedUserIds.length === 0 ? 'Unassigned — add owner…' : 'Add another owner…'}</option>
                {users
                  .filter(u => !assignedUserIds.includes(u.id))
                  .map(u => (
                    <option key={u.id} value={u.id}>{u.username}</option>
                  ))}
              </Select>
            </div>
          )}

          {/* Delegator mode — admin-only */}
          {isAdmin && (
            <div className="flex items-center gap-2">
              {/* raw-control: native checkbox; there is no Checkbox primitive yet. */}
              <input
                id="delegate-mode"
                type="checkbox"
                checked={delegateMode}
                onChange={e => setDelegateMode(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong accent-accent"
              />
              <label htmlFor="delegate-mode" className="text-sm font-medium text-fg-1 cursor-pointer select-none">
                Delegator mode
              </label>
            </div>
          )}

          {/* File attachments */}
          <div>
            <label className={labelCls}>Attach files</label>
            {/* raw-control: the native file picker (styled via file:). */}
            <input
              type="file"
              multiple
              onChange={handleFileChange}
              className="block w-full text-base text-fg-2 file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-3 file:px-2.5 file:py-1.5 file:text-sm file:text-fg-1 file:transition-colors file:duration-fast file:ease-out hover:file:border-line-strong hover:file:text-fg-0"
            />
            {pendingFiles.length > 0 && (
              <ul className="mt-2 space-y-1">
                {pendingFiles.map(f => (
                  <li key={f.name} className="flex items-center gap-2 text-sm text-fg-2">
                    <span className="truncate">{f.name}</span>
                    <RowButton
                      onClick={() => removeFile(f.name)}
                      aria-label={`Remove ${f.name}`}
                      className="shrink-0 rounded-sm text-fg-3 hover:text-fg-0"
                    >
                      <X className="h-3 w-3" />
                    </RowButton>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <FooterActions
            isEdit={isEdit}
            loading={loading}
            uploading={uploading}
            descHydrated={descHydrated}
            objective={objective}
            onDelete={handleDelete}
            onClose={onClose}
            onReopen={onReopen}
          />
        </form>
      </div>
      {confirmDialog}
    </Modal>
  )
}

// Memoized so board-level WebSocket broadcasts don't re-render the open modal.
// See obj 700070/700128 for the "bouncing/closing" select bug this prevents.
export const ObjectiveModal = memo(ObjectiveModalImpl)
