import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import { Layers } from 'lucide-react'
import { api } from '../../lib/api'
import { cn } from '../ui'
import { NEEDS_YOU_CHANGED_EVENT } from './DecisionQA'
import { NEEDS_YOU_ROUTE } from '../../lib/routes'

/* Top-nav "Needs you" badge (obj 901084): how many decisions are waiting on
   the person, across every bot and card, linking to the stack. Polls the count
   (cheap: GET /api/decisions/queue/count), refreshes when the tab regains focus
   and whenever a decision is answered anywhere in this tab. */

export const NEEDS_YOU_POLL_MS = 30_000

export function useNeedsYouCount(pollMs = NEEDS_YOU_POLL_MS): { count: number | null; refresh: () => Promise<void> } {
  const [count, setCount] = useState<number | null>(null)
  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ count: number }>('/decisions/queue/count')
      setCount(typeof r.count === 'number' ? r.count : 0)
    } catch {
      /* keep the last number; the next tick retries */
    }
  }, [])
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), pollMs)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    window.addEventListener(NEEDS_YOU_CHANGED_EVENT, onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(NEEDS_YOU_CHANGED_EVENT, onFocus)
    }
  }, [refresh, pollMs])
  return { count, refresh }
}

/** "9+" past nine so the pill never widens the bar. */
export function badgeText(n: number): string {
  return n > 9 ? '9+' : String(n)
}

/**
 * A plain link like the rest of the top bar (Layout renders outside the router
 * in tests and does its own client-side navigation through `onClick`).
 */
export function NeedsYouBadge({
  className,
  pollMs,
  active = false,
  onClick,
}: {
  className?: string
  pollMs?: number
  active?: boolean
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void
}) {
  const { count } = useNeedsYouCount(pollMs)
  const n = count ?? 0
  const label = n === 0 ? 'Needs you: nothing waiting' : `Needs you: ${n} decision${n === 1 ? '' : 's'} waiting`
  return (
    <a
      href={NEEDS_YOU_ROUTE}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      data-testid="needs-you-badge"
      data-count={n}
      className={cn(
        // Same footprint as the notifications bell beside it.
        'relative flex items-center justify-center rounded-md p-1.5 outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/60',
        active ? 'bg-surface-selected text-fg-0' : 'text-fg-2 hover:bg-surface-3 hover:text-fg-0',
        className,
      )}
    >
      <Layers className={cn('h-5 w-5', n > 0 && 'text-status-human')} aria-hidden="true" />
      {n > 0 && (
        <span
          data-testid="needs-you-count"
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-human px-1 font-mono text-xs font-medium leading-none text-surface-0"
        >
          {badgeText(n)}
        </span>
      )}
    </a>
  )
}
