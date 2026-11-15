/**
 * Per-user secrets card — extracted from AccountSettings.tsx (behavior frozen).
 * Lives in Settings → Secrets → Mine since obj 900681 (was on API & MCP).
 *
 * Every authenticated user can manage their own `user`-scoped secrets here.
 * Values are encrypted server-side and NEVER returned — the list shows a mask,
 * and editing requires re-entering the value.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError } from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { Plus, X } from 'lucide-react'
import { Alert, Button, DataTable, Field, IconButton, Input, Modal, RowActions, SettingsSection, useConfirm, type Column } from '../ui'
import type { SecretSummary, SetSecretRequest } from '@operationkit/shared'

const MASK = '••••••'

export function MySecretsSection() {
  const { user } = useAuth()
  const [secrets, setSecrets] = useState<SecretSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    if (!user) return
    setLoading(true)
    setError('')
    try {
      const data = await api.get<SecretSummary[]>(`/secrets?scopeType=user&userId=${user.id}`)
      setSecrets(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [user?.id])

  async function handleDelete(key: string) {
    if (!user) return
    const ok = await confirm({
      title: 'Delete secret?',
      message: `'${key}' will be permanently removed.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    try {
      await api.del<void>(`/secrets?scopeType=user&userId=${user.id}&key=${encodeURIComponent(key)}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (!user) return null

  const columns: Column<SecretSummary>[] = [
    { key: 'key', header: 'Key', mono: true, cell: s => <span className="text-fg-1">{s.key}</span> },
    {
      key: 'value',
      header: 'Value',
      mono: true,
      cell: () => <span role="img" aria-label="value hidden, write-only" className="text-fg-3">{MASK}</span>,
    },
    { key: 'version', header: 'Version', mono: true, cell: s => `v${s.version}` },
  ]

  return (
    <SettingsSection
      title="My secrets"
      description="Personal secrets scoped to you. Stored encrypted; the value is never shown again after you save it."
      actions={
        <Button
          variant="primary"
          onClick={() => { setEditingKey(null); setModalOpen(true) }}
          leftIcon={<Plus className="h-4 w-4" aria-hidden />}
        >
          New secret
        </Button>
      }
    >
      {error && <Alert tone="alarm" title={error} className="mb-3" />}

      <DataTable
        aria-label="My secrets"
        columns={columns}
        rows={secrets}
        rowKey={s => s.key}
        loading={loading}
        loadingRows={3}
        rowActionsAlways
        rowActions={s => (
          <RowActions
            label={`Actions for ${s.key}`}
            actions={[
              { label: 'Edit', onSelect: () => { setEditingKey(s.key); setModalOpen(true) } },
              { label: 'Delete', onSelect: () => void handleDelete(s.key), danger: true },
            ]}
          />
        )}
        empty={{
          title: 'No personal secrets yet',
          description: 'Add a key only you and your sessions use. Its value is write-only once saved.',
        }}
      />

      {modalOpen && (
        <MySecretModal
          userId={user.id}
          editingKey={editingKey}
          onClose={() => setModalOpen(false)}
          onSaved={async () => { setModalOpen(false); await reload() }}
        />
      )}
      {confirmDialog}
    </SettingsSection>
  )
}

function MySecretModal({ userId, editingKey, onClose, onSaved }: {
  userId: number
  editingKey: string | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const isEdit = editingKey !== null
  const [key, setKey] = useState(editingKey || '')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!key.trim()) { setError('Key is required.'); return }
    if (!value) { setError('Value is required.'); return }
    setSaving(true)
    try {
      const body: SetSecretRequest = { scopeType: 'user', userId, key: key.trim(), value }
      await api.post<SecretSummary>('/secrets', body)
      await onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="my-secret-title" panelClassName="max-w-lg bg-surface-1">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="my-secret-title" className="text-lg font-semibold text-fg-0">{isEdit ? 'Edit secret' : 'New secret'}</h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2 text-fg-3">
            <X className="h-5 w-5" aria-hidden />
          </IconButton>
        </div>
        {error && <Alert tone="alarm" title={error} className="mb-3" />}
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field id="my-secret-key" label={<>Key{isEdit && <span className="ml-1.5 font-normal text-fg-3">(locked)</span>}</>}>
            <Input
              value={key}
              onChange={e => setKey(e.target.value)}
              disabled={isEdit}
              placeholder="e.g. MY_API_KEY"
              className="font-mono"
            />
          </Field>
          <Field
            id="my-secret-value"
            label="Value"
            hint={isEdit ? 'Re-enter the value to set a new version. The current value is never shown.' : undefined}
          >
            <Input
              type="password"
              autoComplete="off"
              value={value}
              onChange={e => setValue(e.target.value)}
              className="font-mono"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
