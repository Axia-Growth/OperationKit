/**
 * "Rotate later" list (obj 718944). Secrets the owner pasted into a card chat
 * were moved into the store on the spot and work right away; this is just the
 * reminder that the value was seen in a chat once. Not a blocker. Names only.
 * Hidden for non-admins (the endpoint answers 403) and when the list is empty.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Button, SettingsSection } from '../ui'
import { formatDateTime } from '../../lib/format'

export interface RotationFlag {
  id: number
  workspace: string
  key: string
  objective_id: number | null
  flagged_by: string | null
  created_at: string
}

export function RotationFlagsList({ flags, onResolve, resolving }: {
  flags: RotationFlag[]
  onResolve: (id: number) => void
  resolving: number | null
}) {
  if (flags.length === 0) return null
  return (
    <SettingsSection
      level={3}
      title={<span className="text-status-review">Rotate later · {flags.length}</span>}
      description="Pasted into a card chat, saved to the store and already in use. Rotate when convenient, then mark it done."
      className="mb-4 rounded-lg border border-status-review/30 bg-status-review/5 p-4"
    >
      <ul className="divide-y divide-line">
        {flags.map(f => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <span className="font-mono text-sm font-medium text-fg-0">{f.key}</span>
              <span className="ml-2 text-xs text-fg-2">
                {f.workspace}{f.objective_id ? ` · card #${f.objective_id}` : ''} · <span title={formatDateTime(f.created_at).title}>{formatDateTime(f.created_at).label}</span>
              </span>
            </div>
            <Button size="md" variant="secondary" loading={resolving === f.id} onClick={() => onResolve(f.id)}>
              Rotated
            </Button>
          </li>
        ))}
      </ul>
    </SettingsSection>
  )
}

export function RotationFlagsPanel() {
  const [flags, setFlags] = useState<RotationFlag[]>([])
  const [resolving, setResolving] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    api.get<RotationFlag[]>('/secrets/rotation-flags')
      .then(rows => {
        if (cancelled || !Array.isArray(rows)) return
        setFlags(rows.filter(r => r && typeof r.id === 'number' && typeof r.key === 'string' && typeof r.created_at === 'string'))
      })
      .catch(() => { /* non-admin or unavailable: show nothing */ })
    return () => { cancelled = true }
  }, [])

  const resolve = useCallback(async (id: number) => {
    setResolving(id)
    try {
      await api.post(`/secrets/rotation-flags/${id}/resolve`)
      setFlags(prev => prev.filter(f => f.id !== id))
    } finally {
      setResolving(null)
    }
  }, [])

  return <RotationFlagsList flags={flags} onResolve={id => void resolve(id)} resolving={resolving} />
}
