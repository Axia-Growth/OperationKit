import { useEffect, useMemo, useRef, useState } from 'react'
import { readCache, writeCache } from './chat-cache'
import { api } from '../../lib/api'
import { Alert, Button, cn } from '../ui'
import { Switch } from '../ui/Switch'
import {
  DEFAULT_INSTALL_TIMEZONE,
  DEFAULT_LEVEL,
  HIGH_AGENCY_LEVELS,
  isHighAgencyLevel,
  levelSummary,
  MAX_LEVEL,
  MIN_LEVEL,
  runsPerDay,
  wakeTimes,
} from '../../../../shared/high-agency'
import type { BotWorkspaceAccessResponse, ChatAgentInfo, HighAgencyInfo, HighAgencyPatch, HighAgencyResponse } from './types'
import { Select } from '../ui/Select'

/* High Agency (obj 900748; levels 1-10 + the close-out operating loop, obj 900794),
   on the bot's settings panel.

   An optional mode per bot, off by default. When it is on, the bot wakes on a
   schedule set by its LEVEL and runs the High Agency operating loop: orient,
   close out the cards it owns, then choose at most one next project and run it
   — or say nothing is worth doing and stop. Each wake is a board card worked
   by this bot, on the bot's own model when the board can run it.

   Level 1 = one wake at night, level 10 = every hour, in between 4…21 wakes a
   day spread across the whole day — all in the install timezone. The schedule
   is a managed routine the server derives from these settings, so every wake
   also shows on Jobs → Executions. Saving here is the only way to change it.
   Non-admins see the same section read-only.

   obj 900914 (Operator's CTO bot went from level 10 to level 1 with no one choosing
   it): this section's form must never drift from what is saved without the
   admin seeing it, and its Save must never write a field the admin did not
   change.
     - The section is no longer REMOUNTED when Workspace access changes (that
       silently threw away unsaved edits and reset the form to the cached
       setting — level 1 / off for a new bot). It re-reads in place and keeps
       every field the admin has edited.
     - Save sends ONLY the fields that differ from the saved setting, so a stale
       or untouched control can never overwrite the saved value.
     - Pending changes are listed next to the button ("Unsaved: level 10 → 1"),
       and the confirmation names exactly what was saved.
     - "No workspace it may wake in" offers the grant right here, then retries. */

/** "EST" / "EDT" for an IANA zone, falling back to the zone name. */
function tzShort(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')
    return part?.value ?? tz
  } catch {
    return tz
  }
}

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/** The editable part of the setting. `workspace` is what the picker shows. */
interface HaForm {
  enabled: boolean
  level: number
  workspace: string
  allow_cards: boolean
  allow_workflows: boolean
}
const FIELDS = ['enabled', 'level', 'workspace', 'allow_cards', 'allow_workflows'] as const

function formFrom(r: HighAgencyResponse): HaForm {
  const h = r.high_agency
  return {
    enabled: h.enabled,
    level: isHighAgencyLevel(h.level) ? h.level : DEFAULT_LEVEL,
    // A bot with no saved workspace shows the picker's first option.
    workspace: h.workspace ?? r.workspace_options?.[0] ?? '',
    allow_cards: h.allow_cards,
    allow_workflows: h.allow_workflows,
  }
}

const wakesADay = (level: number) => {
  const n = isHighAgencyLevel(level) ? runsPerDay(level) : 0
  return `${n} wake${n === 1 ? '' : 's'} a day`
}

/** One plain-language line per changed field, e.g. "level 10 → 1 (24 → 1 wakes a day)". */
export function describeHighAgencyChanges(from: HaForm, to: HaForm): string[] {
  const out: string[] = []
  if (from.enabled !== to.enabled) out.push(to.enabled ? 'turn on' : 'turn off')
  if (from.level !== to.level) out.push(`level ${from.level} → ${to.level} (${wakesADay(to.level)})`)
  if (from.workspace !== to.workspace) out.push(`wake cards go to ${to.workspace || 'the first workspace it may use'}`)
  if (from.allow_cards !== to.allow_cards) out.push(to.allow_cards ? 'may file its next project' : 'may not file projects')
  if (from.allow_workflows !== to.allow_workflows) out.push(to.allow_workflows ? 'may propose workflows' : 'may not propose workflows')
  return out
}

interface GrantOffer {
  message: string
  options: string[]
}

/** The refusal body for a wake workspace the bot is not granted (obj 900914). */
function grantOfferFrom(e: unknown): GrantOffer | null {
  const body = (e as { body?: unknown } | null)?.body as { error?: string; code?: string; grant_options?: unknown } | null | undefined
  if (!body || (body.code !== 'no_wake_workspace' && body.code !== 'workspace_not_granted')) return null
  const options = Array.isArray(body.grant_options) ? body.grant_options.filter((x): x is string => typeof x === 'string') : []
  return { message: body.error || (e instanceof Error ? e.message : 'This bot has no workspace it may wake in.'), options }
}

export function HighAgencySection({
  agent,
  isAdmin,
  accessVersion = 0,
  onAccessChanged,
}: {
  agent: Pick<ChatAgentInfo, 'slug' | 'name'>
  isAdmin: boolean
  /** Bumped by the panel after a Workspace access change: re-read in place, keeping unsaved edits. */
  accessVersion?: number
  /** Called after this section granted a workspace inline, so Workspace access can re-read. */
  onAccessChanged?: () => void
}) {
  const [info, setInfo] = useState<HighAgencyInfo | null>(null)
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [maxProjects, setMaxProjects] = useState(1)
  const [loadError, setLoadError] = useState<string | null>(null)

  // `saved` is the setting as the server has it (the dirty baseline); `form` is
  // what the controls show. Only fields that differ are ever sent.
  const [saved, setSaved] = useState<HaForm | null>(null)
  const savedRef = useRef<HaForm | null>(null)
  const [form, setForm] = useState<HaForm>({ enabled: false, level: DEFAULT_LEVEL, workspace: '', allow_cards: true, allow_workflows: true })
  const { enabled, level, workspace, allow_cards: allowCards, allow_workflows: allowWorkflows } = form

  const [busy, setBusy] = useState<'save' | 'wake' | 'grant' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [grantOffer, setGrantOffer] = useState<GrantOffer | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const url = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/high-agency`

  /**
   * Take the server's setting. With `keepEdits`, a field the admin has changed
   * (form ≠ the previous saved value) keeps the admin's value; every other
   * field follows the server.
   */
  const adopt = (r: HighAgencyResponse, opts: { keepEdits?: boolean } = {}) => {
    const h = r?.high_agency
    if (!h) throw new Error('This server does not support High Agency yet')
    writeCache(url, r)
    const next = formFrom(r)
    const prev = savedRef.current
    savedRef.current = next
    setInfo(h)
    setSaved(next)
    setForm(f => {
      if (!opts.keepEdits || !prev) return next
      const merged = { ...next } as Record<string, unknown>
      for (const k of FIELDS) if (f[k] !== prev[k]) merged[k] = f[k]
      return merged as unknown as HaForm
    })
    if (r.workspace_options) setWorkspaces(r.workspace_options)
    if (typeof r.max_new_projects_per_wake === 'number') setMaxProjects(r.max_new_projects_per_wake)
  }

  const edit = <K extends keyof HaForm>(k: K, v: HaForm[K]) => {
    setForm(f => ({ ...f, [k]: v }))
    setNotice(null)
  }

  useEffect(() => {
    let live = true
    setLoadError(null)
    // obj 900865: a bot whose settings were opened before paints them at once.
    const hit = readCache<HighAgencyResponse>(url)
    if (hit) adopt(hit)
    api.get<HighAgencyResponse>(url)
      .then(r => { if (live) adopt(r, { keepEdits: true }) })
      .catch(e => { if (live) setLoadError(e instanceof Error ? e.message : 'Could not load High Agency') })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // A grant/revoke elsewhere on the panel can change where High Agency may wake
  // (or switch it off): re-read in place, keeping whatever the admin is editing.
  const firstAccess = useRef(true)
  useEffect(() => {
    if (firstAccess.current) { firstAccess.current = false; return }
    let live = true
    api.get<HighAgencyResponse>(url)
      .then(r => { if (live) adopt(r, { keepEdits: true }) })
      .catch(() => { /* the panel keeps showing the last good read */ })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessVersion])

  // The preview follows the form, not the saved row, so the admin sees the
  // exact wake times before pressing Save.
  const preview = useMemo(
    () => (isHighAgencyLevel(level) ? wakeTimes(agent.slug, level) : []),
    [agent.slug, level],
  )
  const timezone = info?.timezone || DEFAULT_INSTALL_TIMEZONE
  const tz = tzShort(timezone)
  const summary = isHighAgencyLevel(level) ? levelSummary(level) : ''

  const changes = saved ? describeHighAgencyChanges(saved, form) : []
  const dirty = changes.length > 0

  /** Only what changed; `extra` forces fields (an inline grant's workspace). */
  const patchFor = (extra: HighAgencyPatch = {}): HighAgencyPatch => {
    const body: HighAgencyPatch = {}
    if (saved) {
      if (form.enabled !== saved.enabled) body.enabled = form.enabled
      if (form.level !== saved.level) body.level = form.level
      if (form.workspace !== saved.workspace) body.workspace = form.workspace || null
      if (form.allow_cards !== saved.allow_cards) body.allow_cards = form.allow_cards
      if (form.allow_workflows !== saved.allow_workflows) body.allow_workflows = form.allow_workflows
    }
    // Saving a paused schedule with nothing else changed is the "resume" click.
    if (!Object.keys(body).length && info?.enabled) body.enabled = true
    return { ...body, ...extra }
  }

  const save = async (extra: HighAgencyPatch = {}) => {
    setBusy('save')
    setError(null)
    setGrantOffer(null)
    setNotice(null)
    const before = saved
    const body = patchFor(extra)
    try {
      const r = await api.put<HighAgencyResponse>(url, body)
      adopt(r)
      const after = formFrom(r)
      const what = before ? describeHighAgencyChanges(before, after) : []
      const state = after.enabled ? `On at level ${after.level} (${wakesADay(after.level)})` : 'Off'
      setNotice(`Saved High Agency${what.length ? `: ${what.join(', ')}` : ''}. ${state}. Nothing else on this page changed.`)
    } catch (e) {
      const offer = grantOfferFrom(e)
      if (offer) setGrantOffer(offer)
      else setError(e instanceof Error ? e.message : 'Could not save High Agency')
    } finally {
      setBusy(null)
    }
  }

  /** Grant the bot `ws` (the same call Workspace access makes), then retry the save there. */
  const grantAndSave = async (ws: string) => {
    setBusy('grant')
    setError(null)
    try {
      await api.post<BotWorkspaceAccessResponse>(`/agent-chat/agents/${encodeURIComponent(agent.slug)}/workspaces`, { workspace: ws })
    } catch (e) {
      setBusy(null)
      setError(e instanceof Error ? e.message : `Could not grant ${ws}`)
      return
    }
    onAccessChanged?.()
    setForm(f => ({ ...f, workspace: ws }))
    setWorkspaces(w => (w.includes(ws) ? w : [...w, ws]))
    await save({ workspace: ws })
  }

  const wake = async () => {
    setBusy('wake')
    setError(null)
    setNotice(null)
    try {
      const r = await api.post<HighAgencyResponse>(`${url}/wake`, {})
      adopt(r)
      setNotice(r.result?.objective_id ? `Woke ${agent.name}: card #${r.result.objective_id}.` : 'Wake started.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wake did not start')
    } finally {
      setBusy(null)
    }
  }

  const id = (k: string) => `high-agency-${k}-${agent.slug}`
  const paused = info?.enabled && info.routine && !info.routine.enabled
  const disabled = !isAdmin || busy !== null || !info

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id('title')} className="font-display text-sm font-semibold text-fg-0">High Agency</h4>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs',
            info?.enabled ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2',
          )}
        >
          {!info ? '…' : info.enabled ? (paused ? 'On · paused' : `On · level ${info.level}`) : 'Off'}{isAdmin && dirty ? ' · unsaved changes' : ''}
        </span>
      </div>
      <p className="text-xs text-fg-2">
        On each wake this bot runs its area like an owner: it orients on its objectives and data, closes out the cards it owns first, then picks at most one next project and runs it to done — or says nothing is worth doing and stops. No busywork. Each wake is a board card this bot works, on its own model. Off by default.
      </p>

      {loadError && <Alert tone="alarm">{loadError}</Alert>}

      <fieldset className="flex flex-col gap-3" disabled={disabled}>
        <legend className="sr-only">High Agency settings</legend>
        <div className="flex items-start gap-2 rounded-md border border-line bg-surface-0 px-3 py-1">
          <Switch
            checked={enabled}
            onChange={v => edit('enabled', v)}
            aria-describedby={id('help')}
            label={<span className="font-medium text-fg-0">High Agency on</span>}
          />
        </div>
        <p id={id('help')} className="-mt-2 px-3 text-xs text-fg-2">
          {enabled && preview.length
            ? `Level ${level}: wakes ${summary.charAt(0).toLowerCase()}${summary.slice(1)}.`
            : 'This bot never wakes on its own.'}
        </p>

        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <label htmlFor={id('level')} className="block text-xs font-medium text-fg-1">High Agency level</label>
            <span className="text-xs font-medium text-fg-0" aria-live="polite">Level {level} · {summary}</span>
          </div>
          <input
            id={id('level')}
            type="range"
            min={MIN_LEVEL}
            max={MAX_LEVEL}
            step={1}
            value={level}
            onChange={e => edit('level', Number(e.target.value))}
            aria-valuetext={`Level ${level}: ${summary}`}
            className="w-full accent-[var(--accent)]"
          />
          <div className="flex justify-between text-xs text-fg-2" aria-hidden="true">
            <span>1 · once, at night</span>
            <span>10 · every hour</span>
          </div>
        </div>
        <p className="-mt-1 text-xs text-fg-2" data-testid="high-agency-preview">
          Wakes at {preview.join(', ')} {tz} ({timezone}).
        </p>
        <details className="-mt-1 text-xs text-fg-2">
          <summary className="cursor-pointer">How levels map to wakes a day</summary>
          <table className="mt-1 w-full text-left">
            <thead>
              <tr><th className="pr-2 font-medium">Level</th>{HIGH_AGENCY_LEVELS.map(l => <th key={l} className="px-1 font-medium">{l}</th>)}</tr>
            </thead>
            <tbody>
              <tr><td className="pr-2">Wakes / day</td>{HIGH_AGENCY_LEVELS.map(l => <td key={l} className="px-1">{runsPerDay(l)}</td>)}</tr>
            </tbody>
          </table>
          <p className="mt-1">Level 1 wakes once at night; level 10 every hour. Wakes are spread across the whole day on the hour (minute fixed per bot), in the install timezone.</p>
        </details>
        {info?.wake_model !== undefined && (
          <p className="-mt-1 text-xs text-fg-2">
            {info.wake_model ? <>Wakes run on this bot&apos;s model, <code>{info.wake_model}</code>.</> : 'Wakes run on the board’s default model (this bot has no model set that the board can run).'}
          </p>
        )}

        <div>
          <label htmlFor={id('workspace')} className="mb-1 block text-xs font-medium text-fg-1">Wake cards go to</label>
          <Select className="w-full" id={id('workspace')} value={workspace} onChange={v => edit('workspace', v)}>
            {!workspace && <option value="">First workspace this bot may use</option>}
            {[...new Set([...(workspace ? [workspace] : []), ...workspaces])].map(w => <option key={w} value={w}>{w}</option>)}
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-fg-1">On each wake, this bot may</p>
          <label className="flex items-start gap-2 px-1 py-1">
            <input type="checkbox" checked={allowCards} onChange={e => edit('allow_cards', e.target.checked)} className="mt-0.5" />
            <span>
              <span className="block text-sm text-fg-0">File and run its next project</span>
              <span className="block text-xs text-fg-2">At most {maxProjects} new project card per wake, owned and started by this bot, after it has closed out its own cards.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 px-1 py-1">
            <input type="checkbox" checked={allowWorkflows} onChange={e => edit('allow_workflows', e.target.checked)} className="mt-0.5" />
            <span>
              <span className="block text-sm text-fg-0">Propose repeatable workflows</span>
              <span className="block text-xs text-fg-2">When its next project is recurring work. A proposal is a draft: nothing runs until you publish it.</span>
            </span>
          </label>
          <p className="px-1 text-xs text-fg-2">It never sends email, merges, deploys, spends money or publishes a workflow — those go to your decision queue.</p>
        </div>
      </fieldset>

      {info && (info.next_wake_at || info.last_wake) && (
        <p className="text-xs text-fg-2">
          {info.next_wake_at && <>Next wake {when(info.next_wake_at)}. </>}
          {info.last_wake && (
            <>Last wake: <a className="text-accent-hover underline" href={`/o/${info.last_wake.objective_id}`}>card #{info.last_wake.objective_id}</a> ({info.last_wake.status}).</>
          )}
        </p>
      )}
      {paused && (
        <Alert tone="amber">
          The wake schedule is paused on the Jobs page{info?.routine?.auto_pause_reason ? ` (${info.routine.auto_pause_reason})` : ''}. Save here to resume it.
        </Alert>
      )}
      {error && <Alert tone="alarm">{error}</Alert>}
      {grantOffer && (
        <Alert tone="amber">
          <div className="flex flex-col gap-2" data-testid="high-agency-grant-offer">
            <p>{grantOffer.message}</p>
            {isAdmin && grantOffer.options.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {grantOffer.options.map(ws => (
                  <Button key={ws} variant="secondary" size="sm" loading={busy === 'grant'} disabled={busy !== null} onClick={() => void grantAndSave(ws)}>
                    Grant access to {ws} and save
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-xs">Workspace access is the section above this one on this page.</p>
            )}
          </div>
        </Alert>
      )}

      {isAdmin && dirty && (
        <p className="text-xs text-warning" data-testid="high-agency-unsaved">
          Unsaved High Agency changes: {changes.join(', ')}.
        </p>
      )}
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" loading={busy === 'save'} disabled={!info || busy !== null || (!dirty && !paused)} onClick={() => void save()}>
            Save High Agency
          </Button>
          <Button variant="ghost" size="sm" loading={busy === 'wake'} disabled={!info || busy !== null} onClick={() => void wake()}>
            Wake now
          </Button>
          {notice && <span role="status" className="text-xs text-fg-2">{notice}</span>}
          {!notice && info?.updated_by && <span className="text-xs text-fg-2">Changed by {info.updated_by}</span>}
        </div>
      )}
      {!isAdmin && <p className="text-xs text-fg-2">Only an admin can change High Agency.</p>}
    </section>
  )
}
