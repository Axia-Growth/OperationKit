import { ShieldCheck } from 'lucide-react'
import type { BotFullAccessSummary } from '@operationkit/shared'
import { Badge, cn } from '../ui'

/* The "this bot has Full access" marker (obj 900972), used in the Bots sidebar
   and on the bot page header. One accent tone, the ui/ Badge primitive, the
   same in light and dark. It only renders while Full access counts right now
   (the server leaves expired and switched-off workspaces out of the summary). */

/** SQLite UTC (`YYYY-MM-DD HH:MM:SS`) or ISO → a Date, or null. */
export function parseServerTime(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "22 Nov 2026" in the person's locale; with the time when it is today or tomorrow. */
export function expiryDate(value: string | null | undefined, now: Date = new Date()): string {
  const d = parseServerTime(value)
  if (!d) return ''
  const soon = d.getTime() - now.getTime() < 48 * 3_600_000
  return d.toLocaleString(undefined, soon
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' })
}

/** The earliest expiry among the workspaces, or null when none of them expires. */
function soonestExpiry(access: BotFullAccessSummary): string | null {
  const dated = access.workspaces.filter(w => w.expires_at).map(w => w.expires_at as string).sort()
  return dated[0] ?? null
}

/** One sentence for the tooltip and for screen readers. */
export function fullAccessSentence(access: BotFullAccessSummary, now: Date = new Date()): string {
  const parts = access.workspaces.map(w => (w.expires_at ? `${w.workspace} (until ${expiryDate(w.expires_at, now)})` : w.workspace))
  return `Full access in ${parts.join(', ')}`
}

export function FullAccessBadge({
  access,
  variant = 'compact',
  className,
}: {
  access?: BotFullAccessSummary | null
  /** compact = the sidebar row; full = the bot page header (names the workspace and the expiry); icon = a pinned tile. */
  variant?: 'compact' | 'full' | 'icon'
  className?: string
}) {
  if (!access || access.workspaces.length === 0) return null
  const sentence = fullAccessSentence(access)
  const expires = soonestExpiry(access)
  const where = access.workspaces.length === 1 ? access.workspaces[0].workspace : `${access.workspaces.length} workspaces`
  if (variant === 'icon') {
    return (
      <span
        data-full-access-badge=""
        title={sentence}
        className={cn('grid h-5 w-5 place-items-center rounded-full border border-[color:var(--accent-line)] bg-surface-1 text-accent-hover', className)}
      >
        <ShieldCheck aria-hidden="true" className="h-3 w-3" />
      </span>
    )
  }
  return (
    <span data-full-access-badge="" title={sentence} className={cn('inline-flex shrink-0', className)}>
      <Badge tone="accent" className="inline-flex items-center gap-1 whitespace-nowrap">
        <ShieldCheck aria-hidden="true" className="h-3 w-3" />
        <span className="sr-only">{sentence}</span>
        <span aria-hidden="true">
          {variant === 'compact' ? 'Full access' : `Full access · ${where}${expires ? ` · until ${expiryDate(expires)}` : ''}`}
        </span>
      </Badge>
    </span>
  )
}
