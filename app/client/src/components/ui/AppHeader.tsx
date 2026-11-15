import type { ReactNode } from 'react'
import { cn } from './cn'

/* AppHeader — the compact title row for the two full-bleed apps, Context and
   Bots chat (obj 900807). Those pages have no PageContainer (they fill the
   viewport with a sidebar + pane), so PageHeader's 24px title and bottom
   margin do not fit. This is the one header they share: a 16px semibold
   title, an optional count/subtitle, and right-aligned actions, on a 48px
   row. The Bots sidebar heading uses the same type (text-lg semibold, tight
   tracking), so the two apps read as one family. */
export function AppHeader({
  title,
  subtitle,
  actions,
  as: Tag = 'h1',
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  /** Heading level; h1 when this is the page's only title. */
  as?: 'h1' | 'h2'
  className?: string
}) {
  return (
    <div data-app-header="" className={cn('flex min-h-[48px] items-center justify-between gap-2 px-3 py-2', className)}>
      <div className="flex min-w-0 items-baseline gap-2">
        <Tag className="truncate px-0.5 text-lg font-semibold tracking-tight text-fg-0">{title}</Tag>
        {subtitle && <span className="truncate text-xs text-fg-3">{subtitle}</span>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  )
}
