import { useEffect, useState } from 'react'
import {
  FULL_ACCESS_EXCLUSION_HELP,
  FULL_ACCESS_EXCLUSION_LABELS,
  FULL_ACCESS_PERMANENT_EXCLUSIONS,
  FULL_ACCESS_PROTECTED_PRS,
  FULL_ACCESS_SWITCHES,
  type BotFullAccess,
  type BotFullAccessPatch,
  type BotFullAccessResponse,
  type BotFullAccessSummary,
  type FullAccessAuditEntry,
  type FullAccessSwitch,
} from '@operationkit/shared'
import { readCache, writeCache } from './chat-cache'
import { api } from '../../lib/api'
import { Alert, Switch, cn } from '../ui'
import { Select } from '../ui/Select'
import { expiryDate, parseServerTime } from './FullAccessBadge'
import type { ChatAgentInfo } from './types'

/* Full access (obj 900972), on the bot's settings panel, under Workspace access.

   One card per workspace the bot is granted. Each has:
     - the Full access switch (admin only), with an optional expiry;
     - four switches for what Full access does NOT include: secret values,
       minting or revoking keys, DNS and Cloudflare Access, billing. Each is its
       own switch, off by default, and only usable while Full access is on;
     - a line that merge and deploy approvals are not here at all.
   Below the cards, the change log: who switched what, when.

   Only an admin signed in to the browser can change anything; the server
   refuses API keys and bots. Everyone else sees it read-only, and only for
   workspaces they belong to. */

type ExpiryChoice = 'none' | 'keep' | '1' | '7' | '30' | '90'

const EXPIRY_PRESETS: { value: Exclude<ExpiryChoice, 'keep'>; label: string }[] = [
  { value: 'none', label: 'No expiry' },
  { value: '1', label: '24 hours' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
]

function expiryFor(choice: ExpiryChoice): string | null {
  if (choice === 'none' || choice === 'keep') return null
  return new Date(Date.now() + Number(choice) * 86_400_000).toISOString()
}

function stamp(value: string): string {
  const d = parseServerTime(value)
  return d ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : value
}

/** One change-log line, in plain words. */
function auditLine(a: FullAccessAuditEntry): string {
  const ws = a.workspace ? ` in ${a.workspace}` : ''
  const x = a.exclusion ? FULL_ACCESS_EXCLUSION_LABELS[a.exclusion] : ''
  switch (a.event) {
    case 'enabled': return `Full access switched on${ws}${a.expires_at ? `, until ${expiryDate(a.expires_at)}` : ', no expiry'}`
    case 'disabled': return `Full access switched off${ws}`
    case 'expiry_changed': return a.expires_at ? `Expiry set to ${expiryDate(a.expires_at)}${ws}` : `Expiry removed${ws}`
    case 'exclusion_changed': return `${a.detail ?? x}${ws}`
    case 'expired': return `Full access expired${ws}`
    case 'workspace_revoked': return `Full access ended${ws}: the workspace was revoked`
    case 'ability_used': return `Used${ws}: ${a.detail ?? a.ability ?? ''}`
    case 'ability_refused': return `Refused${ws}: ${a.ability ?? ''}${a.detail ? ` (${a.detail})` : ''}`
    case 'exclusion_refused': return `Refused${ws}: ${x}${a.detail ? ` (${a.detail})` : ''}`
    case 'protected_refused': return `Refused${ws}: protected pull request${a.detail ? ` (${a.detail})` : ''}`
  }
}

export function summaryOf(workspaces: BotFullAccess[]): BotFullAccessSummary {
  return { workspaces: workspaces.filter(w => w.state === 'on').map(w => ({ workspace: w.workspace, expires_at: w.expires_at })) }
}

export function FullAccessSection({
  agent,
  isAdmin,
  version = 0,
  onChanged,
}: {
  agent: Pick<ChatAgentInfo, 'slug' | 'name'>
  isAdmin: boolean
  /** Bumped when the bot's workspace list changed (a grant or a revoke): re-read. */
  version?: number
  /** Called after a change with where Full access now counts, so the sidebar and header badges update. */
  onChanged?: (summary: BotFullAccessSummary) => void
}) {
  const [data, setData] = useState<BotFullAccessResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** The expiry picked for a workspace whose Full access is still off. */
  const [pending, setPending] = useState<Record<string, ExpiryChoice>>({})

  const url = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/full-access`

  const adopt = (r: BotFullAccessResponse) => {
    if (!r || !Array.isArray(r.workspaces)) throw new Error('This server does not support Full access yet')
    writeCache(url, r)
    setData(r)
  }

  useEffect(() => {
    let live = true
    setLoadError(null)
    const hit = readCache<BotFullAccessResponse>(url)
    if (hit) adopt(hit)
    api.get<BotFullAccessResponse>(url)
      .then(r => {
        if (!live) return
        adopt(r)
        // A workspace revoke can end Full access: keep the badges in step.
        if (version > 0) onChanged?.(summaryOf(r.workspaces))
      })
      .catch(e => { if (live) setLoadError(e instanceof Error ? e.message : 'Could not load Full access') })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, version])

  const canManage = isAdmin && !!data?.can_manage
  const rows = data?.workspaces ?? []
  const onCount = rows.filter(w => w.state === 'on').length
  const label = (slug: string) => {
    const o = data?.workspace_options.find(x => x.slug === slug)
    return o && o.name && o.name !== slug ? `${o.name} (${slug})` : slug
  }
  const id = (k: string, ws = '') => `bot-full-access-${k}-${agent.slug}${ws ? `-${ws}` : ''}`

  const save = async (ws: string, key: string, patch: BotFullAccessPatch, done: string) => {
    setBusy(`${ws}:${key}`)
    setError(null)
    setNotice(null)
    try {
      const r = await api.put<BotFullAccessResponse>(`${url}/${encodeURIComponent(ws)}`, patch)
      adopt(r)
      setNotice(done)
      onChanged?.(summaryOf(r.workspaces))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work')
    } finally {
      setBusy(null)
    }
  }

  const toggle = (w: BotFullAccess, on: boolean) => {
    const choice = pending[w.workspace] ?? 'none'
    const expires = expiryFor(choice)
    return save(
      w.workspace,
      'enabled',
      on ? { enabled: true, expires_at: expires } : { enabled: false },
      on
        ? `Full access is on for ${agent.name} in ${w.workspace}${expires ? `, until ${expiryDate(expires)}` : ''}.`
        : `Full access is off for ${agent.name} in ${w.workspace}.`,
    )
  }

  const changeExpiry = (w: BotFullAccess, choice: ExpiryChoice) => {
    if (choice === 'keep') return
    if (w.state !== 'on') {
      setPending(p => ({ ...p, [w.workspace]: choice }))
      return
    }
    const expires = expiryFor(choice)
    void save(w.workspace, 'expiry', { expires_at: expires }, expires ? `Full access in ${w.workspace} now ends ${expiryDate(expires)}.` : `Full access in ${w.workspace} no longer expires.`)
  }

  const toggleExclusion = (w: BotFullAccess, x: FullAccessSwitch, on: boolean) =>
    save(w.workspace, x, { allow: { [x]: on } }, `${FULL_ACCESS_EXCLUSION_LABELS[x]} is ${on ? 'allowed' : 'blocked'} for ${agent.name} in ${w.workspace}.`)

  const pill = !data ? '…' : onCount > 0 ? `On in ${onCount} workspace${onCount === 1 ? '' : 's'}` : 'Off'

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id('title')} className="font-display text-sm font-semibold text-fg-0">Full access</h4>
        <span className={cn('rounded-full px-2 py-0.5 text-xs', onCount > 0 ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2')}>{pill}</span>
      </div>
      <p id={id('help')} className="text-xs text-fg-2">
        In a workspace where Full access is on, {agent.name} can read and act on every card whoever owns it (take over, comment, restart, hand to a new owner), read and write the whole workspace knowledge base, read and edit workflows and scheduled tasks, read bot settings and run history, start a repo session, and file and own cards. It applies when the bot is working for an admin. Every change and every use is logged.
      </p>

      {loadError && <Alert tone="alarm">{loadError}</Alert>}

      {data && rows.length === 0 && (
        <Alert tone="info">
          Full access is switched on per workspace, and only in a workspace {agent.name} is already granted. Grant a workspace under Workspace access first.
        </Alert>
      )}

      {rows.length > 0 && (
        <ul aria-label={`Full access for ${agent.name}, per workspace`} className="flex flex-col gap-3">
          {rows.map(w => {
            const on = w.state === 'on'
            const expired = w.state === 'expired'
            const choice: ExpiryChoice = on ? (w.expires_at ? 'keep' : 'none') : pending[w.workspace] ?? 'none'
            const rowBusy = busy !== null && busy.startsWith(`${w.workspace}:`)
            return (
              <li key={w.workspace} data-full-access-workspace={w.workspace} className="flex flex-col gap-3 rounded-md border border-line bg-surface-0 p-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg-0">{label(w.workspace)}</span>
                    <span className="block text-xs text-fg-2" data-full-access-state="">
                      {on
                        ? w.expires_at ? `On until ${expiryDate(w.expires_at)}` : 'On, no expiry'
                        : expired ? `Expired ${expiryDate(w.expires_at)}` : 'Off'}
                    </span>
                  </span>
                  <Switch
                    checked={on}
                    disabled={!canManage || busy !== null}
                    busy={busy === `${w.workspace}:enabled`}
                    onChange={v => void toggle(w, v)}
                    aria-describedby={id('help')}
                    label={<span className="font-medium text-fg-0">Full access</span>}
                    aria-label={`Full access in ${w.workspace}`}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={id('expiry', w.workspace)} className="text-xs font-medium text-fg-1">Expires</label>
                  <Select
                    id={id('expiry', w.workspace)}
                    value={choice}
                    onChange={v => changeExpiry(w, v as ExpiryChoice)}
                    disabled={!canManage || rowBusy}
                    className="min-w-[170px]"
                  >
                    {on && w.expires_at && <option value="keep">{expiryDate(w.expires_at)}</option>}
                    {EXPIRY_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </Select>
                  <span className="text-xs text-fg-2">Optional. With no expiry it stays on until you switch it off.</span>
                </div>

                <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-1 p-3" data-full-access-never="">
                  <p className="text-xs font-medium text-fg-1">Never included</p>
                  <p className="text-xs text-fg-2">There is no switch for these. With Full access on, the bot is always refused and the refusal is logged.</p>
                  <ul aria-label={`Never included in ${w.workspace}`} className="mt-1 flex flex-col">
                    {FULL_ACCESS_PERMANENT_EXCLUSIONS.map(x => (
                      <li key={x} data-full-access-never-kind={x} className="flex flex-wrap items-center justify-between gap-x-3 border-t border-line first:border-t-0">
                        <span className="min-w-0 flex-1 py-2 text-xs text-fg-2">
                          <span className="block text-sm text-fg-0">{FULL_ACCESS_EXCLUSION_LABELS[x]}</span>
                          {FULL_ACCESS_EXCLUSION_HELP[x]}
                        </span>
                        <span className="text-xs text-fg-2">Always blocked</span>
                      </li>
                    ))}
                    <li data-full-access-never-kind="protected_prs" className="flex flex-wrap items-center justify-between gap-x-3 border-t border-line">
                      <span className="min-w-0 flex-1 py-2 text-xs text-fg-2">
                        <span className="block text-sm text-fg-0">Protected pull requests</span>
                        Cards that carry a protected pull request (PR {FULL_ACCESS_PROTECTED_PRS.join(', ')}).
                      </span>
                      <span className="text-xs text-fg-2">Always blocked</span>
                    </li>
                  </ul>
                </div>

                <fieldset className="flex flex-col gap-1 rounded-md border border-line bg-surface-1 p-3" disabled={!on}>
                  <legend className="px-1 text-xs font-medium text-fg-1">Not included unless you switch it on</legend>
                  <p className="text-xs text-fg-2">Off until you switch it on here. While off, the bot is refused and the refusal is logged.</p>
                  <ul className="mt-1 flex flex-col">
                    {FULL_ACCESS_SWITCHES.map(x => (
                      <li key={x} className="flex flex-wrap items-center justify-between gap-x-3 border-t border-line first:border-t-0">
                        <span id={id(`x-${x}`, w.workspace)} className="min-w-0 flex-1 py-2 text-xs text-fg-2">
                          <span className="block text-sm text-fg-0">{FULL_ACCESS_EXCLUSION_LABELS[x]}</span>
                          {FULL_ACCESS_EXCLUSION_HELP[x]}
                        </span>
                        <Switch
                          checked={on && w.allow[x]}
                          disabled={!canManage || !on || busy !== null}
                          busy={busy === `${w.workspace}:${x}`}
                          onChange={v => void toggleExclusion(w, x, v)}
                          aria-label={`${FULL_ACCESS_EXCLUSION_LABELS[x]} in ${w.workspace}`}
                          aria-describedby={id(`x-${x}`, w.workspace)}
                          label={<span className="w-14 text-xs text-fg-2">{on && w.allow[x] ? 'Allowed' : 'Blocked'}</span>}
                        />
                      </li>
                    ))}
                  </ul>
                </fieldset>
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-xs text-fg-2">
        Merge and deploy approvals are not part of Full access. They still need you, or a grant under Approve on my behalf.
      </p>

      {error && <Alert tone="alarm">{error}</Alert>}
      {notice && <p role="status" className="text-xs text-fg-2">{notice}</p>}

      {data && data.audit.length > 0 && (
        <details className="rounded-md border border-line bg-surface-0 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-fg-1">Change log ({data.audit.length})</summary>
          <ul aria-label="Full access change log" className="mt-2 flex flex-col divide-y divide-line">
            {data.audit.map(a => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 text-fg-1">{auditLine(a)}</span>
                <span className="shrink-0 text-fg-2">{a.actor ?? 'system'} · {stamp(a.created_at)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {data && !canManage && (
        <p className="text-xs text-fg-2">
          {isAdmin
            ? 'Sign in here in the browser to change Full access. API keys and bots can\'t change it.'
            : 'Only an admin can change Full access.'}
        </p>
      )}
    </section>
  )
}
