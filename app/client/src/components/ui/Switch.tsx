import type { ReactNode } from 'react'
import { Switch as SdkSwitch, SwitchThumb } from '@ui-sdk/react/switch'
import { cn } from './cn'

/* The one on/off switch (obj 900819), on the UI SDK switch behavior:
   role="switch", aria-checked, Space/Enter, a hidden native input when it has
   a `name`, and data-checked / data-disabled for styling. Replaces the three
   hand-rolled copies (Seats, Queue autostart, High Agency).

   With a visible `label` the label sits beside the track and is part of the
   44px tap target. Without one, pass `aria-label`. */

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Visible label beside the track (also the accessible name). */
  label?: ReactNode
  'aria-label'?: string
  'aria-describedby'?: string
  disabled?: boolean
  /** Shows the switch as working and blocks presses (sets aria-busy). */
  busy?: boolean
  id?: string
  name?: string
  className?: string
}

export function Switch({ checked, onChange, label, disabled, busy, className, ...rest }: SwitchProps) {
  return (
    <SdkSwitch
      type="button"
      checked={checked}
      onCheckedChange={(next) => onChange(next)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
      className={cn(
        'group inline-flex min-h-[44px] items-center gap-2.5 rounded-md px-1 text-left text-sm text-fg-1 outline-none transition-colors duration-fast ease-out hover:text-fg-0 focus-visible:ring-2 focus-visible:ring-accent/50 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-base ease-out',
          checked ? 'border-transparent bg-accent' : 'border-line-strong bg-surface-3 group-hover:bg-surface-4',
        )}
      >
        <SwitchThumb
          className={cn(
            'inline-block h-3.5 w-3.5 rounded-full transition-transform duration-base ease-out',
            // Paper knob on the accent track in both themes (QA obj 900621).
            checked ? 'translate-x-[18px] bg-accent-fg' : 'translate-x-[2px] bg-fg-2',
          )}
        />
      </span>
      {label != null && <span>{label}</span>}
    </SdkSwitch>
  )
}
