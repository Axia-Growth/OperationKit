import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, Button, INPUT_CLS, cn } from '../ui'
import type { ChatAgentInfo } from './types'

/* Secret access (obj 901484). ONE screen to let THIS bot use named secrets in
   one workspace: tick the keys (or switch on All secrets), check the host each
   one may be sent to, press Save once. Saving also switches on the bot's "Use
   secrets by name" tool. Before this it was a tick on this page plus, per key,
   a Bot access dialog in Settings → Secrets with the host typed by hand.

   Walls the screen keeps visible: admin only; a value is never shown (the server
   never sends one); a host is exact and the admin's own, a suggested host is
   only text in a box until Save; Read only is the default. */

type Mode = 'read' | 'write' | 'custom'
interface Suggestion { host: string; source: 'confirmed' | 'bot_access' | 'other_bot' | 'url_secret' | 'known_vendor'; from?: string }
interface Status { name: string; usable: boolean; reason: string; detail: string; via: string[]; hosts: string[]; methods: string[] | null }
interface Row {
  name: string
  scope: 'workspace' | 'shared'
  grant: { hosts: string[]; methods: string[]; mode: Mode } | null
  confirmed_hosts: string[]
  covered_by_all: boolean
  workspace_wide: { hosts: string[]; methods: string[] | null } | null
  suggestions: Suggestion[]
  status: Status
}
export interface SecretAccessPanelData {
  slug: string
  workspace: string | null
  workspaces: string[]
  tool_on: boolean
  full_access_here: boolean
  all_secrets: { enabled: boolean; mode: 'read' | 'write' }
  needs_host: string[]
  secrets: Row[]
}
interface TestResult { tool_on: boolean; checked_at: string; results: Status[] }
interface Tick { hosts: string; mode: Mode; methods: string[] }

const READ = ['GET', 'HEAD']
const WRITE = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const MAX_ROWS = 60

const SOURCE_TEXT: Record<Suggestion['source'], string> = {
  confirmed: 'confirmed for this workspace',
  bot_access: 'from Bot access in Settings → Secrets',
  other_bot: 'given to another bot',
  url_secret: 'from the address saved as',
  known_vendor: 'the vendor’s usual API host',
}
function suggestionText(s: Suggestion): string {
  return s.source === 'url_secret' ? `${SOURCE_TEXT.url_secret} ${s.from}` : s.source === 'other_bot' ? `${SOURCE_TEXT.other_bot} (${s.from})` : SOURCE_TEXT[s.source]
}
const splitHosts = (s: string) => s.split(/[\s,]+/).map(h => h.trim()).filter(Boolean)

function valid(r: unknown): SecretAccessPanelData | null {
  const p = (r as { secret_access?: SecretAccessPanelData } | null)?.secret_access
  return p && typeof p === 'object' && Array.isArray(p.secrets) && Array.isArray(p.workspaces)
    ? { ...p, all_secrets: p.all_secrets ?? { enabled: false, mode: 'read' }, needs_host: Array.isArray(p.needs_host) ? p.needs_host : [] }
    : null
}

export function SecretAccessSection({ agent, isAdmin, version = 0, onSaved }: {
  agent: ChatAgentInfo
  isAdmin: boolean
  /** Bump to re-read (the bot's workspace list changed). */
  version?: number
  /** The save switched the bot's secrets tool on: the parent refreshes its copy of the bot. */
  onSaved?: (agent: ChatAgentInfo) => void
}) {
  const base = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/secret-access`
  /** The workspace the admin picked; null = the server's first one for this bot. */
  const [picked, setPicked] = useState<string | null>(null)
  const [panel, setPanel] = useState<SecretAccessPanelData | null>(null)
  const [ticks, setTicks] = useState<Record<string, Tick>>({})
  const [all, setAll] = useState<{ enabled: boolean; mode: 'read' | 'write' }>({ enabled: false, mode: 'read' })
  /** Host boxes for keys with no confirmed host (All secrets). Text only until the admin presses Confirm. */
  const [hostDrafts, setHostDrafts] = useState<Record<string, string>>({})
  const [confirmed, setConfirmed] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<TestResult | null>(null)

  const adopt = useCallback((p: SecretAccessPanelData) => {
    setPanel(p)
    setAll(p.all_secrets)
    setTicks(Object.fromEntries(p.secrets.filter(s => s.grant).map(s => [s.name, { hosts: s.grant!.hosts.join(', '), mode: s.grant!.mode, methods: s.grant!.methods }])))
    const need = new Set(p.needs_host)
    setHostDrafts(Object.fromEntries(p.secrets.filter(s => need.has(s.name)).map(s => [s.name, s.suggestions[0]?.host ?? ''])))
    setConfirmed({})
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    let live = true
    setError(null)
    setTest(null)
    api.get<unknown>(`${base}${picked ? `?workspace=${encodeURIComponent(picked)}` : ''}`)
      .then(r => { const p = valid(r); if (live && p) adopt(p) })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not load secret access.') })
    return () => { live = false }
  }, [base, isAdmin, version, picked, adopt])

  const workspace = panel?.workspace ?? picked

  const rows = panel?.secrets ?? []
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const hit = rows.filter(r => !q || r.name.toLowerCase().includes(q))
    // Ticked first, then anything already usable, then the rest by name.
    const rank = (r: Row) => (ticks[r.name] ? 0 : r.status.usable ? 1 : 2)
    return [...hit].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [rows, filter, ticks])

  const id = (k: string) => `bot-secret-access-${k}-${agent.slug}`
  const title = (
    <h4 id={id('title')} className="font-display text-sm font-semibold text-fg-0">Secret access</h4>
  )

  if (!isAdmin) {
    return (
      <section aria-labelledby={id('title')} className="flex flex-col gap-2 border-t border-line pt-4">
        {title}
        <p className="text-xs text-fg-2">Only an admin can see or change which secrets a bot may use.</p>
      </section>
    )
  }

  const toggle = (r: Row, on: boolean) => {
    setNote(null)
    setTicks(t => {
      const next = { ...t }
      if (!on) delete next[r.name]
      // The suggested host is put in the box for the admin to check. It is saved only with Save.
      else next[r.name] = { hosts: r.grant?.hosts.join(', ') ?? r.suggestions[0]?.host ?? '', mode: 'read', methods: READ }
      return next
    })
  }
  const edit = (name: string, patch: Partial<Tick>) => { setNote(null); setTicks(t => ({ ...t, [name]: { ...t[name]!, ...patch } })) }

  const needHost = (panel?.needs_host ?? []).filter(n => !confirmed[n])
  const draftable = needHost.filter(n => splitHosts(hostDrafts[n] ?? '').length > 0)
  const confirmHosts = () => {
    setNote(null)
    setConfirmed(c => ({ ...c, ...Object.fromEntries(draftable.map(n => [n, hostDrafts[n]!])) }))
  }

  const missingHost = Object.entries(ticks).filter(([, t]) => splitHosts(t.hosts).length === 0).map(([n]) => n)

  const save = async () => {
    if (!workspace) return
    if (missingHost.length) {
      setError(`Type the host for ${missingHost.join(', ')}, or untick it. A key with no host cannot be sent anywhere.`)
      return
    }
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const r = await api.put<{ saved: { added: string[]; changed: string[]; removed: string[]; tool_switched_on: boolean; all_secrets: string | null; hosts_confirmed: string[] }; agent?: ChatAgentInfo }>(base, {
        workspace,
        grants: Object.entries(ticks).map(([name, t]) => ({ name, hosts: splitHosts(t.hosts), methods: t.mode === 'write' ? WRITE : t.mode === 'read' ? READ : t.methods })),
        all_secrets: all,
        hosts: Object.entries(confirmed).map(([name, h]) => ({ name, hosts: splitHosts(h) })),
      })
      const p = valid(r)
      if (p) adopt(p)
      const s = r.saved
      const parts = [
        s.all_secrets === 'off' ? 'All secrets switched off' : s.all_secrets ? `All secrets switched on (${s.all_secrets === 'on_write' ? 'read and write' : 'read only'})` : '',
        s.added.length ? `${s.added.length} added` : '',
        s.changed.length ? `${s.changed.length} changed` : '',
        s.removed.length ? `${s.removed.length} removed` : '',
        s.hosts_confirmed?.length ? `${s.hosts_confirmed.length} host${s.hosts_confirmed.length === 1 ? '' : 's'} confirmed` : '',
        s.tool_switched_on ? 'the “Use secrets by name” tool was switched on' : '',
      ].filter(Boolean)
      setNote(parts.length ? `Saved: ${parts.join(', ')}.` : 'Saved. Nothing changed.')
      setTest(null)
      if (r.agent && s.tool_switched_on) onSaved?.(r.agent)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    if (!workspace) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ test: TestResult }>(`${base}/test`, { workspace })
      setTest(r.test)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not test access.')
    } finally {
      setBusy(false)
    }
  }

  const tickCount = Object.keys(ticks).length
  const blocked = !!panel?.full_access_here

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4" data-testid="secret-access">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {title}
        {panel && panel.workspaces.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-fg-2">
            Workspace
            <select
              className={cn(INPUT_CLS, 'h-8 w-auto py-0 text-xs')}
              value={workspace ?? ''}
              onChange={e => { setPanel(null); setPicked(e.target.value) }}
            >
              {panel.workspaces.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="text-xs text-fg-2">
        Choose which secrets {agent.name} may use{workspace ? ` in ${workspace}` : ''}. The bot never sees a value: it names a secret and the
        server adds the value to the request, only to the host listed here. This is for this bot only; other bots in the workspace get
        nothing from it. Saving also switches on this bot&rsquo;s &ldquo;Use secrets by name&rdquo; tool.
      </p>
      {error && <Alert tone="alarm">{error}</Alert>}
      {!panel && !error && <p className="text-xs text-fg-2">Loading…</p>}
      {panel && !workspace && <p className="text-xs text-fg-2">Give this bot a workspace under Workspace access first.</p>}
      {blocked && (
        <Alert tone="amber">{agent.name} has Full access in {workspace}. A bot with Full access can never use a secret there, so nothing can be given here.</Alert>
      )}

      {panel && workspace && !blocked && (
        <>
          <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-0 px-3 py-2">
            <label className="flex items-start gap-2 text-sm text-fg-0">
              <input
                type="checkbox"
                className="mt-0.5"
                data-testid="all-secrets"
                checked={all.enabled}
                onChange={e => { setNote(null); setAll(a => ({ enabled: e.target.checked, mode: e.target.checked ? a.mode : 'read' })) }}
              />
              <span>
                <span className="font-medium">All secrets in this workspace</span>
                <span className="block text-xs text-fg-2">
                  Every secret saved for {workspace}, including ones added later, with no ticking per key. Shared secrets are not included;
                  tick those one by one below.
                </span>
              </span>
            </label>
            {all.enabled && (
              <>
                <div role="radiogroup" aria-label="What the bot may do with every secret" className="flex flex-wrap gap-4 pl-6 text-xs text-fg-1">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name={id('all-mode')} checked={all.mode === 'read'} onChange={() => setAll({ enabled: true, mode: 'read' })} />
                    Read only (GET, HEAD)
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name={id('all-mode')} data-testid="all-secrets-write" checked={all.mode === 'write'} onChange={() => setAll({ enabled: true, mode: 'write' })} />
                    Read and write (also POST, PUT, PATCH, DELETE)
                  </label>
                </div>
                <Alert tone="amber">
                  {all.mode === 'write'
                    ? `${agent.name} will be able to read and change data at every vendor whose key is saved for ${workspace}.`
                    : `${agent.name} will be able to read data at every vendor whose key is saved for ${workspace}.`}{' '}
                  Each key still goes only to its own host, and a key with no host cannot be used.
                </Alert>
                {(needHost.length > 0 || Object.keys(confirmed).length > 0) && (
                  <div className="flex flex-col gap-2 pl-6" data-testid="needs-host">
                    <p className="text-xs text-fg-1">
                      {needHost.length > 0
                        ? `${needHost.length} key${needHost.length === 1 ? ' has' : 's have'} no host yet. Check each host, then confirm them in one go. This is once per key, for every bot with All secrets.`
                        : 'Hosts confirmed. Press Save to keep them.'}
                    </p>
                    {needHost.slice(0, MAX_ROWS).map(n => {
                      const sug = rows.find(r => r.name === n)?.suggestions[0]
                      return (
                        <label key={n} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="w-56 truncate font-mono text-fg-0" title={n}>{n}</span>
                          <input
                            className={cn(INPUT_CLS, 'h-8 w-56 py-0 font-mono text-xs')}
                            aria-label={`Host for ${n}`}
                            placeholder="api.example.com"
                            value={hostDrafts[n] ?? ''}
                            onChange={e => setHostDrafts(d => ({ ...d, [n]: e.target.value }))}
                          />
                          {sug && hostDrafts[n] === sug.host && <span className="text-fg-2">Suggested: {suggestionText(sug)}</span>}
                        </label>
                      )
                    })}
                    {needHost.length > MAX_ROWS && <p className="text-xs text-fg-2">…and {needHost.length - MAX_ROWS} more after these are saved.</p>}
                    {needHost.length > 0 && (
                      <div>
                        <Button variant="secondary" size="sm" disabled={draftable.length === 0} onClick={confirmHosts} data-testid="confirm-hosts">
                          Confirm {draftable.length} host{draftable.length === 1 ? '' : 's'}
                        </Button>
                        {draftable.length < needHost.length && (
                          <span className="ml-2 text-xs text-fg-2">Keys left blank stay unusable until a host is added.</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-fg-1">
              {all.enabled ? 'Or set one key differently' : 'Tick the secrets this bot may use'} ({tickCount} ticked)
            </p>
            {rows.length > 8 && (
              <input
                className={cn(INPUT_CLS, 'h-8 w-48 py-0 text-xs')}
                aria-label="Find a secret by name"
                placeholder="Find by name"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
            )}
          </div>
          {rows.length === 0 && <p className="text-xs text-fg-2">No secrets are saved for {workspace} yet. Add them in Settings → Secrets.</p>}
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface-0">
            {shown.slice(0, MAX_ROWS).map(r => {
              const t = ticks[r.name]
              const sug = r.suggestions[0]
              return (
                <li key={r.name} className="flex flex-col gap-1.5 px-3 py-2" data-testid={`secret-row-${r.name}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
                      <input type="checkbox" checked={!!t} onChange={e => toggle(r, e.target.checked)} aria-label={`Let ${agent.name} use ${r.name}`} />
                      <span className="truncate font-mono text-fg-0" title={r.name}>{r.name}</span>
                      {r.scope === 'shared' && <span className="rounded-full bg-surface-2 px-1.5 text-xs text-fg-2">Shared</span>}
                    </label>
                    <span
                      className={cn('rounded-full px-2 py-0.5 text-xs', r.status.usable ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2')}
                      title={r.status.detail}
                    >
                      {r.status.usable ? 'Usable now' : 'Not usable'}
                    </span>
                  </div>
                  {t && (
                    <div className="flex flex-wrap items-center gap-2 pl-6 text-xs">
                      <input
                        className={cn(INPUT_CLS, 'h-8 w-56 py-0 font-mono text-xs')}
                        aria-label={`Host for ${r.name}`}
                        placeholder="api.example.com"
                        value={t.hosts}
                        onChange={e => edit(r.name, { hosts: e.target.value })}
                      />
                      <select
                        className={cn(INPUT_CLS, 'h-8 w-auto py-0 text-xs')}
                        aria-label={`What the bot may do with ${r.name}`}
                        value={t.mode}
                        onChange={e => edit(r.name, { mode: e.target.value as Mode })}
                      >
                        <option value="read">Read only (GET, HEAD)</option>
                        <option value="write">Read and write</option>
                        {t.mode === 'custom' && <option value="custom">{t.methods.join(', ')}</option>}
                      </select>
                      {sug && !r.grant && t.hosts === sug.host && <span className="text-fg-2">Suggested: {suggestionText(sug)}. Check it before you save.</span>}
                      {!sug && !t.hosts && <span className="text-fg-2">No suggestion. Type the vendor&rsquo;s API host.</span>}
                    </div>
                  )}
                  {r.workspace_wide && (
                    <p className="pl-6 text-xs text-fg-2">
                      Already open to every bot in {workspace} that has the secrets tool ({r.workspace_wide.hosts.join(', ')}), set in Settings → Secrets.
                    </p>
                  )}
                  {!t && r.covered_by_all && panel.all_secrets.enabled && (
                    <p className="pl-6 text-xs text-fg-2">{r.status.usable ? 'Covered by All secrets.' : r.status.detail}</p>
                  )}
                </li>
              )
            })}
          </ul>
          {shown.length > MAX_ROWS && <p className="text-xs text-fg-2">Showing {MAX_ROWS} of {shown.length}. Type a name to find the rest.</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" loading={busy} onClick={() => void save()}>Save secret access</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void runTest()}>Test access</Button>
            {note && <span role="status" className="text-xs text-fg-2">{note}</span>}
          </div>

          {test && (
            <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-0 px-3 py-2" data-testid="secret-access-test">
              <p className="text-xs font-medium text-fg-1">
                Test of what is saved now. Nothing was sent to any vendor.
                {!test.tool_on ? ' The “Use secrets by name” tool is off for this bot, so nothing is usable.' : ''}
              </p>
              {test.results.length === 0 && <p className="text-xs text-fg-2">This bot has not been given any secret here.</p>}
              {test.results.slice(0, MAX_ROWS).map(s => (
                <p key={s.name} className="text-xs text-fg-1">
                  <span className={s.usable ? 'text-accent-hover' : 'text-fg-2'}>{s.usable ? 'Yes' : 'No'}</span>{' '}
                  <span className="font-mono">{s.name}</span>: {s.detail}
                </p>
              ))}
              {test.results.length > MAX_ROWS && (
                <p className="text-xs text-fg-2">
                  …and {test.results.length - MAX_ROWS} more ({test.results.filter(s => s.usable).length} usable of {test.results.length}).
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
