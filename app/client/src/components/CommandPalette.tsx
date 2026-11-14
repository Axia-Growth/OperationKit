import { useId } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@ui-sdk/react/command'
import { NavIcon } from './nav-icons'
import { Modal } from './ui/Modal'

interface PaletteItem {
  label: string
  hint?: string
  onSelect: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  items: PaletteItem[]
}

/* ⌘K command palette (§09 Layout), on UI SDK Command inside our Modal
   (obj 900819). The Modal is a real dialog: the page behind goes inert, Esc
   and an outside click close it, and focus returns to where it was. Command
   is the WAI-ARIA combobox + listbox: typing filters, ↑/↓ move the
   highlight (aria-activedescendant, so focus stays in the field), Enter runs
   the highlighted page, and an empty result is announced. */
export function CommandPalette({ open, onClose, items }: CommandPaletteProps) {
  const titleId = useId()
  if (!open) return null
  // Values must be unique; two rows can share a label (e.g. Settings).
  const keyed = items.map((item, i) => ({ item, value: `${i}:${item.hint ?? item.label}` }))

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="top-[12vh] bottom-auto mt-0 max-w-lg overflow-hidden bg-surface-2"
    >
      <h2 id={titleId} className="sr-only">Jump to a page</h2>
      <Command
        loop
        onAction={(value) => {
          const hit = keyed.find((k) => k.value === value)
          if (!hit) return
          onClose()
          hit.item.onSelect()
        }}
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
          <NavIcon name="search" className="h-4 w-4 shrink-0 text-fg-3" />
          <CommandInput
            data-autofocus=""
            aria-label="Jump to a page"
            placeholder="Jump to a page…"
            className="min-w-0 flex-1 bg-transparent text-base text-fg-0 placeholder-fg-3 outline-none"
          />
          <kbd className="font-mono text-xs text-fg-3">esc</kbd>
        </div>
        <CommandEmpty className="px-3 py-3 text-base text-fg-3 empty:p-0">No matches</CommandEmpty>
        <CommandList className="max-h-[40vh] overflow-y-auto py-1">
          {keyed.map(({ item, value }) => (
            <CommandItem
              key={value}
              value={value}
              label={item.label}
              keywords={item.hint ? [item.hint] : undefined}
              className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-base text-fg-1 transition-colors duration-fast ease-out data-[highlighted]:bg-surface-3 data-[highlighted]:text-fg-0"
            >
              <span className="truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 font-mono text-xs text-fg-3">{item.hint}</span>}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </Modal>
  )
}
