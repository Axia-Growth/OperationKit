/**
 * Delete / reopen / cancel / submit — extracted from ObjectiveModal.tsx
 * (behavior frozen). All four are the shared Button (polish F4, #900805): a
 * disabled Create reads as the neutral disabled token, never a faded accent.
 */
import type { Objective } from '@operationkit/shared'
import { Button } from '../ui'
import { REOPEN_LABEL } from '../../lib/statusActions'

export function FooterActions({
  isEdit,
  loading,
  uploading,
  descHydrated,
  objective,
  onDelete,
  onClose,
  onReopen,
}: {
  isEdit: boolean
  loading: boolean
  uploading: boolean
  descHydrated: boolean
  objective: Objective | null
  onDelete: () => void
  onClose: () => void
  onReopen?: (id: number) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line-soft pt-3">
      {isEdit ? (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            onClick={onDelete}
            disabled={loading}
            className="px-3 text-danger hover:bg-danger/10 hover:text-danger"
          >
            Delete
          </Button>
          {/* Re-open a terminal-state objective (obj 702389) — the reopen
              path for a DONE/cancelled objective found via search. Target
              is 'queue' per VALID_TRANSITIONS (done/cancelled → queue). */}
          {onReopen && objective && (objective.status === 'done' || objective.status === 'cancelled') && (
            <Button type="button" variant="ghost" onClick={() => onReopen(objective.id)} disabled={loading} className="px-3">
              {REOPEN_LABEL}
            </Button>
          )}
        </div>
      ) : (
        <div />
      )}

      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!descHydrated} loading={loading}>
          {uploading ? 'Uploading…' : loading ? 'Saving…' : !descHydrated ? 'Loading…' : isEdit ? 'Update' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
