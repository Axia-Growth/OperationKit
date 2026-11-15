import { useEffect, useRef, type ReactNode } from 'react'
import { Tabs as TabsRoot, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { cn } from './cn'

export interface TabItem {
  key: string
  label: string
  count?: number
  /** Optional lucide icon before the label (e.g. a pinned thread). */
  icon?: ReactNode
}

/* Tabs — segmented track on the UI SDK tabs behavior (obj 900819): one Tab
   stop, Left/Right/Home/End move and select, and `children` render in the
   selected tab's panel (role=tabpanel, labelled by its tab). The selected
   segment lifts to surface-2. Scrolls sideways on a phone, never the page.

   For a choice that filters one view rather than switching panels (a date
   range, a run kind), use SegmentedControl instead. */
export function Tabs({
  items,
  value,
  onChange,
  label,
  activation = 'automatic',
  className,
  rootClassName,
  panelClassName,
  children,
}: {
  items: TabItem[]
  value: string
  onChange: (key: string) => void
  /** Accessible name of the tab list, e.g. "Settings sections". */
  label?: string
  /** `manual` waits for Enter/Space, for tabs that navigate or load. */
  activation?: 'automatic' | 'manual'
  className?: string
  /** Classes on the root around list + panels (only with `children`), e.g. a
      flex column so the panel can scroll inside a fixed-height popover. */
  rootClassName?: string
  panelClassName?: string
  /** Content of the selected tab. Without it the tabs still drive `value`. */
  children?: ReactNode
}) {
  // On a phone the track scrolls sideways; keep the selected segment in view so a
  // deep link (e.g. /settings/email) does not open with no visible active tab
  // (QA obj 900621). Only the track scrolls, never the page.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !el || list.scrollWidth <= list.clientWidth) return
    const lr = list.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    if (er.left < lr.left) list.scrollLeft -= lr.left - er.left + 12
    else if (er.right > lr.right) list.scrollLeft += er.right - lr.right + 12
  }, [value])
  return (
    <TabsRoot
      value={value}
      onValueChange={(next) => {
        if (next != null) onChange(next)
      }}
      activation={activation}
      className={children == null ? 'contents' : rootClassName}
    >
      <TabsList
        ref={listRef}
        aria-label={label}
        className={cn(
          'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md border border-line bg-surface-3 p-0.5',
          className,
        )}
      >
        {items.map((t) => (
          <TabsTab
            key={t.key}
            value={t.key}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium tracking-tight text-fg-2 transition-colors duration-fast ease-out',
              'hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'data-[selected]:bg-surface-2 data-[selected]:text-fg-0 data-[selected]:shadow-pop data-[selected]:ring-1 data-[selected]:ring-line',
            )}
          >
            {t.icon}
            {t.label}
            {typeof t.count === 'number' && (
              <span className={cn('font-mono text-xs', t.key === value ? 'text-fg-1' : 'text-fg-3')}>{t.count}</span>
            )}
          </TabsTab>
        ))}
      </TabsList>
      {children != null &&
        items.map((t) => (
          <TabsPanel key={t.key} value={t.key} className={cn('focus-visible:outline-none', panelClassName)}>
            {t.key === value ? children : null}
          </TabsPanel>
        ))}
    </TabsRoot>
  )
}
