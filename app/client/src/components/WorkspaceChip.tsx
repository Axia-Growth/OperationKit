import { Building2 } from 'lucide-react'
import { cn } from './ui'

/* WorkspaceChip — the one way a card-ish row names its workspace (polish F4,
   #900805). Always the DISPLAY label (useWorkspaces().labelOf), never the raw
   slug and never an upper-cased short code, so the board card, the archive
   row and the card search say the same thing. */
export function WorkspaceChip({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-[12rem] shrink-0 items-center gap-1 rounded-full border border-line/80 bg-surface-2 px-1.5 py-px text-xs font-medium text-fg-2',
        className,
      )}
      title={`Workspace: ${label}`}
      data-testid="org-chip"
    >
      <Building2 className="h-2.5 w-2.5 shrink-0 opacity-60" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}
