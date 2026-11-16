import type { ReactNode } from 'react'
import { cn } from './cn'

/* PageContainer (a.k.a. PageShell) — the responsive wrapper EVERY route sits in.
   Guarantees: a sane max-width, consistent 4pt-grid gutters that tighten on
   mobile, vertical scroll within the Layout's <main>, and — critically — ZERO
   horizontal overflow at 390px (overflow-x-clip + min-w-0). Compose a page as
   <PageContainer><PageHeader/>…</PageContainer>. */
export function PageContainer({
  children,
  width = 'default',
  className,
  scroll = 'container',
}: {
  children: ReactNode
  /** default = 1200px reading width · wide = 1600px for dense tables · full = fluid */
  width?: 'default' | 'wide' | 'full'
  className?: string
  /** container = this wrapper is the scroller (inside a fixed-height shell).
   *  page = no inner scroller; the document scrolls. Pair with Layout's
   *  pageScroll (obj 900680) or the shell's <main> will clip the bottom. */
  scroll?: 'container' | 'page'
}) {
  const max =
    width === 'full' ? 'max-w-none' : width === 'wide' ? 'max-w-[1600px]' : 'max-w-[1200px]'
  return (
    // `relative` (obj 901139): the scroller is the containing block for absolute
    // descendants, so an sr-only label can never escape it and make the DOCUMENT
    // taller than the screen (a second scroller that stole the swipe on phones).
    <div data-testid="page-scroller" className={scroll === 'page' ? 'overflow-x-clip' : 'relative h-full overflow-y-auto overflow-x-clip'}>
      <div className={cn('mx-auto w-full min-w-0 px-4 py-5 sm:px-6 sm:py-7', max, className)}>
        {children}
      </div>
    </div>
  )
}
