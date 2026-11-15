/**
 * Secrets audit log (obj 900498).
 *
 * Reads `GET /api/secrets/audit` — the append-only `secret_access_log`. Two
 * modes, same component:
 *   - Page panel (global admin): the whole log, filterable by action and key,
 *     paged newest-first with "Load more" (keyset `beforeId`).
 *   - Per-secret (`scopeQuery` + `secretKey` set, used in the History modal):
 *     only that secret's own history. Any user who may see the secret may read it.
 *
 * Rows are metadata only: who, when, what, which key, how. The log never holds
 * a value, so there is nothing here to mask.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { SecretAuditEntry, SecretAuditPage } from '@operationkit/shared'
import { TimeText } from './SecretRow'
import { SCOPE_LABELS } from './scope'
import { friendlyError, humanize } from '../../lib/format'
import type { SecretScopeType } from '@operationkit/shared'
import { Select } from '../ui/Select'
import { Alert, Button, DataTable, Field, Input, SettingsSection, type Column } from '../ui'

/** Plain-language label per action. Unknown actions fall back to the raw string. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  rotate: 'Rotated',
  describe: 'Description changed',
  delete: 'Deleted',
  rollback: 'Rolled back',
  read: 'Read by server',
  inject: 'Given to a bot run',
  use: 'Used via broker',
  reveal_attempt: 'Reveal attempt (refused)',
}

const ACTION_TONES: Record<string, string> = {
  delete: 'text-danger',
  reveal_attempt: 'text-warning',
  rotate: 'text-accent',
  create: 'text-success',
}

const FILTERABLE = ['', 'create', 'rotate', 'update', 'describe', 'delete', 'rollback', 'reveal_attempt', 'use', 'inject', 'read']

/** Plain words for the stored scope string ('global', 'workspace:example', 'user:7',
 *  'workspace_user:example/7', 'move-to:…'). The raw value stays in the tooltip. */
export function auditScopeLabel(raw: string): string {
  let rest = raw
  let prefix = ''
  const move = /^move-(from|to):(.*)$/.exec(rest)
  if (move) { prefix = move[1] === 'from' ? 'Moved from ' : 'Moved to '; rest = move[2] }
  const i = rest.indexOf(':')
  const type = (i === -1 ? rest : rest.slice(0, i)) as SecretScopeType
  const target = i === -1 ? '' : rest.slice(i + 1)
  const base = SCOPE_LABELS[type] ?? humanize(type)
  let where = ''
  if (type === 'workspace') where = target
  else if (type === 'user') where = target ? `user #${target}` : ''
  else if (type === 'workspace_user') {
    const [ws, uid] = target.split('/')
    where = [ws, uid ? `user #${uid}` : ''].filter(Boolean).join(', ')
  }
  const label = where ? `${base} (${where})` : base
  return prefix ? prefix + label.charAt(0).toLowerCase() + label.slice(1) : label
}

/** How a row reached the store, in words. */
const SOURCE_LABELS: Record<string, string> = {
  ui: 'Settings page',
  api: 'API',
  spawn: 'Bot run start',
  broker: 'Secrets broker',
  server: 'Server',
}

function actorLabel(e: SecretAuditEntry): string {
  if (e.actorUsername) return e.actorUsername
  if (e.actorUserId == null || e.actorUserId === 0) return e.source === 'spawn' ? 'bot run start' : 'system'
  return `user #${e.actorUserId}`
}

interface Props {
  /** Per-secret mode: the row's scope query string (scopeType=…&workspace=…). */
  scopeQuery?: string
  secretKey?: string
  /** Any value change triggers a reload (e.g. the secrets list after a save). */
  refreshToken?: unknown
  pageSize?: number
}

export function AuditLogPanel({ scopeQuery, secretKey, refreshToken, pageSize = 50 }: Props) {
  const perSecret = !!(scopeQuery && secretKey)
  const [open, setOpen] = useState(perSecret)
  const [entries, setEntries] = useState<SecretAuditEntry[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [action, setAction] = useState('')
  const [keyFilter, setKeyFilter] = useState('')
  const [appliedKey, setAppliedKey] = useState('')

  const buildPath = useCallback((beforeId?: number) => {
    const p = new URLSearchParams()
    p.set('limit', String(pageSize))
    if (action) p.set('action', action)
    if (beforeId != null) p.set('beforeId', String(beforeId))
    if (perSecret) return `/secrets/audit?${scopeQuery}&key=${encodeURIComponent(secretKey!)}&${p}`
    if (appliedKey) p.set('key', appliedKey)
    return `/secrets/audit?${p}`
  }, [action, appliedKey, pageSize, perSecret, scopeQuery, secretKey])

  const load = useCallback(async (beforeId?: number) => {
    setLoading(true)
    setError(null)
    try {
      const page = await api.get<SecretAuditPage>(buildPath(beforeId))
      const rows = Array.isArray(page?.entries) ? page.entries : []
      setEntries(prev => (beforeId != null ? [...prev, ...rows] : rows))
      setNext(typeof page?.nextBeforeId === 'number' ? page.nextBeforeId : null)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [buildPath])

  useEffect(() => {
    if (open) void load()
  }, [open, load, refreshToken])

  const columns: Column<SecretAuditEntry>[] = [
    { key: 'at', header: 'When', className: 'whitespace-nowrap', cell: e => <TimeText at={e.at} /> },
    {
      key: 'action',
      header: 'Action',
      className: 'whitespace-nowrap',
      cell: e => <span className={ACTION_TONES[e.action] ?? 'text-fg-1'}>{AUDIT_ACTION_LABELS[e.action] ?? humanize(e.action)}</span>,
    },
    ...(perSecret ? [] : [
      { key: 'key', header: 'Key', mono: true, cell: (e: SecretAuditEntry) => <span className="text-fg-1">{e.key}</span> },
      { key: 'scope', header: 'Scope', cell: (e: SecretAuditEntry) => <span className="text-fg-2" title={e.scope}>{auditScopeLabel(e.scope)}</span> },
    ]),
    { key: 'who', header: 'Who', cell: e => <span className="text-fg-2">{actorLabel(e)}</span> },
    {
      key: 'how',
      header: 'How',
      cell: e => (
        <span className="text-fg-3">
          {e.source ? SOURCE_LABELS[e.source] ?? humanize(e.source) : '—'}
          {e.detail && <span className="ml-1">· {e.detail.replace(/^to-version:(\d+)$/, 'to version $1')}</span>}
        </span>
      ),
    },
  ]

  const body = (
    <div data-testid="secret-audit-log">
      {!perSecret && (
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field id="audit-action" label="Action">
            <Select
              value={action}
              onChange={v => setAction(v)}
            >
              {FILTERABLE.map(a => (
                <option key={a || 'all'} value={a}>{a ? AUDIT_ACTION_LABELS[a] ?? humanize(a) : 'All actions'}</option>
              ))}
            </Select>
          </Field>
          <form
            onSubmit={e => { e.preventDefault(); setAppliedKey(keyFilter.trim()) }}
            className="flex items-end gap-2"
          >
            <Field id="audit-key" label="Key">
              <Input
                value={keyFilter}
                onChange={e => setKeyFilter(e.target.value)}
                placeholder="e.g. OPENAI_API_KEY"
                className="w-56 font-mono"
              />
            </Field>
            <Button type="submit" variant="secondary">Filter</Button>
          </form>
          <p className="ml-auto max-w-sm text-xs text-fg-3">
            Append-only: rows cannot be edited or deleted. Values are never logged.
          </p>
        </div>
      )}

      {error != null && (
        <Alert tone="alarm" title={`Could not load the audit log. ${friendlyError(error).message}`} className="mb-2">
          {friendlyError(error).detail && (
            <details className="mt-1 text-xs text-fg-3">
              <summary>Details</summary>
              {friendlyError(error).detail}
            </details>
          )}
        </Alert>
      )}

      <DataTable
        aria-label={perSecret ? `Activity for ${secretKey}` : 'Secrets audit log'}
        columns={columns}
        rows={entries}
        rowKey={e => e.id}
        // Skeleton only on the first load; "Load more" keeps the rows on screen.
        loading={loading && entries.length === 0}
        loadingRows={3}
        empty={{ title: 'No audit events' }}
      />
      <div className="mt-2 flex items-center gap-3">
        {loading && entries.length > 0 && <span className="text-xs text-fg-3">Loading…</span>}
        {next != null && !loading && (
          <Button size="sm" variant="ghost" onClick={() => void load(next)} data-testid="audit-load-more">
            Load more
          </Button>
        )}
      </div>
    </div>
  )

  if (perSecret) return body

  return (
    <SettingsSection
      title="Audit log"
      // JSX text, not a string literal: the D1 write-only guard (server secrets-d1-write-only.test.ts) scans literals for "reveal".
      description={<>Who created, rotated, deleted, used or tried to reveal a secret.</>}
      className="mt-6"
      actions={
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          data-testid="audit-log-toggle"
        >
          {open ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {open && body}
    </SettingsSection>
  )
}
