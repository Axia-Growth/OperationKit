/**
 * Settings → Models → model registry. Lists models grouped by provider
 * (Anthropic / OpenAI / xAI) with enable/disable, plus the global default (new
 * objectives) and planner (planning step) — all registry-backed
 * (GET /api/models/all, PATCH /api/models/:id, admin only).
 *
 * obj 900679: the default and planner are now plain dropdowns at the top, and
 * "Refresh from providers" (POST /api/models/refresh) pulls each connected
 * provider's live model list so new models appear without a code change. The
 * server also refreshes on a schedule; the last result is shown per provider,
 * including why a provider could not be reached.
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { ModelRow } from '@operationkit/shared'
import { Alert, Badge, Button, DataTable, Field, SectionHeader, SettingsSection, type Column } from './ui'
import { formatDateTime, friendlyError, humanize } from '../lib/format'
import { Switch } from './ui/Switch'
import { ModelPicker } from './ModelPicker'
import { modelOptionGroups } from '../lib/model-options'

export interface ProviderRefreshResult {
  provider: string
  label: string
  engine: string | null
  status: 'ok' | 'error' | 'skipped'
  credential: string | null
  error: string | null
  http_status: number | null
  fetched: number
  added: string[]
  updated: string[]
  missing: string[]
  listed?: string[]
}

export interface ModelRefreshReport {
  trigger: 'manual' | 'scheduled'
  started_at: string
  finished_at: string
  providers: ProviderRefreshResult[]
}

type UiError = { message: string; detail: string } | null

function ErrorAlert({ error, className }: { error: UiError; className?: string }) {
  if (!error) return null
  return (
    <Alert tone="alarm" className={className}>
      {error.message}
      {error.detail && (
        <details className="mt-1 text-xs text-fg-3">
          <summary className="cursor-pointer">Details</summary>
          {error.detail}
        </details>
      )}
    </Alert>
  )
}

function ProviderStatusRow({ r }: { r: ProviderRefreshResult }) {
  const tone = r.status === 'ok' ? 'verify' : r.status === 'skipped' ? 'neutral' : 'alarm'
  const word = r.status === 'ok' ? 'Updated' : r.status === 'skipped' ? 'Not connected' : 'Failed'
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5" data-testid={`refresh-status-${r.provider}`}>
      <span className="min-w-[88px] text-sm text-fg-0">{r.label}</span>
      <Badge tone={tone}>{word}</Badge>
      {r.status === 'ok' && (
        <span className="text-sm text-fg-2">
          {r.fetched} model{r.fetched === 1 ? '' : 's'} listed
          {r.engine ? (r.added.length > 0 ? ` · ${r.added.length} new` : ' · nothing new') : ' · listed only (custom endpoints cannot run sessions yet)'}
          {r.credential && <span className="text-fg-3"> · via {r.credential}</span>}
        </span>
      )}
      {r.status !== 'ok' && r.error && (
        <span className={r.status === 'error' ? 'text-sm text-danger' : 'text-sm text-fg-3'}>
          {r.error}
          {r.status === 'error' && r.credential && <span className="text-fg-3"> (tried {r.credential})</span>}
        </span>
      )}
    </li>
  )
}

export function ModelsModule() {
  const [models, setModels] = useState<ModelRow[]>([])
  const [error, setError] = useState<UiError>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [report, setReport] = useState<ModelRefreshReport | null>(null)
  const [autoHours, setAutoHours] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<UiError>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  async function reload() {
    try {
      const data = await api.get<{ models: ModelRow[] }>('/models/all')
      setModels(data.models)
      setError(null)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setLoaded(true)
    }
    try {
      const r = await api.get<{ report: ModelRefreshReport | null; auto_refresh_hours: number }>('/models/refresh')
      setReport(r.report)
      setAutoHours(r.auto_refresh_hours)
    } catch {
      // Status is optional context; the registry still works without it.
    }
  }

  useEffect(() => { void reload() }, [])

  async function patch(id: string, body: { enabled?: boolean; is_default?: boolean; is_planner?: boolean }) {
    setSavingId(id)
    setError(null)
    try {
      const data = await api.patch<{ models: ModelRow[] }>(`/models/${encodeURIComponent(id)}`, body)
      setModels(data.models)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setSavingId(null)
    }
  }

  async function refresh() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const data = await api.post<{ report: ModelRefreshReport; models: ModelRow[]; auto_refresh_hours: number }>('/models/refresh', {}, { timeoutMs: 120_000 })
      setReport(data.report)
      setModels(data.models)
      setAutoHours(data.auto_refresh_hours)
    } catch (err) {
      setRefreshError(friendlyError(err))
    } finally {
      setRefreshing(false)
    }
  }

  const justAdded = useMemo(() => new Set((report?.providers ?? []).flatMap(p => p.added)), [report])
  const notListed = useMemo(
    () => new Set((report?.providers ?? []).filter(p => p.status === 'ok').flatMap(p => p.missing)),
    [report],
  )

  // Admin-only data; if the fetch 403s for a non-admin, models stays empty — hide the module.
  if (!loaded || models.length === 0) return null

  const groups = modelOptionGroups(models)

  const current = models.find(m => m.is_default)
  const planner = models.find(m => m.is_planner)

  function modelSelect(kind: 'default' | 'planner', value: string | undefined) {
    return (
      <Field
        id={`models-${kind}-select`}
        label={kind === 'default' ? 'Default model' : 'Planner model'}
        hint={kind === 'default' ? 'Used for new cards when no model is picked.' : 'Used for the planning step.'}
      >
        <ModelPicker
          models={models}
          value={value ?? ''}
          disabled={savingId !== null}
          leading={value ? [] : [{ value: '', label: '— none —' }]}
          suffix={m => (m.enabled ? '' : ' — off, will be enabled')}
          onChange={next => {
            if (next && next !== value) void patch(next, kind === 'default' ? { is_default: true } : { is_planner: true })
          }}
        />
      </Field>
    )
  }

  // One shared reason for every locked switch. DataTable renders a desktop table
  // AND mobile cards from the same cells, so a per-row id would be duplicated.
  const lockNoteId = 'models-lock-note'

  const columns: Column<ModelRow>[] = [
    {
      key: 'model',
      header: 'Model',
      cell: m => (
        <div className={savingId === m.id ? 'opacity-50' : undefined} title={m.id}>
          <div className="flex flex-wrap items-center gap-1.5 text-fg-0">
            {m.label}
            {justAdded.has(m.id) && <Badge tone="accent">New</Badge>}
            {notListed.has(m.id) && (
              <span title="The provider's model list no longer includes this id. It may be retired.">
                <Badge tone="amber">Not listed by provider</Badge>
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'enabled',
      header: 'Enabled',
      align: 'center',
      cell: m => {
        const lock = m.is_default || m.is_planner
        const busy = savingId === m.id
        // An on/off setting, so a switch (ui/Switch, 44px target); obj 900819.
        return (
          <Switch
            checked={m.enabled}
            disabled={busy || lock}
            aria-label={`Enable ${m.label}`}
            aria-describedby={lock ? lockNoteId : undefined}
            onChange={() => void patch(m.id, { enabled: !m.enabled })}
            className={busy ? 'min-h-8 px-0 opacity-50' : 'min-h-8 px-0'}
          />
        )
      },
    },
    {
      key: 'default',
      header: 'Default',
      align: 'center',
      cell: m => (
        // The label is the 32px hit area around the 16px radio (WCAG 2.5.8). No
        // `name`: the table and its mobile cards both render this radio, and a
        // shared name would make the two copies uncheck each other.
        <label className="inline-grid h-8 w-8 cursor-pointer place-items-center rounded-md hover:bg-surface-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent">
          <input
            type="radio"
            checked={m.is_default}
            disabled={savingId === m.id || m.is_default}
            aria-label={`Make ${m.label} the default`}
            onChange={() => void patch(m.id, { is_default: true })}
            className="h-4 w-4 cursor-pointer accent-[color:var(--accent)] disabled:cursor-not-allowed"
          />
        </label>
      ),
    },
    {
      key: 'planner',
      header: 'Planner',
      align: 'center',
      cell: m => (
        <label className="inline-grid h-8 w-8 cursor-pointer place-items-center rounded-md hover:bg-surface-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent">
          <input
            type="radio"
            checked={m.is_planner}
            disabled={savingId === m.id || m.is_planner}
            aria-label={`Make ${m.label} the planner`}
            onChange={() => void patch(m.id, { is_planner: true })}
            className="h-4 w-4 cursor-pointer accent-[color:var(--accent)] disabled:cursor-not-allowed"
          />
        </label>
      ),
    },
  ]

  return (
    <SettingsSection
      title="Models"
      description={
        <>
          Pick the global <span className="text-fg-1">default</span> (new cards) and{' '}
          <span className="text-fg-1">planner</span> (planning step), and enable or disable models per provider. Applies
          across all accounts.
        </>
      }
      actions={
        <Button size="sm" variant="secondary" loading={refreshing} onClick={() => void refresh()} data-testid="models-refresh">
          Refresh from providers
        </Button>
      }
      className="rounded-lg border border-line bg-surface-2 p-4"
    >
      <ErrorAlert error={error} className="mb-3" />

      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        {modelSelect('default', current?.id)}
        {modelSelect('planner', planner?.id)}
      </div>

      <div className="mb-5 rounded-lg border border-line px-3 py-2.5" data-testid="models-refresh-panel">
        <SectionHeader
          level={3}
          className="mb-1"
          title="Provider model lists"
          description={
            <span className="text-xs">
              {report ? (
                <span title={formatDateTime(report.finished_at).title}>
                  Last refreshed {formatDateTime(report.finished_at).label} ({humanize(report.trigger).toLowerCase()})
                </span>
              ) : 'Never refreshed'}
              {autoHours !== null && (autoHours > 0 ? ` · refreshes automatically every ${autoHours}h` : ' · automatic refresh off')}
            </span>
          }
        />
        <ErrorAlert error={refreshError} className="mt-2" />
        {report ? (
          <ul className="mt-1 divide-y divide-line-soft">
            {report.providers.map(r => <ProviderStatusRow key={r.provider} r={r} />)}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-fg-3">
            Pulls each connected provider's current models (Anthropic, OpenAI, xAI and any custom endpoint) so new
            models show up here without a code change.
          </p>
        )}
        <p className="mt-1.5 text-xs text-fg-3">
          New models are added switched off — enable one to make it selectable on cards.
        </p>
      </div>

      <span id={lockNoteId} className="sr-only">Reassign default and planner before turning it off</span>
      <div className="space-y-5">
        {groups.map(g => {
          // Provider-discovered models that are off and not new are tucked
          // away so a big OpenAI list doesn't bury the curated rows.
          const hidden = g.rows.filter(m => m.source === 'provider' && !m.enabled && !justAdded.has(m.id))
          const showAll = !!expanded[g.engine]
          const rows = showAll ? g.rows : g.rows.filter(m => !hidden.includes(m))
          return (
            <div key={g.engine}>
              <SectionHeader level={3} title={g.label} className="mb-2" />
              <DataTable aria-label={g.label} columns={columns} rows={rows} rowKey={m => m.id} />
              {hidden.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1.5"
                  aria-expanded={showAll}
                  onClick={() => setExpanded(e => ({ ...e, [g.engine]: !showAll }))}
                >
                  {showAll ? 'Hide older provider models' : `Show ${hidden.length} more model${hidden.length === 1 ? '' : 's'} from the provider`}
                </Button>
              )}
            </div>
          )
        })}
      </div>

      <p className="mt-3 text-xs text-fg-3">
        Setting a model as default or planner auto-enables it. The active default and planner can't be disabled —
        reassign the role first.
      </p>
    </SettingsSection>
  )
}
