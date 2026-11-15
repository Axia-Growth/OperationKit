import { useState } from 'react'
import { ChevronRight, Pencil } from 'lucide-react'
import type { Objective } from '@operationkit/shared'
import { StatusDot } from '../components/design/primitives'
import { humanize } from '../lib/format'
import { IconButton, RowButton } from '../components/ui'

function stateLabel(o: Objective): string {
  if (o.status === 'done') return 'done'
  if (o.status === 'working') return o.session_id ? 'running' : 'queued'
  if (o.status === 'ai_review') return 'reviewing'
  if (o.status === 'review') return o.ai_review_verdict === 'fail' ? 'failed review' : 'ready'
  if (o.status === 'queue') return 'queued'
  return humanize(o.status).toLowerCase()
}

export function PreviewWorkers({
  workers,
  onOpen,
  onEdit,
}: {
  workers: Objective[]
  onOpen: (o: Objective) => void
  onEdit?: (o: Objective) => void
}) {
  const [open, setOpen] = useState(true)
  const total = workers.length
  const done = workers.filter(w => w.status === 'done').length
  const ready = workers.filter(w => w.status === 'review').length
  const blocked = workers.filter(w => !!w.has_blockers).length

  return (
    <div className="cc-ws-workers">
      <RowButton className="cc-ws-workers-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>Sub-cards</span>
        <span className="cc-ws-workers-count">{done}/{total}</span>
        {ready > 0 && <span className="cc-ws-workers-flag ready">{ready} ready</span>}
        {blocked > 0 && <span className="cc-ws-workers-flag blocked">{blocked} blocked</span>}
      </RowButton>
      {open && (
        <ul className="cc-ws-workers-list">
          {workers.map(w => (
            <li key={w.id} className="flex items-center gap-0.5">
              <RowButton className="cc-ws-workers-row" onClick={() => onOpen(w)}>
                <StatusDot status={w.status} size={6} />
                <span className="cc-ws-workers-title">{w.title.replace(/^worker:\s*/i, '')}</span>
                <span className="cc-ws-workers-state">{stateLabel(w)}</span>
              </RowButton>
              {onEdit && (
                <IconButton
                  size="sm"
                  label="Edit sub-card"
                  onClick={() => onEdit(w)}
                  className="shrink-0 text-fg-3 max-sm:-my-2.5"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
