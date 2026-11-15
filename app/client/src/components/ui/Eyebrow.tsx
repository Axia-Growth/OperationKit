import type { HTMLAttributes } from 'react'
import { cn } from './cn'

/* Eyebrow — the one small-caps label style (polish F1, #900802): 12px,
   semibold, uppercase, one tracking value, quiet text. Use it for section
   labels and table group headers instead of hand-rolled uppercase spans. */
export function Eyebrow({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('text-xs font-semibold uppercase tracking-eyebrow text-fg-3', className)} {...rest} />
}
