import { BOT_LIVE_STATE_LABELS, type BotLiveState, type BotStatusEntry } from '@operationkit/shared'
import { cn } from '../ui'

/* Bot visibility pieces shared by the sidebar, the Work tab and the feed
   (obj 900947). Token-only colours: the ONE accent marks "waiting on you"
   (the same --st-human the board's Needs You uses), the working tone marks
   running, neutral marks idle — so light/dark and a white-label accent come
   for free and no brand colour is hard-coded. */

const DOT: Record<BotLiveState, string> = {
  waiting: 'bg-status-human',
  running: 'bg-status-working',
  idle: 'bg-fg-3/60',
}

/** The status dot: running, waiting on you, or idle. */
export function BotStatusDot({ state, className }: { state: BotLiveState; className?: string }) {
  return (
    <span
      data-testid="bot-status-dot"
      data-state={state}
      title={BOT_LIVE_STATE_LABELS[state]}
      className={cn('relative inline-flex h-2 w-2 shrink-0 rounded-full', DOT[state], className)}
    >
      {state === 'running' && (
        <span aria-hidden="true" className="absolute inset-0 animate-ping rounded-full bg-status-working opacity-40 motion-reduce:hidden" />
      )}
      <span className="sr-only">{BOT_LIVE_STATE_LABELS[state]}</span>
    </span>
  )
}

/** The live line under a bot's name: dot + "Working on #900936 · 2 in review". */
export function BotLiveLine({ entry, className }: { entry: BotStatusEntry; className?: string }) {
  return (
    <span data-testid="bot-live-line" data-state={entry.state} className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <BotStatusDot state={entry.state} />
      <span className={cn('min-w-0 truncate text-xs tabular-nums', entry.state === 'waiting' ? 'font-medium text-status-human' : 'text-fg-2')}>
        {entry.line}
      </span>
    </span>
  )
}

/** "$3.20" — two decimals, never a currency symbol from a locale. */
export function usd(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`
}

/** "2h ago", "just now", or a date. Accepts SQLite `YYYY-MM-DD HH:MM:SS` (UTC). */
export function ago(iso: string, now = Date.now()): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  const ms = now - d.getTime()
  if (!Number.isFinite(ms)) return ''
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Wall-clock time for a feed row, e.g. "2:14 PM". */
export function clock(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
