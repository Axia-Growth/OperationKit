import { useId, useState } from 'react'
import type { Objective } from '@operationkit/shared'
import { ChevronDown } from 'lucide-react'
import { StatusDot, STATUS_META } from '../components/design/primitives'
import { humanize } from '../lib/format'
import { Eyebrow, cn } from '../components/ui'
import { Button } from '../components/ui/Button'
import { cardHref, isPlainLeftClick } from './SubCardPopup'

type SubCardListProps = {
  items: Objective[]
  activeId?: number
  onOpen: (o: Objective) => void
}

/* Each row is a real link to the sub-card (obj 901083): a plain click calls
   onOpen (the card page opens the sub-card in a pop-up over itself), while
   Cmd/Ctrl/Shift/middle-click keep the browser's own "open in new tab". */
function SubCardRow({ o, active, onOpen, testIdPrefix }: {
  o: Objective
  active: boolean
  onOpen: (o: Objective) => void
  testIdPrefix: string
}) {
  return (
    <li>
      <a
        href={cardHref(o.id)}
        data-testid={`${testIdPrefix}-${o.id}`}
        aria-current={active ? 'true' : undefined}
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
        style={active ? { background: 'var(--accent-tint)' } : undefined}
      >
        <span className="mt-1.5"><StatusDot status={o.status} size={7} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg-0">{o.title.replace(/^worker:\s*/i, '')}</span>
          <span className="mt-0.5 block text-xs text-fg-3">#{o.id} · {STATUS_META[o.status]?.label ?? humanize(o.status)}</span>
        </span>
      </a>
    </li>
  )
}

/** Desktop (md and up): the sub-cards side rail on the left of the card page. */
export function SubObjectiveRail({ items, activeId, onOpen }: SubCardListProps) {
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
          <SubCardRow key={o.id} o={o} active={activeId === o.id} onOpen={onOpen} testIdPrefix="sub-card-row" />
        ))}
      </ul>
    </aside>
  )
}

/**
 * Narrow screens (below md, obj 901198): the side rail is hidden there, so a
 * parent card shows a collapsible "Sub-cards (n)" bar above the chat instead.
 * Collapsed by default so the chat keeps the screen; rows behave exactly like
 * the rail's (plain tap opens the pop-up, the href still works). Renders
 * nothing when the card has no sub-cards.
 */
export function SubCardsDisclosure({ items, activeId, onOpen, defaultOpen = false }: SubCardListProps & { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const listId = useId()
  if (items.length === 0) return null
  return (
    <section className="shrink-0 border-b border-line bg-surface-1 md:hidden" data-testid="sub-cards-disclosure">
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(v => !v)}
        className="w-full justify-between gap-2 rounded-none px-3 py-2 text-left text-fg-1"
      >
        <span className="min-w-0 flex-1 text-left">Sub-cards ({items.length})</span>
        <ChevronDown
          aria-hidden="true"
          className={cn('h-4 w-4 shrink-0 text-fg-3 transition-transform duration-fast', open && 'rotate-180')}
        />
      </Button>
      {open && (
        <ul id={listId} className="max-h-[40vh] overflow-y-auto px-2 pb-2">
          {items.map(o => (
            <SubCardRow key={o.id} o={o} active={activeId === o.id} onOpen={onOpen} testIdPrefix="sub-card-narrow-row" />
          ))}
        </ul>
      )}
    </section>
  )
}
