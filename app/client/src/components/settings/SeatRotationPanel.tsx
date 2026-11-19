/**
 * Settings → Models → "When an account is limited" (obj 901395).
 *
 * Three numbers: how long a limited account rests when the provider gave no
 * reset time, how long it rests after a reply that came back empty, and how
 * many accounts one reply may try. Saved to the settings table; the server
 * reads them at point of use, so no restart is needed.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { Alert, Button, Field, Input, SettingsSection, Skeleton } from '../../components/ui'

type Key = 'limitCooldownMinutes' | 'emptyTurnCooldownMinutes' | 'maxSeatsPerTurn'

export interface RotationView {
  values: Record<Key, number>
  defaults: Record<Key, number>
  bounds: Record<Key, { min: number; max: number }>
  env_locked: Key[]
}

const FIELDS: { key: Key; label: string; help: string }[] = [
  {
    key: 'limitCooldownMinutes',
    label: 'Rest after a usage limit (minutes)',
    help: 'Used only when the provider gives no reset time. Doubles on each repeat, up to 5 hours.',
  },
  {
    key: 'emptyTurnCooldownMinutes',
    label: 'Rest after an empty reply (minutes)',
    help: 'When an account answers with nothing at all. 0 = move to the next account without resting this one.',
  },
  {
    key: 'maxSeatsPerTurn',
    label: 'Accounts to try per reply',
    help: 'How many accounts one chat reply may move through before it gives up.',
  },
]

export function SeatRotationPanel() {
  const [view, setView] = useState<RotationView | null>(null)
  const [draft, setDraft] = useState<Record<Key, string> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const load = (v: RotationView) => {
    setView(v)
    setDraft({
      limitCooldownMinutes: String(v.values.limitCooldownMinutes),
      emptyTurnCooldownMinutes: String(v.values.emptyTurnCooldownMinutes),
      maxSeatsPerTurn: String(v.values.maxSeatsPerTurn),
    })
  }

  useEffect(() => {
    let live = true
    api.get<RotationView>('/admin/seats/rotation')
      .then(v => { if (live) load(v) })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not load the rotation settings') })
    return () => { live = false }
  }, [])

  const dirty = !!view && !!draft && FIELDS.some(f => draft[f.key].trim() !== String(view.values[f.key]))

  const save = async () => {
    if (!draft || !view) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const body: Partial<Record<Key, number>> = {}
      for (const f of FIELDS) if (draft[f.key].trim() !== String(view.values[f.key])) body[f.key] = Number(draft[f.key])
      load(await api.put<RotationView>('/admin/seats/rotation', body))
      setSaved(true)
    } catch (err) {
      setError(err instanceof ApiError ? ((err.body as { error?: string } | null)?.error || err.message) : err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      id="seats-rotation"
      title="When an account is limited"
      description="A limited account rests until its reset time and the reply moves to the next account on its own. Tools that already ran are not run again."
      className="rounded-lg border border-line bg-surface-2 p-4"
      bodyClassName="space-y-3"
    >
      {!view || !draft ? (
        error ? null : (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        )
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {FIELDS.map(f => {
              const locked = view.env_locked.includes(f.key)
              return (
                <Field
                  key={f.key}
                  id={`seats-rotation-${f.key}`}
                  label={f.label}
                  hint={locked ? 'Set by the server configuration. Change it there.' : `${f.help} Default ${view.defaults[f.key]}.`}
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={view.bounds[f.key].min}
                    max={view.bounds[f.key].max}
                    step={1}
                    value={draft[f.key]}
                    disabled={saving || locked}
                    onChange={e => { setSaved(false); setDraft({ ...draft, [f.key]: e.target.value }) }}
                  />
                </Field>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {saved && !dirty && <span className="text-xs text-fg-3" role="status">Saved</span>}
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>Save</Button>
          </div>
        </>
      )}
      {error && <Alert tone="alarm" title={error} />}
    </SettingsSection>
  )
}
