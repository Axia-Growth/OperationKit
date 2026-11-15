import { Skeleton, SkeletonText } from './ui/Skeleton'

/** EditorSkeleton — placeholder for a document body while a knowledge-base
 *  page or file loads (polish F8: replaces the bare "Loading file…" text in
 *  DocsPage and FileEditorOverlay). Mirrors a page: a title line, then body
 *  paragraphs. */
export function EditorSkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-8 sm:px-12"
      role="status"
      aria-busy="true"
      aria-label="Loading file"
      data-testid="editor-skeleton"
    >
      <Skeleton className="h-7 w-1/2 max-w-sm" />
      <SkeletonText lines={4} />
      <SkeletonText lines={3} />
      <SkeletonText lines={5} />
    </div>
  )
}
