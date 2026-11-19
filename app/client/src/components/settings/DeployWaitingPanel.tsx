/**
 * Merged, waiting for deploy (obj 901389). Shown on the Jobs page for global
 * admins, next to the other platform panels (Settings → Platform redirects there).
 *
 * The owner deploys; a bot may merge its own passed PRs under a merge grant. This
 * panel lists every commit on origin/main that the live checkout does not have
 * yet — PR, title, card, who merged it, and a flag when it carries a database
 * migration — plus the two "merged is not deployed" checks. READ-ONLY: there is no
 * deploy or restart button here, on purpose.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { Alert, Badge, Button, Card, Skeleton } from '../ui'
import { formatDateTime } from '../../lib/format'

export interface DeployWaitingEntry {
  sha: string
  short_sha: string
  committed_at: string
  pr_number: number | null
  pr_url: string | null
  title: string
  card_id: number | null
  card_title: string | null
  merged_by: { kind: 'bot_grant' | 'auto_merge' | 'person' | 'unknown' }
  merged_by_label: string
  migration: boolean
  migration_paths: string[]
}

export interface DeployStatusView {
  ok: boolean
  disabled?: boolean
  error?: string
  checkout_at_origin_main?: boolean
  server_started_after_last_merge?: boolean | null
  server_started_at?: string
  last_merge_at?: string | null
  waiting: DeployWaitingEntry[]
  migrations_waiting?: number
  live?: boolean
  summary?: string
  note?: string
  ahead?: number
  dirty_served_files?: string[]
}

function errText(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || 'Could not load what is waiting for a deploy.'
  return 'Could not load what is waiting for a deploy.'
}

function Check({ ok, label }: { ok: boolean | null | undefined; label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm text-fg-1">
      <Badge tone={ok === true ? 'verify' : ok === false ? 'amber' : 'neutral'}>{ok === true ? 'Yes' : ok === false ? 'No' : 'Unknown'}</Badge>
      <span>{label}</span>
    </li>
  )
}

export function DeployWaitingPanel() {
  const [state, setState] = useState<DeployStatusView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    api.get<DeployStatusView>('/admin/deploy-status')
      .then(setState)
      .catch(err => setError(errText(err)))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const waiting = state?.waiting ?? []

  return (
    <Card className="my-6 space-y-3" aria-labelledby="deploy-waiting-title">
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex-1 space-y-1">
          <h3 id="deploy-waiting-title" className="font-display text-lg font-semibold tracking-tight text-fg-0">Merged, waiting for deploy</h3>
          <p className="text-sm text-fg-2">
            Pull requests merged to main that are not live yet. A bot may merge under your merge grant; only you deploy.
            Nothing on this panel deploys or restarts anything.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && <Alert tone="alarm">{error}</Alert>}

      {!state && !error ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : state && !state.ok ? (
        <Alert tone={state.disabled ? 'info' : 'amber'}>{state.error ?? state.summary ?? 'What is live is unknown.'}</Alert>
      ) : state ? (
        <>
          <Alert tone={state.live ? 'verify' : (state.migrations_waiting ?? 0) > 0 ? 'amber' : 'info'}>{state.summary}</Alert>
          <ul className="space-y-1.5" aria-label="Is main live?">
            <Check ok={state.checkout_at_origin_main} label="The live checkout is at origin/main" />
            <Check
              ok={state.server_started_after_last_merge}
              label={`The running server started after the last merge${state.server_started_at ? ` (started ${formatDateTime(state.server_started_at).label}` : ''}${state.last_merge_at ? `, last merge ${formatDateTime(state.last_merge_at).label})` : state.server_started_at ? ')' : ''}`}
            />
          </ul>
          {waiting.length === 0 ? (
            <p className="text-sm text-fg-3">Nothing is waiting: every merged pull request is in the live checkout.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line" aria-label="Merged pull requests waiting for a deploy">
              {waiting.map(w => (
                <li key={w.sha} className="flex flex-col gap-1 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {w.pr_number != null ? (
                      w.pr_url ? (
                        <a href={w.pr_url} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent-hover hover:underline">PR #{w.pr_number}</a>
                      ) : (
                        <span className="text-sm font-medium text-fg-1">PR #{w.pr_number}</span>
                      )
                    ) : (
                      <span className="font-mono text-xs text-fg-3">{w.short_sha}</span>
                    )}
                    <span className="flex-1 text-sm text-fg-1">{w.title}</span>
                    {w.migration && <Badge tone="alarm">Database migration</Badge>}
                    {w.merged_by.kind === 'bot_grant' && <Badge tone="accent">Bot merge</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-3">
                    {w.card_id != null && (
                      <a href={`/o/${w.card_id}`} className="hover:underline">Card #{w.card_id}</a>
                    )}
                    <span>Merged by {w.merged_by_label}</span>
                    {w.committed_at && <span title={formatDateTime(w.committed_at).title}>{formatDateTime(w.committed_at).label}</span>}
                    {w.migration && <span className="font-mono">{w.migration_paths.slice(0, 3).join(', ')}{w.migration_paths.length > 3 ? ` +${w.migration_paths.length - 3}` : ''}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {state.note && <p className="text-xs text-fg-3">{state.note}</p>}
        </>
      ) : null}
    </Card>
  )
}
