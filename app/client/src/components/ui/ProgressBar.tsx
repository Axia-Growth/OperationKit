import { cn } from './cn'

/* ProgressBar — token-bound determinate progress track. `pct` is clamped to
   0-100; `label` names the bar for assistive tech. */
export function ProgressBar({
  pct,
  tone = 'accent',
  label,
  className,
}: {
  pct: number
  tone?: 'accent' | 'amber' | 'alarm'
  label?: string
  className?: string
}) {
  const v = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  return (
    <div
      className={cn('h-2 w-full overflow-hidden rounded-full bg-surface-3', className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300',
          tone === 'amber' ? 'bg-signal-amber' : tone === 'alarm' ? 'bg-signal-alarm' : 'bg-accent',
        )}
        style={{ width: `${v}%` }}
      />
    </div>
  )
}
