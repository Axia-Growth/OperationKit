/**
 * Card spend panel (obj 900909, systems audit #10).
 *
 * Shows the card's cost ceiling (set on the card, or the default for its
 * effort), what it has spent so far, and — while it runs — the burn rate and
 * where spend is heading. The spend guard's last action (warning, cheaper
 * tier, park) and the reason a start was refused are shown in plain words.
 *
 * The owner or an admin can raise the ceiling here and choose whether the guard
 * may move the card to a cheaper tier. The server decides who may; a refusal
 * comes back as an error shown under the form.
 */
import { useCallback, useEffect, useState } from 'react'
import type { SpendGuardView } from '@operationkit/shared'
import { api } from '../../lib/api'
import { formatCost, formatDateTime } from '../../lib/format'
import { Alert, Badge, Button, Card, Eyebrow, Field, Input, ProgressBar, Switch } from '../ui'

const POLL_MS = 30_000

function ceilingSourceLabel(view: SpendGuardView): string {
  if (view.ceiling_is_default) {
    const effort = view.ceiling_source.split(':')[1] || 'normal'
    return `Default for ${effort} effort`
  }
  if (view.ceiling_source === 'objective') return 'Set on this card'
  if (view.ceiling_source.startsWith('workspace:')) return 'Workspace limit'
  return 'Board limit'
}

function stageBadge(view: SpendGuardView): { label: string; tone: 'verify' | 'amber' | 'alarm' } {
  if (view.stage === 'parked') return { label: 'Parked', tone: 'alarm' }
  if (view.over_ceiling) return { label: 'Over ceiling', tone: 'alarm' }
  if (view.stage === 'degraded') return { label: 'Cheaper tier', tone: 'amber' }
  if (view.stage === 'warned') return { label: 'Warned', tone: 'amber' }
  if (view.projected_usd !== null && view.projected_usd >= view.ceiling_usd) return { label: 'Running hot', tone: 'amber' }
  return { label: 'Within budget', tone: 'verify' }
}

export function SpendPanel({ objectiveId, status }: { objectiveId: number; status: string }) {
  const [view, setView] = useState<SpendGuardView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setView(await api.get<SpendGuardView>(`/objectives/${objectiveId}/spend`))
      setLoadError(null)
    } catch (err) {
      setLoadError((err as Error).message)
    }
  }, [objectiveId])

  useEffect(() => {
    void load()
    if (status !== 'working') return
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(t)
  }, [load, status])

  const save = async (body: { cost_usd?: number; degrade_allowed?: boolean }) => {
    setSaving(true)
    setSaveError(null)
    try {
      setView(await api.put<SpendGuardView>(`/objectives/${objectiveId}/spend`, body))
      setEditing(false)
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!view) {
    if (!loadError) return null
    return (
      <Alert tone="amber" title="Spend">
        Could not load spend for this card: {loadError}
      </Alert>
    )
  }

  const pct = view.ceiling_usd > 0 ? (view.spent_usd / view.ceiling_usd) * 100 : 0
  const badge = stageBadge(view)
  const running = status === 'working'
  const draftNumber = Number(draft)
  const draftValid = draft.trim() !== '' && Number.isFinite(draftNumber) && draftNumber > 0

  return (
    <Card inset className="px-3 py-2" data-testid="spend-panel">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Eyebrow>Spend</Eyebrow>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {!view.projection_guard_enabled && <Badge tone="neutral">Projection guard off</Badge>}
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-fg-3">Ceiling</dt>
          <dd className="text-sm font-semibold text-fg-1" data-testid="spend-ceiling">{formatCost(view.ceiling_usd)}</dd>
          <dd className="text-fg-3">{ceilingSourceLabel(view)}</dd>
        </div>
        <div>
          <dt className="text-fg-3">Spent so far</dt>
          <dd className="text-sm font-semibold text-fg-1" data-testid="spend-spent">{formatCost(view.spent_usd)}</dd>
          <dd className="text-fg-3">{Math.round(pct)}% of the ceiling</dd>
        </div>
        <div>
          <dt className="text-fg-3">Projected</dt>
          <dd className="text-sm font-semibold text-fg-1" data-testid="spend-projected">
            {view.projected_usd !== null ? formatCost(view.projected_usd) : running ? 'Measuring' : 'Not running'}
          </dd>
          <dd className="text-fg-3">
            {view.projected_usd !== null && view.burn_usd_per_min !== null
              ? `${formatCost(view.burn_usd_per_min)} a minute, next ${view.horizon_minutes} min`
              : running ? 'Needs a couple of minutes of usage' : 'Shown while the card runs'}
          </dd>
        </div>
      </dl>

      <ProgressBar
        className="mt-2"
        pct={pct}
        tone={badge.tone === 'alarm' ? 'alarm' : badge.tone === 'amber' ? 'amber' : 'accent'}
        label="Spend against the ceiling"
      />

      {view.last_refusal && (
        <Alert tone="alarm" className="mt-2" title="Start refused">
          {view.last_refusal}
          {view.last_refusal_at && <span className="ml-1 text-fg-3">({formatDateTime(view.last_refusal_at).label})</span>}
        </Alert>
      )}
      {view.last_action && (
        <p className="mt-2 text-xs leading-relaxed text-fg-2" data-testid="spend-last-action">
          {view.last_action}
          {view.last_action_at && <span className="ml-1 text-fg-3">({formatDateTime(view.last_action_at).label})</span>}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-end gap-3">
        {editing ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={e => {
              e.preventDefault()
              if (draftValid) void save({ cost_usd: draftNumber })
            }}
          >
            <Field label="New ceiling (USD)" error={saveError ?? undefined}>
              <Input
                size="sm"
                type="number"
                min="1"
                step="1"
                inputMode="decimal"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                autoFocus
              />
            </Field>
            <Button size="sm" type="submit" disabled={!draftValid} loading={saving}>Save ceiling</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setSaveError(null) }}>Cancel</Button>
          </form>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { setDraft(String(Math.ceil(Math.max(view.ceiling_usd, view.spent_usd) * 1.5))); setEditing(true) }}
          >
            Change ceiling
          </Button>
        )}
        <Switch
          checked={view.degrade_allowed}
          busy={saving}
          onChange={checked => { void save({ degrade_allowed: checked }) }}
          label="Allow a cheaper tier when spend runs hot"
        />
      </div>
      {!editing && saveError && <p className="mt-1 text-xs text-danger">{saveError}</p>}
    </Card>
  )
}
