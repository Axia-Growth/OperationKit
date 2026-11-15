import type { ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './Menu'
import { cn } from './cn'

/* RowActions (polish F5, obj 900806) — the "⋯" menu at the end of a table or
   list row. Replaces rows of coloured text links (History / Edit / Delete) and
   stacked red "Remove" buttons: one quiet ghost trigger, destructive items last
   and in danger text behind a separator. Each item still runs its own confirm
   (useConfirm) — the menu is not the confirmation. */
export interface RowAction {
  label: string
  onSelect: () => void
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
}

export function RowActions({
  label,
  actions,
  className,
}: {
  /** Accessible name, e.g. "Actions for OPENAI_API_KEY". */
  label: string
  actions: RowAction[]
  className?: string
}) {
  const safe = actions.filter((a) => !a.danger)
  const danger = actions.filter((a) => a.danger)
  return (
    <Menu>
      <MenuTrigger
        aria-label={label}
        className={cn(
          'inline-grid min-h-[44px] min-w-[44px] place-items-center rounded-md text-fg-2 outline-none sm:min-h-8 sm:min-w-8',
          'transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0 focus-visible:ring-2 focus-visible:ring-accent/50 data-[open]:bg-surface-3 data-[open]:text-fg-0',
          className,
        )}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </MenuTrigger>
      <MenuContent align="end" className="min-w-[180px]">
        {safe.map((a) => (
          <MenuItem key={a.label} value={a.label} label={a.label} icon={a.icon} disabled={a.disabled} onSelect={a.onSelect}>
            {a.label}
          </MenuItem>
        ))}
        {safe.length > 0 && danger.length > 0 && <MenuSeparator />}
        {danger.map((a) => (
          <MenuItem key={a.label} value={a.label} label={a.label} icon={a.icon} disabled={a.disabled} danger onSelect={a.onSelect}>
            {a.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
