import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from './cn'

/* Alert — inline message banner. Tone maps to the semantic triad; the only red
   is `alarm`. Tinted surface + matching hairline + a leading status dot. Use
   for inline form/section feedback (not transient — see Toast for that).
   An `alarm` Alert is role=alert (announced at once); every other tone is a
   polite role=status. `action` puts a button (Retry, Dismiss) on the right. */
type Tone = 'info' | 'verify' | 'amber' | 'alarm' | 'accent'

const TONE: Record<Tone, { wrap: string; dot: string; title: string }> = {
  info:   { wrap: 'border-status-working/30 bg-status-working/10', dot: 'bg-status-working', title: 'text-status-working' },
  verify: { wrap: 'border-success/30 bg-success/10',   dot: 'bg-success',  title: 'text-success' },
  amber:  { wrap: 'border-warning/30 bg-warning/10',     dot: 'bg-warning',   title: 'text-warning' },
  alarm:  { wrap: 'border-danger/30 bg-danger/10',     dot: 'bg-danger',   title: 'text-danger' },
  accent: { wrap: 'border-[color:var(--accent-line)] bg-[var(--accent-tint)]', dot: 'bg-accent', title: 'text-accent-hover' },
}

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  role,
  className,
  'data-testid': testId,
}: {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  /** Right-aligned control (Retry, Dismiss…). */
  action?: ReactNode
  /** Defaults to alert for the alarm tone, status otherwise. */
  role?: 'alert' | 'status'
  className?: string
  'data-testid'?: string
}) {
  const t = TONE[tone]
  return (
    <div
      role={role ?? (tone === 'alarm' ? 'alert' : 'status')}
      data-testid={testId}
      className={cn('flex gap-2.5 rounded-md border p-3', t.wrap, className)}
    >
      <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', t.dot)} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        {title && <p className={cn('font-medium', t.title)}>{title}</p>}
        {children && <div className="text-fg-2">{children}</div>}
      </div>
      {action && <div className="-my-1 flex shrink-0 items-start gap-1">{action}</div>}
    </div>
  )
}

/* Toast — the same language as Alert but for transient, floating feedback.
   Render inside a fixed container; surface-3 + float shadow (overlay = shadow OK). */
export function Toast({
  tone = 'info',
  title,
  children,
  onDismiss,
  className,
}: {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  onDismiss?: () => void
  className?: string
}) {
  const t = TONE[tone]
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex w-[320px] max-w-[calc(100vw-2rem)] gap-2.5 rounded-lg border border-line bg-surface-3 p-3 shadow-float',
        className,
      )}
    >
      <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', t.dot)} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        {title && <p className={cn('font-medium', t.title)}>{title}</p>}
        {children && <div className="text-fg-2">{children}</div>}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 grid h-6 w-6 shrink-0 place-items-center rounded text-fg-3 transition-colors duration-fast hover:bg-surface-4 hover:text-fg-1"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
