import { Skeleton, SkeletonText } from './ui'

/**
 * ContextSkeleton (obj 900867) — the first paint of a cold visit to Context
 * (/knowledge) while the page's code loads: the same layout as the page — the
 * page-list sidebar on the left, the graph on the right — so the tree and the
 * graph fill in where they will appear instead of the generic card grid
 * flashing first. Built only from the shared Skeleton primitives (polish F8
 * #900809 owns those). Small and in the main bundle on purpose.
 */
export function ContextSkeleton() {
  return (
    <div className="flex h-full bg-surface-0" aria-busy="true" aria-label="Loading Context">
      <div className="hidden w-64 flex-col border-r border-line bg-surface-1 md:flex">
        <div className="flex items-center justify-between gap-2 border-b border-line-soft p-3">
          <div className="px-0.5 text-lg font-semibold tracking-tight text-fg-0">Context</div>
          <Skeleton className="h-7 w-14" />
        </div>
        <div className="flex flex-col gap-3 p-3">
          <Skeleton className="h-9 w-full" />
          <SkeletonText lines={8} />
        </div>
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-1 px-3 py-2">
          <div className="text-xs font-medium text-fg-0">Graph</div>
          <Skeleton className="h-7 w-40" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-5">
          <Skeleton className="h-6 w-80 max-w-full" />
          <Skeleton className="h-9 w-full sm:w-72" />
          <Skeleton className="min-h-[360px] w-full flex-1 rounded-md" />
        </div>
      </div>
    </div>
  )
}
