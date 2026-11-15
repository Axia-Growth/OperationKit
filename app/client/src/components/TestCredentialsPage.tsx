/**
 * Settings → Test Credentials.
 *
 * Lists, creates, edits, and deletes the test credentials the AI Reviewer
 * uses at QA time. Field values are encrypted at rest on the server; the
 * list view shows only field NAMES (values rendered as ***), and the
 * edit modal fetches the single record's plaintext via GET /:slug only when
 * an admin clicks "Edit" or "Reveal".
 *
 * Visibility is determined by workspace-admin role: the server filters the
 * list by the caller's admin memberships, and the modal's workspace
 * dropdown only offers workspaces where the caller has admin role.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { api, ApiError } from '../lib/api'
import { Eye, EyeOff, KeyRound, Plus, X } from 'lucide-react'
import { Alert, Button, DataTable, Field, IconButton, Input, Modal, RowActions, Textarea, useConfirm, type Column } from './ui'
import type {
  CreateTestCredentialRequest,
  TestCredential,
  UpdateTestCredentialRequest,
} from '@operationkit/shared'
import { Select } from './ui/Select'
import { formatDateTime } from '../lib/format'

type FieldRow = { key: string; value: string; revealed: boolean }

function toFieldRows(fields: Record<string, string>): FieldRow[] {
  return Object.entries(fields).map(([k, v]) => ({ key: k, value: v, revealed: false }))
}

function rowsToFields(rows: FieldRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (k) out[k] = r.value
  }
  return out
}

export function TestCredentialsPage({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth()
  const { slugs: wsSlugs } = useWorkspaces()
  const isGlobalAdmin = user?.role === 'admin'

  // Organizations the caller can admin (server enforces too, this just scopes the dropdown).
  const adminWorkspaces = useMemo<string[]>(() => {
    if (isGlobalAdmin) return wsSlugs
    return (user?.workspaces || []).filter(w => w.role === 'admin').map(w => w.workspace)
  }, [isGlobalAdmin, user?.workspaces, wsSlugs])

  const [creds, setCreds] = useState<TestCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TestCredential | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    setLoading(true)
    setError('')
    try {
      const data = await api.get<TestCredential[]>('/test-credentials')
      setCreds(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  async function openEdit(slug: string) {
    // GET /:slug returns the decrypted fields (server checks admin role).
    try {
      const full = await api.get<TestCredential>(`/test-credentials/${encodeURIComponent(slug)}`)
      setEditing(full)
      setModalOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed')
    }
  }

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }

  async function handleDelete(slug: string) {
    if (!(await confirm({
      title: 'Delete test credential?',
      message: `'${slug}' will be permanently removed.`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return
    try {
      await api.del<void>(`/test-credentials/${encodeURIComponent(slug)}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const columns: Column<TestCredential>[] = [
    { key: 'slug', header: 'Slug', mono: true, cell: c => <span className="text-fg-1">{c.slug}</span> },
    { key: 'label', header: 'Label', cell: c => c.label },
    { key: 'workspace', header: 'Workspace', cell: c => <span className="text-fg-2">{c.workspace}</span> },
    { key: 'project', header: 'Project', cell: c => <span className="text-fg-2">{c.project || '—'}</span> },
    {
      key: 'login',
      header: 'Login URL',
      className: 'max-w-[260px] truncate',
      cell: c => (
        <a href={c.login_url} target="_blank" rel="noopener noreferrer" className="truncate text-status-working/80 hover:text-status-working">
          {c.login_url}
        </a>
      ),
    },
    { key: 'updated', header: 'Updated', className: 'whitespace-nowrap', cell: c => <span title={formatDateTime(c.updated_at).title}>{formatDateTime(c.updated_at).label}</span> },
  ]

  if (adminWorkspaces.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-fg-3 text-base">
        Workspace admin role required to manage test credentials.
      </div>
    )
  }

  return (
    <div className={embedded ? '' : 'h-full overflow-y-auto p-6'}>
      <div className={embedded ? '' : 'max-w-5xl mx-auto'}>
        <div className={embedded ? 'mb-4 flex items-center justify-between gap-4' : 'mb-5 flex items-center justify-between gap-4'}>
          <div>
            {!embedded && <h1 className="text-xl font-semibold text-fg-0">Test credentials</h1>}
            <p className={embedded ? 'text-xs text-fg-3' : 'mt-1 text-xs text-fg-3'}>
              Encrypted at rest. Used by the AI Reviewer to log into deliverables during automated QA.
            </p>
          </div>
          <Button
            variant="primary"
            onClick={openCreate}
            leftIcon={<Plus className="h-4 w-4" aria-hidden />}
            className="shrink-0"
          >
            New test credential
          </Button>
        </div>

        {error && <Alert tone="alarm" title={error} className="mb-4" />}

        <DataTable
          aria-label="Test credentials"
          columns={columns}
          rows={creds}
          rowKey={c => c.slug}
          loading={loading}
          loadingRows={4}
          rowActionsAlways
          rowActions={c => (
            <RowActions
              label={`Actions for ${c.slug}`}
              actions={[
                { label: 'Edit', onSelect: () => void openEdit(c.slug) },
                { label: 'Delete', onSelect: () => void handleDelete(c.slug), danger: true },
              ]}
            />
          )}
          empty={{
            icon: <KeyRound className="h-5 w-5" aria-hidden="true" />,
            title: 'No test credentials yet',
            description: 'Add a non-production login so the AI Reviewer can sign in to a deliverable and check it.',
            action: <Button variant="secondary" onClick={openCreate}>Add test credential</Button>,
          }}
        />
      </div>

      {modalOpen && (
        <TestCredentialModal
          existing={editing}
          adminWorkspaces={adminWorkspaces}
          onClose={() => setModalOpen(false)}
          onSaved={async () => {
            setModalOpen(false)
            await reload()
          }}
        />
      )}
      {confirmDialog}
    </div>
  )
}

// ─── Add/Edit modal ─────────────────────────────────────────────────────────

interface ModalProps {
  existing: TestCredential | null
  adminWorkspaces: string[]
  onClose: () => void
  onSaved: () => Promise<void>
}

function TestCredentialModal({ existing, adminWorkspaces, onClose, onSaved }: ModalProps) {
  const isEdit = !!existing
  const [slug, setSlug] = useState(existing?.slug || '')
  const [workspace, setWorkspace] = useState(existing?.workspace || adminWorkspaces[0] || '')
  const [project, setProject] = useState(existing?.project || '')
  const [label, setLabel] = useState(existing?.label || '')
  const [loginUrl, setLoginUrl] = useState(existing?.login_url || '')
  const [notes, setNotes] = useState(existing?.notes || '')
  const [fieldRows, setFieldRows] = useState<FieldRow[]>(
    existing ? toFieldRows(existing.fields) : [{ key: '', value: '', revealed: true }]
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function addField() {
    setFieldRows(rows => [...rows, { key: '', value: '', revealed: true }])
  }

  function removeField(i: number) {
    setFieldRows(rows => rows.filter((_, idx) => idx !== i))
  }

  function updateField(i: number, patch: Partial<FieldRow>) {
    setFieldRows(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const fields = rowsToFields(fieldRows)
    if (Object.keys(fields).length === 0) {
      setError('At least one field is required.')
      return
    }
    setSaving(true)
    try {
      if (isEdit && existing) {
        const body: UpdateTestCredentialRequest = {
          workspace,
          project: project || null,
          label,
          login_url: loginUrl,
          fields,
          notes: notes || null,
        }
        await api.put<TestCredential>(`/test-credentials/${encodeURIComponent(existing.slug)}`, body)
      } else {
        const body: CreateTestCredentialRequest = {
          slug,
          workspace,
          project: project || null,
          label,
          login_url: loginUrl,
          fields,
          notes: notes || null,
        }
        await api.post<TestCredential>('/test-credentials', body)
      }
      await onSaved()
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="test-cred-title" panelClassName="max-w-xl bg-surface-1">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="test-cred-title" className="text-lg font-semibold text-fg-0">
            {isEdit ? 'Edit test credential' : 'New test credential'}
          </h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2 text-fg-3">
            <X className="h-5 w-5" aria-hidden />
          </IconButton>
        </div>

        {error && <Alert tone="alarm" title={error} className="mb-3" />}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="test-cred-slug"
              required
              label={<>Slug{isEdit && <span className="ml-1.5 font-normal text-fg-3">(locked)</span>}</>}
            >
              <Input
                value={slug}
                onChange={e => setSlug(e.target.value)}
                disabled={isEdit}
                placeholder="e.g. staging-admin"
                className="font-mono"
              />
            </Field>
            <Field id="test-cred-workspace" label="Workspace" required>
              <Select
                className="w-full"
                value={workspace}
                onChange={v => setWorkspace(v)}
              >
                {adminWorkspaces.map(ws => (
                  <option key={ws} value={ws}>{ws}</option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="test-cred-label" label="Label" hint="Human-readable name" required>
              <Input
                value={label}
                onChange={e => setLabel(e.target.value)}
              />
            </Field>
            <Field id="test-cred-project" label="Project" optional hint="Project slug, or blank">
              <Input
                value={project}
                onChange={e => setProject(e.target.value)}
              />
            </Field>
          </div>

          <Field id="test-cred-login-url" label="Login URL" required>
            <Input
              type="url"
              value={loginUrl}
              onChange={e => setLoginUrl(e.target.value)}
              placeholder="https://staging.example.com/login"
            />
          </Field>

          <div role="group" aria-labelledby="test-cred-fields-label">
            <div className="mb-1.5 flex items-center justify-between">
              <p id="test-cred-fields-label" className="text-sm font-medium text-fg-1">Fields</p>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={addField}
                leftIcon={<Plus className="h-3.5 w-3.5" aria-hidden />}
              >
                Add field
              </Button>
            </div>
            <div className="space-y-1.5">
              {fieldRows.map((row, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    value={row.key}
                    onChange={e => updateField(i, { key: e.target.value })}
                    aria-label={`Field ${i + 1} name`}
                    placeholder="e.g. username"
                    className="flex-1"
                  />
                  <Input
                    type={row.revealed ? 'text' : 'password'}
                    value={row.value}
                    onChange={e => updateField(i, { value: e.target.value })}
                    aria-label={`Field ${i + 1} value`}
                    className="flex-[2] font-mono"
                  />
                  <IconButton
                    size="sm"
                    label={row.revealed ? 'Hide value' : 'Reveal value'}
                    onClick={() => updateField(i, { revealed: !row.revealed })}
                    className="text-fg-3"
                  >
                    {row.revealed ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={`Remove field ${i + 1}`}
                    onClick={() => removeField(i)}
                    className="text-fg-3 hover:text-danger"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </IconButton>
                </div>
              ))}
            </div>
          </div>

          <Field id="test-cred-notes" label="Notes" optional hint="Context for future operators">
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              className="resize-none"
            />
          </Field>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
