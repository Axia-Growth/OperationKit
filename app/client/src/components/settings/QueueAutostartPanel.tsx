/**
 * Queue auto-start (obj 900625), shown on the Jobs page (moved there from
 * Settings → Platform in obj 900686). Admin only: JobsBoard renders it for
 * global admins and the API is under /api/admin.
 *
 * One switch per workspace. ON means: queued task/bug cards in that workspace start
 * on their own when a session slot and a seat are free — but only cards that enter
 * the queue after the switch was turned on, or whose start hit the session cap.
 * The backlog that was already queued is never swept up.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { Alert, Badge, Button, Card, Input, Skeleton, cn } from '../ui'
import { Switch } from '../ui/Switch'
import { formatDateTime } from '../../lib/format'
import { QUEUE_AUTOSTART_ANCHOR } from '../../lib/routes'

export interface QueueAutostartWorkspace {
  workspace: string
  enabled: boolean
  source: 'setting' | 'env' | 'setting+env'
  enabled_at: string
  ceiling_policy: 'enforce' | 'observe' | 'off'
  ceiling_policy_source: string
  ceiling_configured: boolean
  ceiling_source: string
}

export interface JobTimeLimit {
  minutes: number | null
  source: 'workspace' | 'global' | 'none'
}

export interface QueueAutostartState {
  workspaces: QueueAutostartWorkspace[]
  max_concurrent: number
  max_concurrent_source: string
  in_flight: number
  grace_minutes: number
  time_limits?: Record<string, JobTimeLimit>
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback
  if (err instanceof Error) return err.message || fallback
  return fallback
}

function minutesLabel(workspace: string, state: QueueAutostartState | null): string {
  const tl = state?.time_limits?.[workspace]
  if (tl?.minutes == null) return ''
  return String(tl.minutes)
}

export function QueueAutostartPanel() {
  const { slugs, labelOf } = useWorkspaces()
  const [state, setState] = useState<QueueAutostartState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    api.get<QueueAutostartState>('/admin/queue-autostart')
      .then(setState)
      .catch(err => setError(errText(err, 'Could not load the queue auto-start setting.')))
  }, [])
  useEffect(load, [load])

  const byWorkspace = useMemo(() => new Map((state?.workspaces ?? []).map(w => [w.workspace, w])), [state])
  const rows = useMemo(() => {
    const all = slugs.filter(s => s !== 'all')
    for (const w of state?.workspaces ?? []) if (!all.includes(w.workspace)) all.push(w.workspace)
    return all
  }, [slugs, state])

  // Seed each row's editable draft from the fetched state, once, so a save in
  // flight (or a value the admin is mid-typing) is never clobbered by a reload.
  useEffect(() => {
    if (!state) return
    setDrafts(prev => {
      let changed = false
      const next = { ...prev }
      for (const ws of rows) {
        if (next[ws] === undefined) {
          next[ws] = minutesLabel(ws, state)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [state, rows])

  const toggle = async (workspace: string, enabled: boolean) => {
    setBusy(workspace)
    setError('')
    try {
      setState(await api.put<QueueAutostartState>(`/admin/queue-autostart/${encodeURIComponent(workspace)}`, { enabled }))
    } catch (err) {
      setError(errText(err, 'Saving the queue auto-start setting failed.'))
    } finally {
      setBusy(null)
    }
  }

  const saveTimeLimit = async (workspace: string) => {
    const trimmed = (drafts[workspace] ?? '').trim()
    let minutes: number | null
    if (trimmed === '') {
      minutes = null
    } else {
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n < 1 || n > 24 * 60) {
        setError('Job time limit must be a whole number of minutes between 1 and 1440 (24 hours), or blank to clear it.')
        return
      }
      minutes = n
    }
    setBusy(`${workspace}:time-limit`)
    setError('')
    try {
      const next = await api.put<QueueAutostartState>(
        `/admin/queue-autostart/${encodeURIComponent(workspace)}/time-limit`,
        { minutes },
      )
      setState(next)
      setDrafts(prev => ({ ...prev, [workspace]: minutesLabel(workspace, next) }))
    } catch (err) {
      setError(errText(err, 'Saving the job time limit failed.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card id={QUEUE_AUTOSTART_ANCHOR} className="scroll-mt-4 space-y-3" aria-labelledby="queue-autostart-title">
      <div className="space-y-1">
        <h3 id="queue-autostart-title" className="font-display text-lg font-semibold tracking-tight text-fg-0">Queue auto-start</h3>
        <p className="text-sm text-fg-2">
          Queued task and bug cards start on their own when a session slot and a seat are free. Only cards that enter the
          queue after you switch a workspace on — or whose start hit the session limit — are started; the existing backlog is
          left alone. Held cards and cards waiting on another card are skipped.
        </p>
      </div>

      {error && <Alert tone="alarm">{error}</Alert>}

      {!state ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-md border border-line" aria-label="Queue auto-start by workspace">
            {rows.map(ws => {
              const on = byWorkspace.get(ws)
              const envLocked = !!on && on.source !== 'setting'
              const timeLimit = state.time_limits?.[ws]
              const draft = drafts[ws] ?? ''
              const dirty = draft.trim() !== minutesLabel(ws, state).trim()
              const savingTimeLimit = busy === `${ws}:time-limit`
              return (
                <li key={ws} className="flex flex-col gap-1.5 px-3 py-1.5">
                  <div className="flex min-h-[44px] flex-wrap items-center gap-2">
                    <span className="flex-1 text-sm text-fg-1">{labelOf(ws)}</span>
                    {on && !on.ceiling_configured && on.ceiling_policy === 'enforce' && (
                      <Badge tone="amber">No job ceiling — cards will not start</Badge>
                    )}
                    {on && on.ceiling_policy === 'observe' && <Badge tone="info">Unbudgeted starts allowed</Badge>}
                    {envLocked && <Badge tone="neutral">Set by server env</Badge>}
                    {on && <span className="text-xs text-fg-3" title={formatDateTime(on.enabled_at).title}>since {formatDateTime(on.enabled_at).label}</span>}
                    <Switch
                      checked={!!on}
                      onChange={v => void toggle(ws, v)}
                      disabled={busy !== null || (envLocked && !!on)}
                      aria-label={`Queue auto-start for ${labelOf(ws)}`}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pb-1">
                    <label htmlFor={`time-limit-${ws}`} className="text-xs text-fg-3">Job time limit (minutes)</label>
                    <Input
                      id={`time-limit-${ws}`}
                      size="sm"
                      className="w-24"
                      type="number"
                      min={1}
                      max={24 * 60}
                      step={1}
                      inputMode="numeric"
                      placeholder="No limit set"
                      value={draft}
                      onChange={e => setDrafts(prev => ({ ...prev, [ws]: e.target.value }))}
                      disabled={busy !== null}
                      aria-label={`Job time limit in minutes for ${labelOf(ws)}`}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void saveTimeLimit(ws)}
                      disabled={busy !== null || !dirty}
                      loading={savingTimeLimit}
                    >
                      Save
                    </Button>
                    {!timeLimit?.minutes && <span className="text-xs text-fg-3">No limit set</span>}
                    {timeLimit?.source === 'global' && (
                      <span className="text-xs text-fg-3">(from the global default)</span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-fg-3">
            Cards bots start on their own are stopped after this many minutes, counted across every attempt.
          </p>
          <p className="text-xs text-fg-3">
            At most {state.max_concurrent} auto-started cards run at once ({state.in_flight} running now). A new card waits{' '}
            {state.grace_minutes} min before it is eligible. A workspace needs a finite job ceiling unless its policy is set to observe.
          </p>
        </>
      )}
    </Card>
  )
}
