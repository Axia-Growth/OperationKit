import { Skeleton, SkeletonText } from './ui/Skeleton'

/**
 * AppShellSkeleton — what the app paints while /api/auth/me is still resolving
 * (polish F8). It replaces the bare "Loading..." text App.tsx used to show and
 * picks up exactly where index.html's static #app-shell leaves off, with the
 * same neutral layout: a top bar and a generic page block.
 *
 * Deliberately NOT a board. Auth is unknown at this point, so the visitor may
 * be logged out (next frame is the login card) or deep-linked to /settings —
 * a fake kanban would be a lie in both cases. Keep this in step with the
 * #app-shell markup in index.html (`app-shell-skeleton.test.tsx` checks both).
 */
export function AppShellSkeleton() {
  return (
    <div
      className="flex h-full flex-col bg-surface"
      role="status"
      aria-busy="true"
      aria-label="Loading"
      data-testid="app-shell-skeleton"
    >
      <div className="flex h-12 shrink-0 items-center gap-3.5 border-b border-line px-4">
        {/* Neutral logo placeholder, never a brand glyph (white-label). */}
        <Skeleton className="h-7 w-7 rounded-md" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="ml-auto h-7 w-7 rounded-full" />
      </div>
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-hidden p-4 sm:p-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-1 p-4">
          <SkeletonText lines={3} />
        </div>
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-1 p-4">
          <SkeletonText lines={2} />
        </div>
      </div>
    </div>
  )
}
