import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

/* RowButton — the pressable for things that are not shaped like a button:
   a list row, a card title, a disclosure header, a text link that runs an
   action (polish F4, #900805). It brings what every hand-rolled one forgot:
   `type="button"` (so it never submits a surrounding form), left-aligned text,
   the shared transition and a visible keyboard focus ring. It has no fill or
   border of its own; the caller's className sets the layout and hover.
   Use Button / IconButton for anything that looks like a button. */
export const RowButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function RowButton({ type = 'button', className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'text-left transition-colors duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50',
          'disabled:cursor-not-allowed disabled:text-fg-3',
          className,
        )}
        {...rest}
      />
    )
  },
)
