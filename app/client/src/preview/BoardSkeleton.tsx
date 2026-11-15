import { Skeleton } from '../components/ui/Skeleton'

/** BoardSkeleton — the board's own loading state (polish F8), replacing the
 *  bare "Loading board…" text. Mirrors the loaded layout: one header row, then
 *  fixed-width columns of card placeholders (one column on a phone, like the
 *  real board's horizontal scroller shows). */
export function BoardSkeleton() {
  const cols = [3, 2, 2, 1]
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label="Loading board" data-testid="board-skeleton">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <Skeleton className="h-8 w-28 rounded-md" />
        <Skeleton className="h-8 w-24 rounded-md" />
        <Skeleton className="ml-auto h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-16 rounded-md" />
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-3 sm:p-4">
        {cols.map((cards, c) => (
          <div key={c} className="cc-ws-col w-[300px] shrink-0 overflow-hidden">
            <div className="flex items-center px-3 py-2.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="ml-auto h-3 w-4" />
            </div>
            <div className="space-y-2 px-2 pb-3">
              {Array.from({ length: cards }).map((_, i) => (
                <div key={i} className="flex gap-2.5 rounded-md border border-line bg-surface-1 p-3">
                  <Skeleton className="h-6 w-6 shrink-0 rounded" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className={i % 2 ? 'h-3 w-3/5' : 'h-3 w-4/5'} />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-2/5" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
