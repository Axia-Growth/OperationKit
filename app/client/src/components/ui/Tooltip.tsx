import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { Tooltip as SdkTooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip'
import { cn } from './cn'

/* Tooltip on the UI SDK tooltip behavior (obj 900819). Shows on hover after a
   short rest and at once on keyboard focus; Escape hides it and focus stays
   put; neighbouring tooltips open instantly once one is showing (a toolbar
   reads as one tip that follows the pointer). It names an icon-only control
   or describes one that already has a name. Plain text only: a tooltip is
   never focusable, so anything interactive belongs in a Popover.

   Replaces native `title=` tooltips, which never show on keyboard focus or
   touch and are read inconsistently by screen readers. */

export const TOOLTIP_CONTENT =
  'z-[70] m-0 max-w-xs rounded-md border border-line bg-surface-4 px-2 py-1 text-xs font-medium text-fg-0 shadow-pop outline-none [transform-origin:var(--transform-origin)] transition-[opacity,transform] duration-fast ease-out data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[instant]:transition-none motion-reduce:transition-none'

export function Tooltip({
  content,
  children,
  side = 'top',
  type,
  delay = 500,
  disabled,
}: {
  /** The tip. A few plain words. */
  content: ReactNode
  /** The trigger: one element (a button or link) that takes a ref. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK render prop merges any props
  children: ReactElement<Record<string, any>>
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** `label` names the trigger, `description` describes it. Guessed when omitted. */
  type?: 'label' | 'description'
  delay?: number
  disabled?: boolean
}) {
  if (!isValidElement(children)) return children
  return (
    <SdkTooltip delay={delay} disabled={disabled} type={type}>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} sideOffset={6} collisionPadding={8} className={cn(TOOLTIP_CONTENT)}>
        {content}
      </TooltipContent>
    </SdkTooltip>
  )
}
