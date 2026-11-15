import { cn } from './cn'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/* SaveIndicator — the ONE save-status label for editors (polish F8).
   DocsPage and FileEditorOverlay used to hand-roll this with three colour
   families (fg-3 / status-done / flag-blocked). It now reads only the semantic
   triad: neutral fg-3 while pending, success when saved, danger on failure.
   `aria-live` so a screen reader hears "Saved" / "Save failed". */
export function SaveIndicator({
  state,
  dirty = false,
  error,
  className,
}: {
  state: SaveState
  /** True when there are unsaved edits (shown as "Unsaved" while idle). */
  dirty?: boolean
  /** Failure detail, shown as the tooltip on "Save failed". */
  error?: string | null
  className?: string
}) {
  let label: string | null = null
  let tone = 'text-fg-3'
  if (state === 'saving') label = 'Saving…'
  else if (state === 'saved') { label = 'Saved'; tone = 'text-success' }
  else if (state === 'error') { label = 'Save failed'; tone = 'text-danger' }
  else if (dirty) label = 'Unsaved'

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="save-indicator"
      data-state={label ? (state === 'idle' ? 'unsaved' : state) : 'idle'}
      title={state === 'error' ? (error ?? undefined) : undefined}
      className={cn('text-xs', tone, !label && 'sr-only', className)}
    >
      {label ?? ''}
    </span>
  )
}
