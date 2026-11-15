import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { IconButton } from '../components/ui'

/* ColumnScroller — the board's horizontal lane strip (polish F4, #900805).
   At 1440 the fifth column is clipped and nothing said there was more. When
   the strip overflows, the hidden edge fades out and a small arrow button
   pages one column over, so the extra lanes are discoverable without a
   scrollbar hunt. Nothing renders when every lane fits. */
const PAGE_PX = 312 // one 300px lane + the 12px gap

export function ColumnScroller({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 2
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    setEdges(prev => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  // Lanes are added/removed as the data loads; re-measure after each render.
  useEffect(measure)

  const page = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * PAGE_PX, behavior: 'smooth' })

  return (
    <div className="relative flex min-h-0 flex-1">
      <div ref={ref} data-testid="board-columns" className={className}>
        {children}
      </div>
      {edges.left && (
        <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-10 bg-gradient-to-r from-surface-0 to-transparent sm:block">
          <IconButton
            size="sm"
            variant="secondary"
            label="Scroll to earlier columns"
            onClick={() => page(-1)}
            className="pointer-events-auto absolute left-1 top-3 shadow-pop"
          >
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
        </div>
      )}
      {edges.right && (
        <div
          data-testid="board-more-columns"
          className="pointer-events-none absolute inset-y-0 right-0 hidden w-10 bg-gradient-to-l from-surface-0 to-transparent sm:block"
        >
          <IconButton
            size="sm"
            variant="secondary"
            label="Scroll to more columns"
            onClick={() => page(1)}
            className="pointer-events-auto absolute right-1 top-3 shadow-pop"
          >
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      )}
    </div>
  )
}
