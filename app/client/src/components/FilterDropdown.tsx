import { useState, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover'
import { cn } from './ui/cn'
import { Check, ChevronDown } from 'lucide-react'

/**
 * A compact "label ▾" trigger with a popover panel (obj 900666).
 *
 * The board header used to stack three full-width chip rows (org, project,
 * owner). Each is now one of these, so the whole filter set fits on one line
 * next to Search / Archive / New. The panel content is supplied by the caller;
 * this component only owns open/close, on the UI SDK popover behavior (obj
 * 900819): the trigger toggles it, Escape and an outside click close it, focus
 * moves into the panel and back to the trigger, and `close()` is handed to the
 * content for "pick and go".
 */
export interface FilterDropdownProps {
  /** Small dimmed prefix inside the trigger, e.g. "Project". */
  label: string
  /** Current value shown after the label. */
  value: ReactNode
  /** Optional leading icon in the trigger. */
  icon?: ReactNode
  /** Accessible name of the trigger. Defaults to `${label}: …`. */
  ariaLabel?: string
  /** Panel width class. */
  panelClassName?: string
  /** Panel alignment relative to the trigger. */
  align?: 'left' | 'right' | 'center'
  /** Highlight the trigger (a non-default filter is active). */
  active?: boolean
  testId?: string
  /** Extra trigger classes (e.g. a top-bar size). */
  triggerClassName?: string
  title?: string
  children: (close: () => void) => ReactNode
}

export function FilterDropdown({
  label, value, icon, ariaLabel, panelClassName = "w-64", align = "left", active = false,
  testId, triggerClassName = "", title, children,
}: FilterDropdownProps) {
  const [open, setOpen] = useState(false)
  const sdkAlign = align === "right" ? "end" : align === "center" ? "center" : "start"

  return (
    <div className="relative shrink-0" data-testid={testId}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          type="button"
          aria-label={ariaLabel}
          title={title}
          data-dropdown-trigger=""
          className={cn(
            "inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border bg-surface-2 px-2.5 py-1.5 text-sm outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/60",
            active ? "border-accent/60" : "border-line hover:border-line-strong",
            triggerClassName,
          )}
        >
          {icon}
          <span className="shrink-0 text-fg-3">{label}</span>
          <span className="truncate font-medium text-fg-0">{value}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          aria-label={ariaLabel ?? label}
          side="bottom"
          align={sdkAlign}
          sideOffset={6}
          collisionPadding={8}
          data-dropdown-panel=""
          className={cn("z-50 m-0 max-h-[min(70vh,480px)] overflow-y-auto rounded-md border border-line bg-surface-1 py-1 text-fg-1 shadow-pop outline-none cc-pop-in", panelClassName)}
        >
          {children(() => setOpen(false))}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** One selectable row inside a FilterDropdown panel. */
export function DropdownOption({
  selected, onClick, children, multi = false, trailing, ...rest
}: {
  selected: boolean
  onClick: () => void
  children: ReactNode
  /** Multi-select rows draw a checkbox; single-select rows a check on the right. */
  multi?: boolean
  trailing?: ReactNode
} & Record<`data-${string}`, string | number | undefined>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      {...rest}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-base transition-colors duration-fast ease-out ${
        selected ? 'bg-surface-selected text-fg-0' : 'text-fg-1 hover:bg-surface-3 hover:text-fg-0'
      }`}
    >
      {multi && (
        <span
          aria-hidden="true"
          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
            selected ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong'
          }`}
        >
          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
      {!multi && selected && <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />}
    </button>
  )
}
