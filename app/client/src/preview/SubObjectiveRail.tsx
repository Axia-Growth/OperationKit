import type { Objective } from '@operationkit/shared'
import { StatusDot, STATUS_META } from '../components/design/primitives'
import { humanize } from '../lib/format'
import { Eyebrow, cn } from '../components/ui'
import { cardHref, isPlainLeftClick } from './SubCardPopup'

/* Each row is a real link to the sub-card (obj 901083): a plain click calls
   onOpen (the card page opens the sub-card in a pop-up over itself), while
   Cmd/Ctrl/Shift/middle-click keep the browser's own "open in new tab". */
export function SubObjectiveRail({
  items,
  activeId,
  onOpen,
}: {
  items: Objective[]
  activeId?: number
  onOpen: (o: Objective) => void
}) {
  return (
    <aside className="hidden h-full w-[240px] shrink-0 flex-col border-r border-line bg-surface-1 md:flex">
      <div className="border-b border-line px-3 py-2.5">
        <Eyebrow className="block">Sub-cards</Eyebrow>
        <div className="mt-0.5 text-xs text-fg-3">{items.length}</div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 && (
          <li className="px-2 py-6 text-center text-xs text-fg-3">No sub-cards on this card.</li>
        )}
        {items.map(o => (
          <li key={o.id}>
            <a
              href={cardHref(o.id)}
              data-testid={`sub-card-row-${o.id}`}
              aria-current={activeId === o.id ? 'true' : undefined}
              onClick={e => {
                if (!isPlainLeftClick(e)) return
                e.preventDefault()
                onOpen(o)
              }}
              className={cn(
                'mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left no-underline hover:bg-surface-3',
                'transition-colors duration-fast ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50',
              )}
              style={activeId === o.id ? { background: 'var(--accent-tint)' } : undefined}
            >
              <span className="mt-1.5"><StatusDot status={o.status} size={7} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg-0">{o.title.replace(/^worker:\s*/i, '')}</span>
                <span className="mt-0.5 block text-xs text-fg-3">#{o.id} · {STATUS_META[o.status]?.label ?? humanize(o.status)}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </aside>
  )
}
