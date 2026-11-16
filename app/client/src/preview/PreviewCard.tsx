import { Building2, Folder, GitPullRequest, Pencil } from 'lucide-react'
import type { Objective, ObjectiveStatus } from '@operationkit/shared'
import { AgentMonogram, LiveBadge, STATUS_META } from '../components/design/primitives'
import { Button, Checkbox, IconButton, RowButton } from '../components/ui'
import { PreviewWorkers } from './PreviewWorkers'
import { formatDateTime } from '../lib/format'
import { actionStatusOf, statusActionsFor } from '../lib/statusActions'
import { OwnerTag } from '../components/OwnerTag'
import { CardNumber } from '../components/CardNumber'

export function PreviewCard({
  objective,
  children,
  onOpen,
  onEdit,
  onChangeStatus,
  showOrgChip = false,
  workspaceLabel,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  objective: Objective
  children?: Objective[]
  onOpen: (o: Objective) => void
  onEdit?: (o: Objective) => void
  onChangeStatus: (id: number, status: ObjectiveStatus) => void
  /** When true (All-Organizations view), render the workspace as a prominent chip */
  showOrgChip?: boolean
  /** Display label for a workspace slug (useWorkspaces().labelOf). */
  workspaceLabel?: (slug: string) => string
  /** obj 900869: Needs You bulk triage — show a select box on the card. */
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: (id: number, shiftKey: boolean) => void
}) {
  // obj 900669 — a review card with an agent still running on it is shown in
  // Working by boardColumnOf, so label it Working too (not "Needs You").
  const shownStatus: ObjectiveStatus = actionStatusOf(objective)
  const isLive = shownStatus === 'working' && objective.session_id != null
  const hasThread =
    objective.session_id != null ||
    objective.planning_session_id != null ||
    objective.ai_review_session_id != null ||
    Number(objective.session_count) > 0
  const meta = STATUS_META[shownStatus]
  const actions = statusActionsFor(shownStatus)

  return (
    <article
      className={selectable && selected ? 'cc-ws-card ring-2 ring-[color:var(--accent-line)]' : 'cc-ws-card'}
      data-selected={selectable ? (selected ? '1' : '0') : undefined}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          {selectable ? (
            <Checkbox
              checked={selected}
              onChange={() => { /* handled on click so the shift key is known */ }}
              onClick={e => onToggleSelect?.(objective.id, e.shiftKey)}
              aria-label={`Select #${objective.id} ${objective.title}`}
              data-testid="triage-select"
              className="mt-0.5"
            />
          ) : (
            <AgentMonogram agent={objective.agent_context} size="sm" />
          )}
          <RowButton
            onClick={() => onOpen(objective)}
            data-testid="card-title"
            className="min-w-0 flex-1 break-words rounded-sm text-base font-medium leading-snug text-fg-0 [overflow-wrap:anywhere] hover:text-accent"
          >
            {objective.title}
          </RowButton>
          {onEdit && (
            <IconButton
              size="sm"
              label="Edit card"
              onClick={() => onEdit(objective)}
              className="-my-1 shrink-0 text-fg-3 max-sm:-my-3"
            >
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
        {(objective.last_session_summary || objective.description) && (
          <p data-testid="card-summary" className="mt-1.5 line-clamp-2 min-w-0 break-words pl-7 text-xs leading-relaxed text-fg-2 [overflow-wrap:anywhere]">
            {objective.last_session_summary || objective.description}
          </p>
        )}
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-7 text-xs text-fg-2">
          {/* obj 901080: the card number bots and messages use; click copies it. */}
          <CardNumber id={objective.id} />
          <span className={meta.tone}>{meta.label}</span>
          {isLive && <LiveBadge />}
          {objective.project && <span className="min-w-0 max-w-full truncate" title={objective.project}>{objective.project}</span>}
          {/* obj 900869: the owner — the bot while it works, the person once it needs one. */}
          <OwnerTag objective={objective} />
          {objective.pr_url && (
            <a
              href={objective.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 max-w-full items-center gap-1 text-status-done hover:underline"
              onClick={e => e.stopPropagation()}
            >
              <GitPullRequest className="h-3 w-3 shrink-0" />
              <span className="truncate">PR #{objective.pr_number ?? ''}</span>
            </a>
          )}
          <span className="ml-auto tabular-nums text-fg-3" title={formatDateTime(objective.updated_at).title}>{formatDateTime(objective.updated_at).label}</span>
        </div>
        {/* Board-Project chip + org chip — only rendered when data is present (obj 710597) */}
        {(objective.project_name || (objective.workspace && showOrgChip)) && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 pl-7 text-xs text-fg-2">
            {objective.project_name && (
              <span
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-line px-1.5 py-px"
                title={`Project: ${objective.project_name}`}
                data-testid="project-chip"
              >
                {objective.project_color ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: objective.project_color }}
                    aria-hidden="true"
                  />
                ) : (
                  <Folder className="h-2.5 w-2.5 shrink-0 opacity-60" aria-hidden="true" />
                )}
                <span className="truncate">{objective.project_name}</span>
              </span>
            )}
            {objective.workspace && showOrgChip && (
              <span
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-line/80 bg-surface-2 px-1.5 py-px font-medium"
                title={`Workspace: ${workspaceLabel ? workspaceLabel(objective.workspace) : objective.workspace}`}
                data-testid="org-chip"
              >
                <Building2 className="h-2.5 w-2.5 shrink-0 opacity-60" aria-hidden="true" />
                <span className="truncate">{workspaceLabel ? workspaceLabel(objective.workspace) : objective.workspace}</span>
              </span>
            )}
          </div>
        )}
        {children && children.length > 0 && (
          <PreviewWorkers workers={children} onOpen={onOpen} onEdit={onEdit} />
        )}
        <div className="mt-2 flex min-w-0 flex-wrap items-center justify-end gap-1.5 pl-7">
          {hasThread && (
            <Button size="xs" variant="ghost" onClick={() => onOpen(objective)}>
              View
            </Button>
          )}
          {actions.map((a, i) => (
            <Button
              key={a.target}
              size="xs"
              onClick={() => onChangeStatus(objective.id, a.target)}
              // obj 900750: only the card that is waiting on the human gets the
              // accent (its first action, e.g. Approve). Routine moves are
              // neutral buttons, so the board isn't a wall of brand colour.
              // obj 900807: an accent OUTLINE, not a fill — the board's one
              // filled primary is + New, and three review cards would otherwise
              // put three filled buttons on the page.
              variant="secondary"
              className={objective.status === 'review' && i === 0
                ? 'border-[color:var(--accent-line)] text-accent-hover hover:border-accent'
                : undefined}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>
    </article>
  )
}
