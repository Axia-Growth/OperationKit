import { SegmentedControl as Root, SegmentedControlItem } from '@ui-sdk/react/segmented-control'
import { cn } from './cn'
import type { TabItem } from './Tabs'

/* SegmentedControl — pick one of a few options that filter or change the
   current view (date range, metric, run kind), on the UI SDK segmented
   control: a radio group with one Tab stop and arrow keys. Same track as
   Tabs, so the two read as one family; Tabs is for switching panels. */
export function SegmentedControl({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: TabItem[]
  value: string
  onChange: (key: string) => void
  /** Accessible name, e.g. "Date range". Required: a radio group needs one. */
  label: string
  className?: string
}) {
  return (
    <Root
      value={value}
      onValueChange={(next) => {
        if (next != null) onChange(next)
      }}
      aria-label={label}
      className={cn(
        'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md border border-line bg-surface-3 p-0.5',
        className,
      )}
    >
      {items.map((t) => (
        <SegmentedControlItem
          key={t.key}
          value={t.key}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium tracking-tight text-fg-2 transition-colors duration-fast ease-out',
            'hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            'data-[checked]:bg-surface-2 data-[checked]:text-fg-0 data-[checked]:shadow-pop data-[checked]:ring-1 data-[checked]:ring-line',
          )}
        >
          {t.label}
          {typeof t.count === 'number' && (
            <span className={cn('font-mono text-xs', t.key === value ? 'text-fg-1' : 'text-fg-3')}>{t.count}</span>
          )}
        </SegmentedControlItem>
      ))}
    </Root>
  )
}
