import { useEffect, useId, useState } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@ui-sdk/react/command'
import { Search } from 'lucide-react'
import { Modal } from './ui/Modal'
import { EmptyState } from './ui/EmptyState'
import { SearchX } from 'lucide-react'
import { parseCardNumberQuery, formatCardNumber } from '../../../shared/card-number'

interface PaletteItem {
  label: string
  /** Extra words the row matches on (old names, synonyms). Never shown:
      the palette lists plain page names, not URL paths (obj 900807). */
  keywords?: string[]
  onSelect: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  items: PaletteItem[]
  /** obj 901080: typing '901075', '#901075' or a pasted card link offers "Open card #901075". */
  onOpenCard?: (id: number) => void
}

/** The palette value of the "open card by number" row (never collides with `<i>:<label>`). */
const OPEN_CARD_VALUE = 'open-card'

/* ⌘K command palette (§09 Layout), on UI SDK Command inside our Modal
   (obj 900819). The Modal is a real dialog: the page behind goes inert, Esc
   and an outside click close it, and focus returns to where it was. Command
   is the WAI-ARIA combobox + listbox: typing filters, ↑/↓ move the
   highlight (aria-activedescendant, so focus stays in the field), Enter runs
   the highlighted page, and an empty result is announced. */
export function CommandPalette({ open, onClose, items, onOpenCard }: CommandPaletteProps) {
  const titleId = useId()
  const [query, setQuery] = useState('')
  useEffect(() => { if (open) setQuery('') }, [open])
  if (!open) return null
  const cardId = onOpenCard ? parseCardNumberQuery(query) : null
  // Values must be unique even if a caller repeats a label.
  const keyed = items.map((item, i) => ({ item, value: `${i}:${item.label}` }))

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={titleId}
      size="lg"
      placement="top"
      panelClassName="overflow-hidden bg-surface-2"
    >
      <h2 id={titleId} className="sr-only">Jump to a page</h2>
      <Command
        loop
        query={query}
        onQueryChange={setQuery}
        onAction={(value) => {
          if (value === OPEN_CARD_VALUE && cardId !== null && onOpenCard) {
            onClose()
            onOpenCard(cardId)
            return
          }
          const hit = keyed.find((k) => k.value === value)
          if (!hit) return
          onClose()
          hit.item.onSelect()
        }}
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-3" />
          <CommandInput
            data-autofocus=""
            aria-label="Jump to a page"
            placeholder="Jump to a page or card #…"
            className="min-w-0 flex-1 bg-transparent text-base text-fg-0 placeholder-fg-3 outline-none"
          />
          <kbd className="font-sans text-xs text-fg-3">Esc</kbd>
        </div>
        <CommandEmpty className="empty:hidden">
          <EmptyState
            compact
            icon={<SearchX className="h-5 w-5" aria-hidden="true" />}
            title="No matches"
            description="No page by that name. Try a shorter word."
            className="py-6"
          />
        </CommandEmpty>
        <CommandList className="max-h-[40vh] overflow-y-auto py-1">
          {cardId !== null && (
            <CommandItem
              key={OPEN_CARD_VALUE}
              value={OPEN_CARD_VALUE}
              label={`Open card ${formatCardNumber(cardId)}`}
              keywords={[query.trim(), String(cardId)]}
              className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-base text-fg-1 transition-colors duration-fast ease-out data-[highlighted]:bg-surface-3 data-[highlighted]:text-fg-0"
            >
              <span className="truncate">Open card <span className="font-mono">{formatCardNumber(cardId)}</span></span>
            </CommandItem>
          )}
          {keyed.map(({ item, value }) => (
            <CommandItem
              key={value}
              value={value}
              label={item.label}
              keywords={item.keywords}
              className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-base text-fg-1 transition-colors duration-fast ease-out data-[highlighted]:bg-surface-3 data-[highlighted]:text-fg-0"
            >
              <span className="truncate">{item.label}</span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </Modal>
  )
}
