/**
 * Settings → Knowledge search (admin only). Picks the embedding provider that
 * powers the semantic half of hybrid knowledge search, and shows the index
 * status plus the latest index job (the same card as Jobs → Knowledge index).
 *
 * API keys are referenced by secret NAME only (Settings → Secrets); no value is
 * ever read or shown here.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { SecretSummary } from '@operationkit/shared'
import { api } from '../../lib/api'
import {
  PROVIDER_LABEL, saveKbSearchSettings,
  type KbProvider, type KbSearchStatus,
} from '../../lib/kbSearch'
import { useKbSearchStatus } from '../../hooks/useKbSearchStatus'
import { KbIndexJobCard } from '../jobs/KbIndexJobCard'
import { Check } from 'lucide-react'
import { Alert, Badge, Button, Card, Field, Input, SettingsSection, Skeleton } from '../ui'
import { Select } from '../ui/Select'

const PROVIDERS: KbProvider[] = ['local', 'openai', 'voyage', 'off']

interface FormState {
  provider: KbProvider
  model: string
  base_url: string
  api_key_secret: string
  dimensions: string
}

/** Saved config → form; a value equal to the provider default shows as blank (= default). */
function formFrom(s: KbSearchStatus): FormState {
  const c = s.config
  const d = c.provider === 'off' ? null : s.providers[c.provider]
  const keep = (v: string | undefined, def: string | undefined) => (v && v !== def ? v : '')
  return {
    provider: c.provider,
    model: keep(c.model, d?.model),
    base_url: keep(c.base_url, d?.baseUrl),
    api_key_secret: keep(c.api_key_secret, d?.apiKeySecret),
    dimensions: c.dimensions && c.dimensions !== d?.dimensions ? String(c.dimensions) : '',
  }
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="text-sm text-fg-0">{children}</dd>
    </div>
  )
}

export function SettingsKnowledgeSearch() {
  const { status, setStatus, error: loadError, forbidden, reload } = useKbSearchStatus()
  const [form, setForm] = useState<FormState | null>(null)
  const [secretNames, setSecretNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const initialised = useRef(false)

  // Fill the form once from the first status load; later polls must not clobber edits.
  useEffect(() => {
    if (status && !initialised.current) {
      initialised.current = true
      setForm(formFrom(status))
    }
  }, [status])

  useEffect(() => {
    api.get<SecretSummary[]>('/secrets?scopeType=global')
      .then(list => setSecretNames(Array.from(new Set((Array.isArray(list) ? list : []).map(s => s.key))).sort()))
      .catch(() => setSecretNames([]))
  }, [])

  const defaults = form && form.provider !== 'off' && status ? status.providers[form.provider] : null
  const isApi = form?.provider === 'openai' || form?.provider === 'voyage'
  const secretOptions = useMemo(() => {
    const names = [...secretNames]
    if (form?.api_key_secret && !names.includes(form.api_key_secret)) names.unshift(form.api_key_secret)
    return names
  }, [secretNames, form?.api_key_secret])

  if (forbidden) return <Alert tone="amber">Only an admin can change knowledge search.</Alert>

  const set = (patch: Partial<FormState>) => {
    setSaved(null)
    setSaveError(null)
    setForm(f => (f ? { ...f, ...patch } : f))
  }

  // The configured ✓ / not found state belongs to the SAVED secret; only show it
  // while the form still points at that secret.
  const savedSecret = status?.config.api_key_secret ?? ''
  const effectiveSecret = form?.api_key_secret || defaults?.apiKeySecret || ''
  const keyState = status && form && form.provider === status.config.provider && effectiveSecret === savedSecret
    ? status.config.api_key_configured
    : null

  const onSave = async (e: FormEvent) => {
    e.preventDefault()
    if (!form) return
    setSaving(true)
    setSaveError(null)
    setSaved(null)
    try {
      const dims = form.dimensions.trim()
      const res = await saveKbSearchSettings({
        provider: form.provider,
        model: form.model.trim(),
        base_url: isApi ? form.base_url.trim() : '',
        api_key_secret: isApi ? form.api_key_secret : '',
        dimensions: dims === '' ? '' : Number(dims),
      })
      setStatus(res)
      setForm(formFrom(res))
      const re = res.reembed as { started?: boolean; reason?: string } | null | undefined
      setSaved(re?.started
        ? 'Saved. The model changed, so all of Context is being re-embedded.'
        : re && re.started === false
          ? `Saved. Re-embedding did not start: ${re.reason ?? 'unknown reason'}.`
          : 'Saved.')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Saving failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <SettingsSection
          title="Embedding provider"
          description="Knowledge search combines keyword matching with meaning (semantic) matching. The provider below turns each page into embeddings. Changing the model re-embeds all of Context."
          bodyClassName="space-y-4"
        >
          {loadError && <Alert tone="alarm" title={loadError} />}

          {!form || !status ? (
            !loadError && <Skeleton className="h-40 w-full" />
          ) : (
            <form onSubmit={onSave} className="space-y-4" aria-label="Knowledge search settings">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Provider" id="kbs-provider">
                  <Select
                    className="w-full"
                    value={form.provider}
                    onChange={v => set({ provider: v as KbProvider, model: '', base_url: '', api_key_secret: '', dimensions: '' })}
                  >
                    {PROVIDERS.map(p => (
                      <option key={p} value={p}>{p === 'local' ? `${PROVIDER_LABEL[p]} (default)` : PROVIDER_LABEL[p]}</option>
                    ))}
                  </Select>
                </Field>

                {form.provider !== 'off' && (
                  <Field label="Model" id="kbs-model" hint="Leave blank for the provider default.">
                    <Input
                      value={form.model}
                      placeholder={defaults?.model ?? ''}
                      onChange={e => set({ model: e.target.value })}
                      autoComplete="off"
                    />
                  </Field>
                )}

                {isApi && (
                  <Field label="Base URL" id="kbs-base-url" hint="Leave blank for the provider default.">
                    <Input
                      value={form.base_url}
                      placeholder={defaults?.baseUrl ?? ''}
                      onChange={e => set({ base_url: e.target.value })}
                      inputMode="url"
                      autoComplete="off"
                    />
                  </Field>
                )}

                {isApi && (
                  <Field
                    label="API key secret"
                    id="kbs-secret"
                    hint={<>The key is read from Settings → Secrets by name. Its value is never shown here.</>}
                  >
                    <div className="flex items-center gap-2">
                      <Select
                        className="w-full flex-1"
                        value={form.api_key_secret}
                        onChange={v => set({ api_key_secret: v })}
                      >
                        <option value="">{defaults?.apiKeySecret ? `Default (${defaults.apiKeySecret})` : 'Default'}</option>
                        {secretOptions.map(n => <option key={n} value={n}>{n}</option>)}
                      </Select>
                      {keyState === true && <Badge tone="verify" className="gap-1"><Check aria-hidden="true" className="h-3 w-3" />configured</Badge>}
                      {keyState === false && <Badge tone="alarm">not found</Badge>}
                    </div>
                  </Field>
                )}

                {form.provider !== 'off' && (
                  <Field label="Dimensions" id="kbs-dims" optional hint="Leave blank for the model's default.">
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={form.dimensions}
                      placeholder={defaults?.dimensions ? String(defaults.dimensions) : ''}
                      onChange={e => set({ dimensions: e.target.value })}
                    />
                  </Field>
                )}
              </div>

              {saveError && <Alert tone="alarm" title={saveError} />}
              {saved && <Alert tone="verify" title={saved} />}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" loading={saving}>Save</Button>
                <p className="text-xs text-fg-3">Changing the model re-embeds all of Context.</p>
              </div>
            </form>
          )}
        </SettingsSection>
      </Card>

      {status && (
        <Card>
          <SettingsSection title="Status" id="kbs-status" bodyClassName="space-y-4">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Semantic search">
                {status.availability.available
                  ? <Badge tone="verify">Available</Badge>
                  : <Badge tone="amber">Unavailable</Badge>}
              </Stat>
              <Stat label="Pages / chunks">
                <span className="font-mono">{Number(status.index.docs) || 0} / {Number(status.index.chunks) || 0}</span>
              </Stat>
              <Stat label="On current model">
                <span className="font-mono">{Number(status.index.docsCurrentModel) || 0} / {Number(status.index.docs) || 0}</span>
              </Stat>
              {status.config.local_model_present !== null && (
                <Stat label="Local model present">{status.config.local_model_present ? 'Yes' : 'No'}</Stat>
              )}
            </dl>
            {!status.availability.available && status.availability.reason && (
              <p className="text-sm text-fg-2">{status.availability.reason}</p>
            )}
            <p className="text-xs text-fg-3">
              Model <span className="font-mono">{status.config.model_id}</span>
              {status.index.dim ? <> · {status.index.dim} dimensions</> : null}
            </p>
            <SettingsSection title="Index job" level={3}>
              <KbIndexJobCard job={status.job} queue={status.queue} onChanged={reload} />
            </SettingsSection>
          </SettingsSection>
        </Card>
      )}
    </div>
  )
}
