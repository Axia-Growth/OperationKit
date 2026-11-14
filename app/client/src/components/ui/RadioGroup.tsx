import { useId, type ReactNode } from 'react'
import { Radio, RadioGroup as Root } from '@ui-sdk/react/radio'
import { cn } from './cn'

export interface RadioOption<T extends string = string> {
  value: T
  label: ReactNode
  /** A line under the label; becomes the radio's description. */
  description?: ReactNode
  /** Extra content on the label row (a badge). Not part of the accessible name. */
  aside?: ReactNode
  disabled?: boolean
}

/* RadioGroup — pick one of a few options, on the UI SDK radio (obj 900819):
   role=radiogroup with one Tab stop, arrow keys move AND check, a disabled
   option is skipped, and a disabled <fieldset> around it disables it. Each
   option is the whole clickable surface (a card or a segment), named by its
   label and described by its description.

   `card` = bordered choice cards (lay them out with `className`, e.g. a grid);
   `segment` = a compact track like SegmentedControl, for when the options are
   a form field rather than a view filter. For a choice that filters the
   current view, use SegmentedControl; to switch panels, Tabs. */
export function RadioGroup<T extends string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  describedBy,
  disabled,
  variant = 'card',
  className,
}: {
  options: RadioOption<T>[]
  value: T | null
  onChange: (value: T) => void
  /** Accessible name. Use this or `labelledBy` (a legend / heading id). */
  label?: string
  labelledBy?: string
  describedBy?: string
  disabled?: boolean
  variant?: 'card' | 'segment'
  className?: string
}) {
  const id = useId()
  return (
    <Root<T>
      value={value}
      onValueChange={(next) => {
        if (next != null) onChange(next)
      }}
      disabled={disabled}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={cn(
        'relative', // contains the SDK's absolutely-positioned form proxies
        variant === 'segment' ? 'grid gap-1 rounded-md border border-line bg-surface-1 p-1' : 'grid gap-2',
        className,
      )}
    >
      {options.map((o) => {
        const labelId = `${id}-${o.value}-label`
        const descId = o.description != null ? `${id}-${o.value}-desc` : undefined
        return (
          <Radio
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            aria-labelledby={labelId}
            aria-describedby={descId}
            className={cn(
              'group outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/50',
              'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
              variant === 'segment'
                ? cn(
                    'min-h-[44px] rounded px-2 text-sm font-medium text-fg-2 sm:min-h-[32px]',
                    'hover:bg-surface-3 hover:text-fg-0',
                    'data-[checked]:bg-surface-3 data-[checked]:text-fg-0 data-[checked]:shadow-sm data-[checked]:ring-1 data-[checked]:ring-line-strong',
                  )
                : cn(
                    'rounded-md border border-line bg-surface-1 p-3 text-left hover:border-line-strong',
                    'data-[checked]:border-accent data-[checked]:bg-[var(--accent-tint)]',
                  ),
            )}
          >
            {variant === 'segment' ? (
              <span id={labelId}>{o.label}</span>
            ) : (
              <>
                <span className="flex items-center justify-between gap-2">
                  <span id={labelId} className="text-sm font-medium text-fg-0">{o.label}</span>
                  {o.aside}
                </span>
                {o.description != null && (
                  <span id={descId} className="mt-1 block text-xs leading-snug text-fg-2 group-data-[checked]:text-fg-1">
                    {o.description}
                  </span>
                )}
              </>
            )}
            {variant === 'segment' && o.description != null && (
              <span id={descId} className="sr-only">{o.description}</span>
            )}
          </Radio>
        )
      })}
    </Root>
  )
}
