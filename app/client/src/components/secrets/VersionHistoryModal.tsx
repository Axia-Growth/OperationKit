/**
 * Secret version history + rollback — extracted from SecretsPage.tsx
 * (behavior frozen).
 */
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { X } from 'lucide-react'
import { Alert, Button, DataTable, IconButton, Modal, SectionHeader, useConfirm, type Column } from '../ui'
import type {
  SecretSummary,
  SecretVersionSummary,
  RollbackSecretRequest,
} from '@operationkit/shared'
import { SCOPE_LABELS, scopeQuery, type Scope } from './scope'
import { AuditLogPanel } from './AuditLogPanel'
import { formatDateTime } from '../../lib/format'

interface VersionHistoryProps {
  /** The ROW's scope — history and rollback always address the row itself. */
  scope: Scope
  secretKey: string
  onClose: () => void
  onRolledBack: () => Promise<void>
}

export function VersionHistoryModal({ scope, secretKey, onClose, onRolledBack }: VersionHistoryProps) {
  const [versions, setVersions] = useState<SecretVersionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { confirm, confirmDialog } = useConfirm()
  const q = scopeQuery(scope)

  useEffect(() => {
    let cancelled = false
    api.get<SecretVersionSummary[]>(`/secrets/versions?${q}&key=${encodeURIComponent(secretKey)}`)
      .then(data => { if (!cancelled) { setVersions(data); setLoading(false) } })
      .catch(err => { if (!cancelled) { setError(err instanceof Error ? err.message : 'Load failed'); setLoading(false) } })
    return () => { cancelled = true }
  }, [q, secretKey])

  async function handleRollback(toVersion: number) {
    if (!(await confirm({
      title: `Roll back to v${toVersion}?`,
      message: `This re-applies v${toVersion}'s value as a new version (history is append-only).`,
      confirmLabel: 'Roll back',
    }))) return
    try {
      const body: RollbackSecretRequest = {
        scopeType: scope.scopeType,
        workspace: scope.workspace ?? undefined,
        userId: scope.userId ?? undefined,
        key: secretKey,
        toVersion,
      }
      await api.post<SecretSummary>('/secrets/rollback', body)
      await onRolledBack()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed')
    }
  }

  const columns: Column<SecretVersionSummary>[] = [
    {
      key: 'version',
      header: 'Version',
      cell: v => (
        <span className="text-fg-1">
          v{v.version}
          {v.version === versions[0]?.version && <span className="ml-1 text-xs uppercase text-accent">current</span>}
        </span>
      ),
    },
    {
      key: 'by',
      header: 'Changed by',
      cell: v => (
        <span className="text-fg-2">
          {v.changedBy ?? '—'}
          {/* obj 719065: an agent-relayed value names the relaying agent */}
          {v.via && <span className="mt-0.5 block text-xs leading-snug text-fg-3">via {v.via}</span>}
        </span>
      ),
    },
    {
      key: 'when',
      header: 'When',
      mono: true,
      cell: v => <span title={formatDateTime(v.changedAt).title}>{formatDateTime(v.changedAt).label}</span>,
    },
  ]

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="secret-history-title" panelClassName="max-w-2xl bg-surface-1">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="secret-history-title" className="text-lg font-semibold text-fg-0">
            Version history — <span className="font-mono text-lg">{secretKey}</span>
          </h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2 text-fg-3">
            <X className="h-5 w-5" aria-hidden />
          </IconButton>
        </div>

        <p className="mb-3 text-xs text-fg-3">
          Scope: <span className="text-fg-2">{SCOPE_LABELS[scope.scopeType]}</span>
          {scope.workspace && <span className="text-fg-2"> · {scope.workspace}</span>}
          {scope.userId != null && <span className="text-fg-2"> · user #{scope.userId}</span>}
        </p>

        {error && <Alert tone="alarm" title={error} className="mb-3" />}

        <DataTable
          aria-label={`Versions of ${secretKey}`}
          columns={columns}
          rows={versions}
          rowKey={v => v.version}
          loading={loading}
          loadingRows={3}
          empty={{ title: 'No version history' }}
          rowActionsAlways
          // The newest version is current; every older one can be re-applied.
          rowActions={v => (v.version === versions[0]?.version ? null : (
            <Button size="sm" variant="ghost" onClick={() => void handleRollback(v.version)}>Roll back</Button>
          ))}
        />

        {/* obj 900498 — this secret's own audit trail (who rotated / used / tried to reveal it). */}
        <SectionHeader title="Activity" level={3} className="mb-2 mt-5" />
        <AuditLogPanel scopeQuery={q} secretKey={secretKey} pageSize={20} />
      </div>
      {confirmDialog}
    </Modal>
  )
}
