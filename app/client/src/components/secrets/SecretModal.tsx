/**
 * Create / edit / move secret modal — extracted from SecretsPage.tsx
 * (behavior frozen).
 *
 * The scope pickers stay ENABLED while editing: changing them issues a
 * `POST /secrets/move` (source = the row's original scope) BEFORE any value
 * write, so the ciphertext and version history are re-parented without the
 * plaintext ever leaving the server. A value is only required when creating, or
 * when the scope is unchanged (in which case the value is the only thing that
 * could possibly change).
 *
 * CREATE is multi-organization; EDIT/MOVE stays single-scope. At an
 * organization-bearing scope a NEW secret can be scoped to any number of
 * organizations at once: the modal ticks N organizations and fans out N
 * independent `POST /secrets` calls — one row per (key, scope), which keeps the
 * DB shape and every row-level action (Edit/Delete/History/Move) exactly as they
 * were, and needs no new server surface. A row IS one scope, so editing an
 * existing secret still addresses exactly one organization; there is no
 * multi-organization edit.
 *
 * The fan-out reports honestly: each organization's outcome is tracked
 * separately and a partial failure keeps the modal open listing which
 * organizations got the secret and which did not (failed ones stay ticked so the
 * operator can retry just those). It never claims "all created".
 */
import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { api, ApiError } from '../../lib/api'
import { Check, X } from 'lucide-react'
import { Alert, Button, Checkbox, Field, IconButton, Input, Modal } from '../ui'
import type {
  SecretScopeType,
  SecretSummary,
  SecretPrincipals,
  SetSecretRequest,
  RotateSecretRequest,
  SecretMetadataRequest,
  MoveSecretRequest,
} from '@operationkit/shared'
import {
  SCOPE_HINTS, SCOPE_HINTS_CREATE, SCOPE_LABELS, sameScope,
  type Scope,
} from './scope'
import { Select } from '../ui/Select'

interface SecretModalProps {
  principals: SecretPrincipals | null
  initialScope: Scope
  editing: SecretSummary | null
  onClose: () => void
  onSaved: () => Promise<void>
  /** Refresh the table WITHOUT closing — used when a fan-out partly succeeded. */
  onRefresh: () => Promise<void>
}

/** Per-organization outcome of a multi-organization create. */
interface FanoutResult {
  slug: string
  name: string
  ok: boolean
  error?: string
}

export function SecretModal({ principals, initialScope, editing, onClose, onSaved, onRefresh }: SecretModalProps) {
  const isEdit = editing !== null
  const orgs = useMemo(() => principals?.organizations ?? [], [principals])
  const users = principals?.users ?? []

  const [key, setKey] = useState(editing?.key || '')
  const [value, setValue] = useState('')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [scopeType, setScopeType] = useState<SecretScopeType>(initialScope.scopeType)
  // Organizations are a SET even on the single-scope (edit/move) path, so the
  // target-scope derivation below never has to branch on mode.
  const [workspaces, setWorkspaces] = useState<string[]>(initialScope.workspace ? [initialScope.workspace] : [])
  const [userId, setUserId] = useState<string>(initialScope.userId != null ? String(initialScope.userId) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fanout, setFanout] = useState<FanoutResult[] | null>(null)

  // Members cannot address the Command-Center-wide scope.
  const scopeOptions = useMemo<SecretScopeType[]>(() => {
    const all: SecretScopeType[] = ['global', 'workspace', 'user', 'workspace_user']
    return principals?.canUseGlobal ? all : all.filter(s => s !== 'global')
  }, [principals?.canUseGlobal])

  const needsWorkspace = scopeType === 'workspace' || scopeType === 'workspace_user'
  const needsUser = scopeType === 'user' || scopeType === 'workspace_user'
  /** Multi-organization applies to CREATE only — a row is one scope. */
  const multiOrg = !isEdit && needsWorkspace

  const orgLabel = useCallback(
    (slug: string) => orgs.find(o => o.slug === slug)?.name || slug,
    [orgs],
  )

  /** The single scope this submit addresses (edit/move, or a non-org create). */
  const target: Scope = {
    scopeType,
    workspace: needsWorkspace ? workspaces[0] || null : null,
    userId: needsUser && userId ? Number(userId) : null,
  }
  const scopeChanged = isEdit && !sameScope(initialScope, target)
  const descriptionChanged = isEdit && description.trim() !== (editing?.description ?? '').trim()

  function toggleOrg(slug: string) {
    setFanout(null)
    setWorkspaces(prev => (prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]))
  }

  /**
   * Create the same key/value once per selected organization. Each call is
   * independent, so one organization's 403/409 cannot cancel the others — and
   * the per-organization outcome is what the UI reports.
   */
  async function createAcrossOrgs(): Promise<FanoutResult[]> {
    return Promise.all(
      workspaces.map(async (slug): Promise<FanoutResult> => {
        const body: SetSecretRequest = {
          scopeType,
          workspace: slug,
          userId: needsUser && userId ? Number(userId) : undefined,
          key: key.trim(),
          value,
          ...(description.trim() ? { description: description.trim() } : {}),
        }
        try {
          await api.post<SecretSummary>('/secrets', body)
          return { slug, name: orgLabel(slug), ok: true }
        } catch (err) {
          const message =
            err instanceof ApiError && err.status === 409
              ? 'already exists at this scope'
              : err instanceof Error ? err.message : 'failed'
          return { slug, name: orgLabel(slug), ok: false, error: message }
        }
      }),
    )
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setFanout(null)
    if (!key.trim()) { setError('Key is required.'); return }
    if (multiOrg && workspaces.length === 0) { setError('Pick at least one workspace for this scope.'); return }
    if (!multiOrg && needsWorkspace && !target.workspace) { setError('Pick a workspace for this scope.'); return }
    if (needsUser && ((multiOrg && !userId) || (!multiOrg && target.userId == null))) {
      setError('Pick a user for this scope.'); return
    }
    // An edit may rotate the value, re-scope it, or change its description —
    // any one is enough. A create always needs a value.
    if (!value && !scopeChanged && !descriptionChanged) {
      setError(isEdit
        ? 'Nothing to save. Type a new value to rotate it (the current value is never shown), change the scope, or edit the description.'
        : 'Value is required.')
      return
    }

    // ── Multi-organization create: N rows, N independent outcomes ──
    if (multiOrg) {
      setSaving(true)
      try {
        const results = await createAcrossOrgs()
        const failed = results.filter(r => !r.ok)
        if (failed.length === 0) { await onSaved(); return }
        // Partial (or total) failure: never close on a half-done write. Show the
        // per-organization breakdown, re-tick only the failures for a retry, and
        // refresh the table behind so the rows that DID land are visible.
        setFanout(results)
        setWorkspaces(failed.map(r => r.slug))
        await onRefresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed')
      } finally {
        setSaving(false)
      }
      return
    }

    setSaving(true)
    try {
      if (scopeChanged) {
        // Re-scope first, from the ORIGINAL scope, without the value.
        const move: MoveSecretRequest = {
          scopeType: initialScope.scopeType,
          workspace: initialScope.workspace ?? undefined,
          userId: initialScope.userId ?? undefined,
          key: key.trim(),
          to: {
            scopeType: target.scopeType,
            workspace: target.workspace ?? undefined,
            userId: target.userId ?? undefined,
          },
        }
        await api.post<SecretSummary>('/secrets/move', move)
      }
      const addr = {
        scopeType: target.scopeType,
        workspace: target.workspace ?? undefined,
        userId: target.userId ?? undefined,
        key: key.trim(),
      }
      if (!isEdit) {
        const body: SetSecretRequest = {
          ...addr,
          value,
          ...(description.trim() ? { description: description.trim() } : {}),
        }
        await api.post<SecretSummary>('/secrets', body)
      } else if (value) {
        // Rotate: replace the value of THIS secret. The endpoint refuses to
        // create, so a stale row can never turn into a new secret here.
        const body: RotateSecretRequest = {
          ...addr,
          value,
          ...(descriptionChanged ? { description: description.trim() || null } : {}),
        }
        await api.post<SecretSummary>('/secrets/rotate', body)
      } else if (descriptionChanged) {
        const body: SecretMetadataRequest = { ...addr, description: description.trim() || null }
        await api.patch<SecretSummary>('/secrets/metadata', body)
      }
      await onSaved()
    } catch (err) {
      // 409 from /move means the key is already taken at the destination.
      if (err instanceof ApiError && err.status === 409) {
        setError(`'${key.trim()}' already exists at the target scope — delete or rename it there first.`)
      } else {
        setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="secret-title" panelClassName="max-w-lg bg-surface-1">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="secret-title" className="text-lg font-semibold text-fg-0">
            {isEdit ? 'Edit secret' : 'New secret'}
          </h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2 text-fg-3">
            <X className="h-5 w-5" aria-hidden />
          </IconButton>
        </div>

        {error && <Alert tone="alarm" title={error} className="mb-3" />}

        {/* Partial-failure report. Per-organization truth: what landed, what did
            not, and why — never a blanket "created". */}
        {fanout && (
          <Alert
            tone="amber"
            data-testid="modal-fanout-results"
            className="mb-3"
            title={fanout.some(r => r.ok)
              ? `Created in ${fanout.filter(r => r.ok).length} of ${fanout.length} workspaces — ${fanout.filter(r => !r.ok).length} failed.`
              : `Not created — all ${fanout.length} workspaces failed.`}
          >
            <ul className="mt-1.5 space-y-1">
              {fanout.map(r => (
                <li key={r.slug} data-testid={`fanout-${r.ok ? 'ok' : 'fail'}-${r.slug}`} className="flex gap-2 text-xs leading-relaxed">
                  <span className={`flex-none font-medium ${r.ok ? 'text-success' : 'text-danger'}`}>
                    {r.ok ? <Check aria-label="Succeeded" className="mt-0.5 h-3.5 w-3.5" /> : <X aria-label="Failed" className="mt-0.5 h-3.5 w-3.5" />}
                  </span>
                  <span className="text-fg-2">
                    {r.name}
                    {r.ok ? ' — created' : ` — ${r.error}`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-fg-3">
              The failed workspaces are still selected — re-enter the value and submit again to retry just those.
            </p>
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field id="secret-key" label={<>Key{isEdit && <span className="ml-1.5 font-normal text-fg-3">(locked)</span>}</>}>
            <Input
              type="text"
              value={key}
              onChange={e => setKey(e.target.value)}
              disabled={isEdit}
              placeholder="e.g. OPENAI_API_KEY"
              className="font-mono"
            />
          </Field>

          {/* The modal carries its OWN scope pickers, so a secret can be created
              at any scope from any view — and an existing one re-scoped. */}
          <div className="space-y-3 rounded-md border border-line bg-surface p-3">
            <Field
              id="secret-scope-type"
              label="Scope"
              // Inline, always-visible — not a hover tooltip. This sentence is
              // the whole reason "Organization" is no longer ambiguous.
              hint={<span data-testid="modal-scope-hint">{(isEdit ? SCOPE_HINTS : SCOPE_HINTS_CREATE)[scopeType]}</span>}
            >
              <Select
                value={scopeType}
                onChange={v => { setScopeType(v as SecretScopeType); setFanout(null) }}
              >
                {scopeOptions.map(s => (
                  <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
                ))}
              </Select>
            </Field>

            {needsWorkspace && (multiOrg ? (
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-fg-1">
                  Workspaces <span className="font-normal text-fg-3">(pick one or more)</span>
                </legend>
                {orgs.length === 0 ? (
                  <p className="rounded border border-dashed border-line px-3 py-4 text-center text-xs text-fg-3">
                    No workspaces available to you.
                  </p>
                ) : (
                  <>
                    <div
                      data-testid="modal-scope-organizations"
                      className="max-h-48 overflow-y-auto rounded-md border border-line bg-surface-1"
                    >
                      {orgs.map(o => {
                        const checked = workspaces.includes(o.slug)
                        return (
                          <Checkbox
                            key={o.slug}
                            checked={checked}
                            onChange={() => toggleOrg(o.slug)}
                            data-testid={`modal-org-checkbox-${o.slug}`}
                            label={<span className={`block truncate ${checked ? 'text-fg-0' : 'text-fg-2'}`}>{o.name}</span>}
                            className="flex min-h-[44px] w-full items-center border-b border-line px-3 last:border-b-0 hover:bg-surface-2/60 sm:min-h-[44px]"
                          />
                        )
                      })}
                    </div>
                    <div className="mt-1.5 flex items-center gap-3">
                      <p className="text-xs text-fg-3" data-testid="modal-org-selection-summary">
                        {workspaces.length === 0
                          ? 'No workspaces selected.'
                          : `${workspaces.length} of ${orgs.length} selected — ${workspaces.length} secret ${workspaces.length === 1 ? 'row' : 'rows'} will be created, one per workspace.`}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => { setFanout(null); setWorkspaces(workspaces.length === orgs.length ? [] : orgs.map(o => o.slug)) }}
                        className="ml-auto flex-none"
                      >
                        {workspaces.length === orgs.length ? 'Clear all' : 'Select all'}
                      </Button>
                    </div>
                  </>
                )}
              </fieldset>
            ) : (
              <Field id="secret-scope-org" label="Workspace">
                <Select
                  value={workspaces[0] || ''}
                  onChange={v => setWorkspaces(v ? [v] : [])}
                >
                  <option value="">— select —</option>
                  {orgs.map(o => (
                    <option key={o.slug} value={o.slug}>{o.name}</option>
                  ))}
                </Select>
              </Field>
            ))}

            {needsUser && (
              <Field id="secret-scope-user" label="User">
                <Select
                  value={userId}
                  onChange={v => setUserId(v)}
                >
                  <option value="">— select —</option>
                  {users.map(u => (
                    <option key={u.id} value={String(u.id)}>{u.username}</option>
                  ))}
                </Select>
              </Field>
            )}
            {scopeChanged && (
              <p className="text-xs text-accent">
                Moving from {SCOPE_LABELS[initialScope.scopeType]} — the value is carried over untouched.
              </p>
            )}
          </div>

          <Field
            id="secret-description"
            label="Description"
            optional
            hint="Visible to anyone who can see this secret. Never put the value here."
          >
            <Input
              type="text"
              value={description}
              maxLength={500}
              onChange={e => setDescription(e.target.value)}
              data-testid="modal-description"
              placeholder="What is this for? e.g. Stripe live key — billing bot"
            />
          </Field>

          <Field
            id="secret-value"
            label={isEdit ? 'New value (rotate)' : 'Value'}
            hint={<>
              Stored encrypted. The value is never returned by the API or shown again.
              {isEdit && ' Rotating saves a new version; the old one stays in History (encrypted) so you can roll back.'}
              {isEdit && ' Leave it blank to change only the scope or description.'}
            </>}
          >
            {isEdit && (
              <div
                data-testid="modal-current-value"
                className="flex items-center justify-between rounded-md border border-dashed border-line bg-surface px-2 py-1.5 text-xs text-fg-3"
              >
                <span>Current value: <span className="font-mono">{'••••••••'}</span> (v{editing?.version})</span>
                <span className="text-xs">write-only — never shown</span>
              </div>
            )}
            <Input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={value}
              onChange={e => setValue(e.target.value)}
              data-testid="modal-value"
              className="font-mono"
            />
          </Field>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={saving}
              data-testid="modal-submit"
            >
              {saving
                ? 'Saving...'
                : isEdit
                  ? (value ? 'Rotate value' : scopeChanged ? 'Move' : 'Save')
                  : multiOrg && workspaces.length > 1
                    ? `Create in ${workspaces.length} workspaces`
                    : 'Create'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
