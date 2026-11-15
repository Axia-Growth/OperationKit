import type { ComponentProps, ReactNode } from 'react'
import {
  Menu as SdkMenu,
  MenuContent as SdkMenuContent,
  MenuGroup as SdkMenuGroup,
  MenuGroupLabel as SdkMenuGroupLabel,
  MenuItem as SdkMenuItem,
  MenuSeparator as SdkMenuSeparator,
  MenuTrigger as SdkMenuTrigger,
} from '@ui-sdk/react/menu'
import { cn } from './cn'

/* Dropdown menu on the UI SDK menu behavior (obj 900819): the WAI-ARIA menu
   pattern — arrows, Home/End, typeahead, Escape and outside click to close,
   focus back to the trigger — in our tokens. One look for every menu: the
   account menu, the Bots context menu and any "⋯" menu. */

/** Panel classes, shared with the Bots context menu. */
export const MENU_CONTENT =
  'z-[60] m-0 max-h-[min(70vh,420px)] min-w-[200px] overflow-y-auto rounded-lg border border-line bg-surface-1 p-1 text-fg-1 shadow-pop outline-none cc-pop-in'
/** Row classes, shared with the Bots context menu. ≥40px tall on touch. */
export const MENU_ROW =
  'flex min-h-[40px] w-full cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none transition-colors duration-fast sm:min-h-[34px] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45'

export function menuRowClass(opts: { danger?: boolean; current?: boolean } = {}) {
  return cn(
    MENU_ROW,
    opts.danger
      ? 'text-danger hover:bg-danger/10 focus:bg-danger/10'
      : opts.current
        ? 'bg-surface-selected text-fg-0 focus:bg-surface-3'
        : 'text-fg-1 hover:bg-surface-3 hover:text-fg-0 focus:bg-surface-3 focus:text-fg-0',
  )
}

export const Menu = SdkMenu
export const MenuTrigger = SdkMenuTrigger

export function MenuContent({ className, ...props }: ComponentProps<typeof SdkMenuContent> & { className?: string }) {
  return <SdkMenuContent collisionPadding={8} {...props} className={cn(MENU_CONTENT, className)} />
}

export function MenuItem({
  icon,
  danger,
  current,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof SdkMenuItem>, 'children' | 'className'> & {
  icon?: ReactNode
  danger?: boolean
  /** The page this item links to is the one showing (sets aria-current). */
  current?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <SdkMenuItem
      destructive={danger}
      aria-current={current ? 'page' : undefined}
      {...props}
      className={cn(menuRowClass({ danger, current }), className)}
    >
      {icon && (
        <span className={cn('grid h-4 w-4 shrink-0 place-items-center', current ? 'text-accent' : 'text-fg-3')} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </SdkMenuItem>
  )
}

export function MenuSeparator() {
  return <SdkMenuSeparator className="my-1 h-px bg-line-soft" />
}

export const MenuGroup = SdkMenuGroup

export function MenuGroupLabel({ className, ...props }: ComponentProps<typeof SdkMenuGroupLabel> & { className?: string }) {
  return <SdkMenuGroupLabel {...props} className={cn('px-2.5 pb-1.5 pt-1 text-sm text-fg-3', className)} />
}
