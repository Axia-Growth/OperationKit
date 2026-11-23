import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, Button, Field, Input, cn } from '../ui'
import type { ChatAgentInfo } from './types'

/* Long replies (obj 901491). A chat reply that needs many steps (a ten-PR merge
   pass, a long audit) no longer dies at 8 steps or when the browser request
   times out: it carries on in the background and posts its answer in the chat.
   This section is the admin's budget for one reply of this bot: how many steps
   and how many minutes. Empty = the install default. It changes how LONG a
   reply may run, never what the bot is allowed to do. */

export interface TurnJobRecord {
  id: number
  status: 'running' | 'answered' | 'limit' | 'stopped' | 'failed' | 'interrupted'
  background: boolean
  steps: number
  tool_calls: number
  limit_reason: 'steps' | 'time' | null
  started_at: string
  finished_at: string | null
}

export interface TurnLimitsResponse {
  turn_limits: {
    slug: string
    install_enabled: boolean
    max_steps: number | null
    max_minutes: number | null
    updated_at: string | null
    effective: { max_steps: number; max_minutes: number }
    defaults: { max_steps: number; max_minutes: number; foreground_seconds: number }
    ranges: { steps: { min: number; max: number }; minutes: { min: number; max: number } }
  }
  recent: TurnJobRecord[]
}

/** A response with the shape this section reads, else null (never throw on a bad body). */
function valid(r: unknown): TurnLimitsResponse | null {
  const v = r as TurnLimitsResponse | null
  return v && typeof v === 'object' && v.turn_limits && v.turn_limits.effective && v.turn_limits.defaults && v.turn_limits.ranges
    ? { ...v, recent: Array.isArray(v.recent) ? v.recent : [] }
    : null
}

const ENDED: Record<TurnJobRecord['status'], string> = {
  running: 'still running',
  answered: 'answered',
  limit: 'stopped at its limit and said so',
  stopped: 'stopped by the person',
  failed: 'failed',
  interrupted: 'cut off by a restart and said so',
}

/** '' → null (use the default); a whole number → that number; anything else → undefined (invalid). */
function parse(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  return /^\d+$/.test(t) ? Number(t) : undefined
}

export function LongRepliesSection({ agent, isAdmin }: { agent: ChatAgentInfo; isAdmin: boolean }) {
  const url = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/turn-limits`
  const [info, setInfo] = useState<TurnLimitsResponse | null>(null)
  const [steps, setSteps] = useState('')
  const [minutes, setMinutes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const take = (r: TurnLimitsResponse | null) => {
    if (!r) return
    setInfo(r)
    setSteps(r.turn_limits.max_steps === null ? '' : String(r.turn_limits.max_steps))
    setMinutes(r.turn_limits.max_minutes === null ? '' : String(r.turn_limits.max_minutes))
  }

  useEffect(() => {
    let live = true
    setInfo(null)
    setError(null)
    api.get<TurnLimitsResponse>(url)
      .then(r => { if (live) take(valid(r)) })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not load the long-reply limits.') })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const t = info?.turn_limits
  const s = parse(steps)
  const m = parse(minutes)
  const stepsBad = !!t && (s === undefined || (s !== null && (s < t.ranges.steps.min || s > t.ranges.steps.max)))
  const minutesBad = !!t && (m === undefined || (m !== null && (m < t.ranges.minutes.min || m > t.ranges.minutes.max)))
  const dirty = !!t && (s !== t.max_steps || m !== t.max_minutes)

  const save = async () => {
    if (!t || stepsBad || minutesBad) return
    setBusy(true)
    setError(null)
    try {
      take(valid(await api.put<TurnLimitsResponse>(url, { max_steps: s, max_minutes: m })))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const id = (k: string) => `bot-long-replies-${k}-${agent.slug}`
  const last = info?.recent[0]

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id('title')} className="font-display text-sm font-semibold text-fg-0">Long replies</h4>
        <span className={cn('rounded-full px-2 py-0.5 text-xs', t?.install_enabled ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2')} data-testid="long-replies-state">
          {!t ? '…' : !t.install_enabled ? 'Off for this install' : `${t.effective.max_steps} steps · ${t.effective.max_minutes} min`}
        </span>
      </div>
      <p className="text-xs text-fg-2">
        A reply that needs many steps keeps working in the background after about {t?.defaults.foreground_seconds ?? 20} seconds. You can
        leave the page: each action shows in the chat as it happens and the answer is posted there when it is done. If the reply reaches
        the limit below it stops and says what it did, what it did not do and the next step. This sets how long one reply may run. It
        does not change what the bot is allowed to do.
      </p>
      {error && <Alert tone="alarm">{error}</Alert>}
      {t && !t.install_enabled && (
        <p className="text-xs text-fg-2" data-testid="long-replies-off">
          Long replies are switched off for this install, so every reply stops at 8 steps and the page waits for it.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Steps per reply"
          hint={t ? `${t.ranges.steps.min} to ${t.ranges.steps.max}. Empty = the default (${t.defaults.max_steps}).` : undefined}
          error={stepsBad ? `A whole number from ${t!.ranges.steps.min} to ${t!.ranges.steps.max}, or empty.` : undefined}
        >
          <Input size="sm" inputMode="numeric" value={steps} placeholder={t ? String(t.defaults.max_steps) : ''} disabled={!isAdmin || !t || busy} onChange={e => setSteps(e.target.value)} data-testid="long-replies-steps" />
        </Field>
        <Field
          label="Minutes per reply"
          hint={t ? `${t.ranges.minutes.min} to ${t.ranges.minutes.max}. Empty = the default (${t.defaults.max_minutes}).` : undefined}
          error={minutesBad ? `A whole number from ${t!.ranges.minutes.min} to ${t!.ranges.minutes.max}, or empty.` : undefined}
        >
          <Input size="sm" inputMode="numeric" value={minutes} placeholder={t ? String(t.defaults.max_minutes) : ''} disabled={!isAdmin || !t || busy} onChange={e => setMinutes(e.target.value)} data-testid="long-replies-minutes" />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {isAdmin && (
          <Button variant="primary" size="sm" loading={busy} disabled={!t || busy || !dirty || stepsBad || minutesBad} onClick={() => void save()}>
            Save limits
          </Button>
        )}
        <p className="text-xs text-fg-2" data-testid="long-replies-last">
          {!isAdmin
            ? 'Only an admin can change these limits.'
            : last
              ? `Last reply: ${last.steps} ${last.steps === 1 ? 'step' : 'steps'}, ${last.tool_calls} ${last.tool_calls === 1 ? 'action' : 'actions'}, ${ENDED[last.status] ?? last.status}${last.background ? ' (ran in the background)' : ''}.`
              : 'No replies recorded yet.'}
        </p>
      </div>
    </section>
  )
}
