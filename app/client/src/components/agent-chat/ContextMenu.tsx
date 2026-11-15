import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  createMenuController,
  Menu,
  MenuContent,
  MenuItem as SdkMenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from '@ui-sdk/react/menu'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '../ui/cn'
import { MENU_CONTENT, menuRowClass } from '../ui/Menu'

/* The Bots sidebar menu (obj 900798): a bot's right-click / "⋯" menu and a
   section's "⋯" menu, on the UI SDK menu behavior (obj 900819).

   - Opens at a point (the pointer, or the trigger's corner) and flips or
     shifts to stay on screen.
   - Keyboard (WAI-ARIA menu): focus starts on the first item; ↑/↓/Home/End
     move, typing jumps to a matching item, → opens a submenu and ← / Escape
     closes it, Escape at the top closes and focus returns to what opened it.
   - The current choice in a submenu ("Move to section") is a radio item.
   - On a small touch screen it presents as a bottom sheet and submenus open
     in place, so nothing flies off a 390px screen. */

export interface MenuItem {
  key: string
  label: string
  icon?: ReactNode
  onSelect?: () => void
  /** Opens a submenu. */
  submenu?: MenuItem[]
  danger?: boolean
  disabled?: boolean
  /** A short reason shown under the label (e.g. why it is disabled). */
  hint?: string
  /** Muted text at the right edge (e.g. the id Copy ID copies). */
  detail?: string
  /** A tick: the current choice in a submenu. */
  checked?: boolean
  /** A hairline above this item. */
  separator?: boolean
}

export interface MenuAnchor {
  x: number
  y: number
}

// Same panel and row look as every other menu (ui/Menu); a little wider for hints.
const CONTENT = cn(MENU_CONTENT, 'w-[240px]')
const rowClass = (item: MenuItem) => menuRowClass({ danger: item.danger })

function RowBody({ item, icon }: { item: MenuItem; icon?: ReactNode }) {
  return (
    <>
      <span className="grid h-4 w-4 shrink-0 place-items-center text-current opacity-80" aria-hidden="true">
        {icon ?? item.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.label}</span>
        {item.hint && <span className="block truncate text-xs text-fg-3">{item.hint}</span>}
      </span>
      {item.detail && <span className="max-w-[96px] shrink-0 truncate font-mono text-xs text-fg-3">{item.detail}</span>}
    </>
  )
}

function ActionItem({ item }: { item: MenuItem }) {
  if (item.submenu) {
    return (
      <MenuSub>
        <MenuSubTrigger disabled={item.disabled} className={rowClass(item)}>
          <RowBody item={item} />
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />
        </MenuSubTrigger>
        <MenuSubContent aria-label={item.label} className={CONTENT}>
          <Items items={item.submenu} />
        </MenuSubContent>
      </MenuSub>
    )
  }
  return (
    <SdkMenuItem
      value={item.key}
      label={item.label}
      disabled={item.disabled}
      destructive={item.danger}
      onSelect={() => item.onSelect?.()}
      className={rowClass(item)}
    >
      <RowBody item={item} />
    </SdkMenuItem>
  )
}

/** Splits a list into runs: consecutive items with `checked` set are one
    radio group (one current choice), everything else is a plain action. */
function runs(items: MenuItem[]) {
  const out: { choice: boolean; items: MenuItem[] }[] = []
  for (const item of items) {
    const choice = item.checked !== undefined && !item.submenu
    const last = out[out.length - 1]
    if (last && last.choice === choice && choice) last.items.push(item)
    else out.push({ choice, items: [item] })
  }
  return out
}

function Items({ items }: { items: MenuItem[] }) {
  return (
    <>
      {runs(items).map((run) => {
        const head = run.items[0]
        if (!run.choice) {
          return (
            <div key={head.key} className="contents">
              {head.separator && <MenuSeparator className="my-1 h-px bg-line-soft" />}
              <ActionItem item={head} />
            </div>
          )
        }
        const current = run.items.find((i) => i.checked)
        return (
          <MenuRadioGroup
            key={head.key}
            value={current?.key ?? null}
            onValueChange={(key) => run.items.find((i) => i.key === key)?.onSelect?.()}
          >
            {run.items.map((item) => (
              <div key={item.key} className="contents">
                {item.separator && <MenuSeparator className="my-1 h-px bg-line-soft" />}
                <MenuRadioItem value={item.key} label={item.label} disabled={item.disabled} closeOnSelect className={rowClass(item)}>
                  <RowBody item={item} icon={item.checked ? <Check className="h-4 w-4" /> : item.icon} />
                </MenuRadioItem>
              </div>
            ))}
          </MenuRadioGroup>
        )
      })}
    </>
  )
}

export function ContextMenu({
  label,
  items,
  anchor,
  onClose,
}: {
  /** The menu's accessible name, e.g. "Actions for Dev Bot". */
  label: string
  items: MenuItem[]
  anchor: MenuAnchor
  /** `restoreFocus` is true when the person closed it with Escape or by picking an item. */
  onClose: (restoreFocus: boolean) => void
}) {
  const [menu] = useState(() => createMenuController())
  // What had focus when it opened (the "⋯" button, or the row for a right-click):
  // focus goes back there on close, so a key never drops focus to the page.
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)))
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    let live = true
    void menu.open({ anchor: { x: anchor.x, y: anchor.y } }).then((result) => {
      if (!live) return
      const reason = result.reason
      onCloseRef.current(reason === 'escape-key' || reason === 'item-press')
    })
    return () => {
      live = false
      menu.close()
    }
  }, [menu, anchor.x, anchor.y])

  return createPortal(
    <Menu controller={menu} presentation="auto" loop>
      <MenuContent
        aria-label={label}
        finalFocus={() => (opener && opener !== document.body && opener.isConnected ? opener : null)}
        side="bottom" align="start" collisionPadding={8} className={CONTENT} onContextMenu={(e) => e.preventDefault()}>
        <Items items={items} />
      </MenuContent>
    </Menu>,
    document.body,
  )
}
