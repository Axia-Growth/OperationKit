/**
 * Secrets table columns + row menu — extracted from SecretsPage.tsx.
 *
 * obj 900749: the Value cell reads as write-only (lock + mask, no action can
 * reveal it), the version rides with "Updated" instead of its own column, and
 * a Bot access cell shows whether bots may use this NAME through the broker
 * (Off = default-deny; Never = seat/server-only; else the allowed hosts).
 *
 * Polish F5 (obj 900806): the list is a ui/DataTable. This file supplies its
 * columns and the row "⋯" menu (History / Edit / Bot access, Delete last).
 */
import { Lock } from 'lucide-react'
import { formatDateTime } from '../../lib/format'
import type { SecretSummary } from '@operationkit/shared'
import type { Column } from '../ui/DataTable'
import { RowActions, type RowAction } from '../ui/RowActions'
import {
  BADGE_BASE, MASK, SCOPE_HINTS, SCOPE_TONES, scopeBadgeLabel,
} from './scope'
import type { BotAccessStatus } from './botAccess'

/** Relative time ("5 minutes ago") with the local absolute time in the tooltip. */
export function TimeText({ at }: { at: string | null | undefined }) {
  if (!at) return <>—</>
  const { label, title } = formatDateTime(at)
  return <span title={title}>{label}</span>
}

function BotAccessCell({ status, onClick }: { status: BotAccessStatus | null; onClick?: () => void }) {
  if (!status) return <span className="text-fg-3">—</span>
  if (status.kind === 'never') {
    return <span data-bot-access="never" className="text-xs text-fg-3" title="Seat and server-only secrets can never be used by bots">Never</span>
  }
  const chip = status.kind === 'on'
    ? <span data-bot-access="on" title={status.title} className={`${BADGE_BASE} max-w-[14rem] truncate border-status-working/40 bg-surface-2 font-mono text-status-working`}>{status.label}</span>
    : <span data-bot-access="off" title="No bot can use this secret (default)" className="text-xs text-fg-3">Off</span>
  if (!onClick) return chip
  return (
    <button type="button" onClick={onClick} data-testid="secret-bot-access" className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
      {chip}
    </button>
  )
}

interface ColumnDeps {
  orgName: (slug: string | null) => string
  userName: (id: number | null) => string
  /** null = bot access not loaded / not shown to this caller. */
  botAccess: (s: SecretSummary) => BotAccessStatus | null
  /** undefined = this row's bot access cannot be edited. */
  onBotAccess: (s: SecretSummary) => (() => void) | undefined
}

/** Scope · Name · Value · Bot access · Updated · Last used. */
export function secretColumns({ orgName, userName, botAccess, onBotAccess }: ColumnDeps): Column<SecretSummary>[] {
  return [
    {
      key: 'scope',
      header: 'Scope',
      cell: s => (
        <span
          data-testid="secret-scope-badge"
          data-scope={s.scopeType}
          title={SCOPE_HINTS[s.scopeType]}
          className={`${BADGE_BASE} ${SCOPE_TONES[s.scopeType]}`}
        >
          {scopeBadgeLabel(s, orgName, userName)}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      cell: s => (
        <>
          <div className="font-mono text-xs text-fg-1">{s.key}</div>
          {s.description && (
            <div data-testid="secret-description" className="mt-0.5 max-w-xs truncate text-xs text-fg-3" title={s.description}>
              {s.description}
            </div>
          )}
        </>
      ),
    },
    {
      key: 'value',
      header: 'Value',
      mono: true,
      cell: () => (
        <span
          role="img"
          aria-label="value hidden, write-only"
          title="Write-only: never shown after saving"
          className="inline-flex items-center gap-1 font-mono text-fg-3"
        >
          <Lock aria-hidden className="h-3 w-3" />{MASK}
        </span>
      ),
    },
    {
      key: 'bot',
      header: <span title="Which hosts a bot may send this secret to. Off = no bot can use it.">Bot access</span>,
      cell: s => <BotAccessCell status={botAccess(s)} onClick={onBotAccess(s)} />,
    },
    {
      key: 'updated',
      header: 'Updated',
      className: 'whitespace-nowrap',
      cell: s => (
        <span data-testid="secret-updated" className="text-xs text-fg-3">
          <span className="text-fg-2">v{s.version}</span> · <TimeText at={s.updatedAt} />
        </span>
      ),
    },
    {
      key: 'used',
      header: 'Last used',
      className: 'whitespace-nowrap',
      cell: s => (
        <span data-testid="secret-last-used" className="text-xs text-fg-3">
          {s.lastUsedAt ? <TimeText at={s.lastUsedAt} /> : 'never'}
        </span>
      ),
    },
  ]
}

/** The row "⋯" menu. Delete is last and in danger text; it confirms on its own. */
export function SecretRowActions({ secret, onBotAccess, onHistory, onEdit, onDelete }: {
  secret: SecretSummary
  onBotAccess?: () => void
  onHistory: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const actions: RowAction[] = [
    { label: 'History', onSelect: onHistory },
    { label: 'Edit', onSelect: onEdit },
    ...(onBotAccess ? [{ label: 'Bot access', onSelect: onBotAccess }] : []),
    { label: 'Delete', onSelect: onDelete, danger: true },
  ]
  return <RowActions label={`Actions for ${secret.key}`} actions={actions} />
}
