import { useEffect, useMemo, useState } from 'react'
import {
  DELEGATION_ACTION_LABELS,
  DELEGATION_ACTIONS,
  type DelegationAction,
  type DelegationGrant,
  type DelegationGrantsResponse,
} from '@operationkit/shared'
import { api } from '../../lib/api'
import { Alert, Button, cn } from '../ui'
import { Switch } from '../ui/Switch'
import { Select } from '../ui/Select'
import type { ChatAgentInfo } from './types'

/* "Approve on my behalf" (obj 900839), on the bot's settings panel.

   Worker cards only accept a merge, prod migration or deploy approval from the
   owner. Here the owner can let this bot approve on their behalf: one
   workspace, the actions ticked, until a date. The server checks the grant on
   every approval the bot sends; anything not covered is refused.

   Only the owner, signed in here, can switch it on, add a grant or revoke one.
   A bot can never grant or extend its own approvals, and a grant can't be
   edited, only revoked and issued again. */

const EXPIRY_PRESETS = [
  { value: '1', label: '24 hours' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
]

function when(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ActionChips({ actions }: { actions: DelegationAction[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {actions.map(a => (
        <span key={a} className="rounded-full bg-[var(--accent-tint)] px-2 py-0.5 text-xs text-accent-hover">
          {DELEGATION_ACTION_LABELS[a]}
        </span>
      ))}
    </span>
  )
}

export function DelegationSection({ agent, isAdmin }: { agent: Pick<ChatAgentInfo, 'slug' | 'name'>; isAdmin: boolean }) {
  const [data, setData] = useState<DelegationGrantsResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [workspace, setWorkspace] = useState('')
  const [actions, setActions] = useState<DelegationAction[]>([])
  const [days, setDays] = useState('7')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const url = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/delegations`

  useEffect(() => {
    if (!isAdmin) return
    let live = true
    setLoadError(null)
    api.get<DelegationGrantsResponse>(url)
      .then(r => { if (live) setData(r) })
      .catch(e => { if (live) setLoadError(e instanceof Error ? e.message : 'Could not load approval grants') })
    return () => { live = false }
  }, [url, isAdmin])

  const active = useMemo(() => (data?.grants ?? []).filter(g => g.state === 'active'), [data])
  const past = useMemo(() => (data?.grants ?? []).filter(g => g.state !== 'active'), [data])
  const canManage = !!data?.can_manage
  const on = active.length > 0 || formOpen
  const options = data?.workspace_options ?? []
  const chosenWs = options.some(o => o.slug === workspace) ? workspace : options[0]?.slug ?? ''
  const wsLabel = (slug: string) => {
    const o = options.find(x => x.slug === slug)
    return o && o.name && o.name !== slug ? `${o.name} (${slug})` : slug
  }
  const id = (k: string) => `bot-delegation-${k}-${agent.slug}`

  const run = async (key: string, fn: () => Promise<DelegationGrantsResponse>, done: string) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      setData(await fn())
      setNotice(done)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work')
      return false
    } finally {
      setBusy(null)
    }
  }

  const grant = async () => {
    const expires = new Date(Date.now() + Number(days) * 86_400_000).toISOString()
    const ok = await run(
      'grant',
      () => api.post<DelegationGrantsResponse>(url, { workspace: chosenWs, actions, expires_at: expires }),
      `${agent.name} can now approve ${actions.map(a => DELEGATION_ACTION_LABELS[a]).join(', ')} in ${chosenWs} on your behalf.`,
    )
    if (ok) {
      setFormOpen(false)
      setActions([])
    }
  }

  const revoke = (g: DelegationGrant) =>
    run(`revoke:${g.id}`, () => api.del<DelegationGrantsResponse>(`${url}/${g.id}`), `Revoked grant #${g.id}.`)

  const switchOff = async () => {
    setFormOpen(false)
    for (const g of active) {
      const ok = await run(`revoke:${g.id}`, () => api.del<DelegationGrantsResponse>(`${url}/${g.id}`), `Revoked every grant. ${agent.name} can't approve on your behalf.`)
      if (!ok) return
    }
  }

  const toggleAction = (a: DelegationAction) =>
    setActions(prev => (prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]))

  const badge = !isAdmin || !data ? null : active.length ? `${active.length} active` : 'Off'

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id('title')} className="font-display text-sm font-semibold text-fg-0">Approve on my behalf</h4>
        {badge && (
          <span className={cn('rounded-full px-2 py-0.5 text-xs', active.length ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2')}>
            {badge}
          </span>
        )}
      </div>
      <p id={id('help')} className="text-xs text-fg-2">
        Cards only accept a merge, prod migration or deploy approval from you. Let {agent.name} approve the actions you tick, in one workspace, until the date you pick. Each approval it sends is checked against the grant, written on the card and logged. Anything outside the grant is refused.
      </p>

      {!isAdmin && <p className="text-xs text-fg-2">Only the owner can set this.</p>}
      {loadError && <Alert tone="alarm">{loadError}</Alert>}
      {data && !data.bot && <Alert tone="info">{data.bot_unavailable_reason}</Alert>}

      {data?.bot && (
        <>
          <Switch
            checked={on}
            disabled={!canManage || busy !== null}
            busy={busy !== null && busy.startsWith('revoke')}
            onChange={v => { setNotice(null); setError(null); if (v) setFormOpen(true); else void switchOff() }}
            aria-describedby={id('help')}
            label={<span className="font-medium text-fg-0">Approve on my behalf</span>}
          />
          {!canManage && (
            <p className="-mt-2 text-xs text-fg-2">Sign in here in the browser to change grants. API keys and bots can't change them.</p>
          )}

          {active.length > 0 && (
            <ul aria-label={`Active grants for ${agent.name}`} className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface-0">
              {active.map(g => (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm text-fg-0">
                      Grant #{g.id} · {wsLabel(g.workspace)}
                    </span>
                    <ActionChips actions={g.actions} />
                    <span className="text-xs text-fg-2">Expires {when(g.expires_at)} · granted by {g.granted_by}</span>
                  </span>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Revoke grant #${g.id}`}
                      loading={busy === `revoke:${g.id}`}
                      disabled={busy !== null}
                      onClick={() => void revoke(g)}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canManage && on && (formOpen || active.length === 0) && (
            <fieldset className="flex flex-col gap-3 rounded-md border border-line bg-surface-1 p-3">
              <legend className="px-1 text-xs font-medium text-fg-1">New grant</legend>
              <div className="flex flex-wrap gap-3">
                <div className="min-w-[200px] flex-1">
                  <label htmlFor={id('ws')} className="mb-1 block text-xs font-medium text-fg-1">Workspace</label>
                  <Select id={id('ws')} value={chosenWs} onChange={setWorkspace} disabled={busy !== null} className="w-full">
                    {options.map(o => <option key={o.slug} value={o.slug}>{wsLabel(o.slug)}</option>)}
                  </Select>
                </div>
                <div className="min-w-[140px]">
                  <label htmlFor={id('exp')} className="mb-1 block text-xs font-medium text-fg-1">Expires after</label>
                  <Select id={id('exp')} value={days} onChange={setDays} disabled={busy !== null} className="w-full" options={EXPIRY_PRESETS} />
                </div>
              </div>
              <div role="group" aria-labelledby={id('actions')} className="flex flex-col gap-1">
                <span id={id('actions')} className="text-xs font-medium text-fg-1">May approve</span>
                <div className="flex flex-wrap gap-x-4">
                  {DELEGATION_ACTIONS.map(a => (
                    <label key={a} className="flex min-h-[44px] items-center gap-2 text-sm text-fg-0">
                      <input type="checkbox" checked={actions.includes(a)} onChange={() => toggleAction(a)} disabled={busy !== null} />
                      {DELEGATION_ACTION_LABELS[a].charAt(0).toUpperCase() + DELEGATION_ACTION_LABELS[a].slice(1)}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" loading={busy === 'grant'} disabled={!chosenWs || actions.length === 0 || busy !== null} onClick={() => void grant()}>
                  Grant
                </Button>
                {active.length > 0 && (
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setFormOpen(false)}>Cancel</Button>
                )}
              </div>
            </fieldset>
          )}

          {canManage && active.length > 0 && !formOpen && (
            <div>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setFormOpen(true)}>Add another grant</Button>
            </div>
          )}

          {past.length > 0 && (
            <details className="text-xs text-fg-2">
              <summary className="cursor-pointer select-none">Ended grants ({past.length})</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {past.map(g => (
                  <li key={g.id}>
                    #{g.id} · {g.workspace} · {g.actions.map(a => DELEGATION_ACTION_LABELS[a]).join(', ')} ·{' '}
                    {g.state === 'revoked' ? `revoked ${when(g.revoked_at)}${g.revoked_by ? ` by ${g.revoked_by}` : ''}` : `expired ${when(g.expires_at)}`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {error && <Alert tone="alarm">{error}</Alert>}
      {notice && <p role="status" className="text-xs text-fg-2">{notice}</p>}
    </section>
  )
}
