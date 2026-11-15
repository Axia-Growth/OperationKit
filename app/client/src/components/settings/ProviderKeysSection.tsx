/**
 * Settings → Models → "API key providers" (sprint 4b, obj 900496).
 *
 * BYOK: a provider API key (Anthropic / OpenAI / xAI / an OpenAI-compatible
 * endpoint with a custom base URL) stored through the EXISTING global-scope
 * secrets mechanism — same store, same crypto, same write-only contract as
 * My Secrets (`MySecretsSection.tsx`) and the webhook sender key. This file
 * does not touch secrets-storage internals; it only calls the existing
 * `/api/secrets` routes. `scopeType: 'global'` is already global-admin-only
 * server-side (`canAccessScope` in routes/secrets.ts), matching this page's
 * own admin gate.
 *
 * A stored key is NEVER re-displayed after save — the list below shows only
 * the provider, an optional custom base URL (not secret), and a version/date,
 * exactly like MySecretsSection's masked list.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../../lib/api'
import { Plus } from 'lucide-react'
import { Alert, Button, DataTable, Field, Input, RowActions, SettingsSection, useConfirm, type Column } from '../ui'
import type { SecretSummary } from '@operationkit/shared'
import { Select } from '../ui/Select'

const KEY_PREFIX = 'PROVIDER_API_KEY__'

type FixedProvider = 'ANTHROPIC' | 'OPENAI' | 'XAI'
const FIXED_PROVIDERS: { id: FixedProvider; label: string }[] = [
  { id: 'ANTHROPIC', label: 'Anthropic' },
  { id: 'OPENAI', label: 'OpenAI' },
  { id: 'XAI', label: 'xAI' },
]

type ProviderChoice = FixedProvider | 'CUSTOM'

interface StoredProviderKey {
  secretKey: string
  provider: string
  customSlug: string | null
  baseUrl: string | null
  version: number
  updatedAt: string
}

/** Secret value for a provider key — JSON so a custom endpoint can carry its base URL
 *  alongside the key, with no second secret and no schema change. */
function encodeValue(apiKey: string, baseUrl?: string): string {
  return JSON.stringify(baseUrl ? { apiKey, baseUrl } : { apiKey })
}

function parseStored(s: SecretSummary): StoredProviderKey | null {
  if (!s.key.startsWith(KEY_PREFIX)) return null
  const rest = s.key.slice(KEY_PREFIX.length)
  const isCustom = rest.startsWith('CUSTOM__')
  return {
    secretKey: s.key,
    provider: isCustom ? 'CUSTOM' : rest,
    customSlug: isCustom ? rest.slice('CUSTOM__'.length) : null,
    baseUrl: null, // not readable from metadata — the base URL lives inside the encrypted value
    version: s.version,
    updatedAt: s.updatedAt,
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

function slugify(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

export function ProviderKeysSection() {
  const [rows, setRows] = useState<StoredProviderKey[] | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    try {
      const data = await api.get<SecretSummary[]>('/secrets?scopeType=global')
      const list = Array.isArray(data) ? data : []
      setRows(list.map(parseStored).filter((r): r is StoredProviderKey => r !== null))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load provider keys')
    }
  }

  useEffect(() => { void reload() }, [])

  async function handleRemove(secretKey: string, label: string) {
    const ok = await confirm({
      title: `Remove ${label}?`,
      message: 'Anything configured to use this provider key will need a new one.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    try {
      await api.del(`/secrets?scopeType=global&key=${encodeURIComponent(secretKey)}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed')
    }
  }

  const labelOf = (r: StoredProviderKey) =>
    r.provider === 'CUSTOM'
      ? `Custom: ${r.customSlug}`
      : FIXED_PROVIDERS.find(p => p.id === r.provider)?.label ?? r.provider

  const columns: Column<StoredProviderKey>[] = [
    { key: 'provider', header: 'Provider', cell: r => <span className="font-medium text-fg-0">{labelOf(r)}</span> },
    { key: 'version', header: 'Version', mono: true, cell: r => `v${r.version}` },
    { key: 'updated', header: 'Updated', cell: r => <span className="text-fg-2">{fmtDate(r.updatedAt)}</span> },
  ]

  return (
    <SettingsSection
      title="API key providers"
      description="Bring your own key for Anthropic, OpenAI, xAI, or any OpenAI-compatible endpoint, stored the same way as every other secret here — encrypted, write-only, never shown again."
      actions={!adding && (
        <Button variant="secondary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
          Add API key provider
        </Button>
      )}
      className="rounded-lg border border-line bg-surface-2 p-4"
      bodyClassName="space-y-3"
    >
      {error && <Alert tone="alarm" title={error} />}

      {/* While the add form is open, an empty list is just noise. */}
      {(rows === null || rows.length > 0 || !adding) && (
        <DataTable
          aria-label="Provider API keys"
          columns={columns}
          rows={rows ?? []}
          rowKey={r => r.secretKey}
          loading={rows === null}
          loadingRows={2}
          mobileTitle={r => labelOf(r)}
          empty={{ title: 'No provider keys yet', description: 'Add one to run models on your own API key.' }}
          rowActionsAlways
          rowActions={r => (
            <RowActions
              label={`Actions for ${labelOf(r)}`}
              actions={[{ label: 'Remove', danger: true, onSelect: () => void handleRemove(r.secretKey, labelOf(r)) }]}
            />
          )}
        />
      )}

      {adding && (
        <AddProviderKeyForm
          existing={rows ?? []}
          onCancel={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await reload() }}
        />
      )}
      {confirmDialog}
    </SettingsSection>
  )
}

function AddProviderKeyForm({ existing, onCancel, onSaved }: {
  existing: StoredProviderKey[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [provider, setProvider] = useState<ProviderChoice>('ANTHROPIC')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const slug = useMemo(() => slugify(name), [name])
  const secretKey = provider === 'CUSTOM' ? `${KEY_PREFIX}CUSTOM__${slug}` : `${KEY_PREFIX}${provider}`
  const duplicate = existing.some(r => r.secretKey === secretKey)

  const canSave =
    apiKey.trim().length > 0 &&
    (provider !== 'CUSTOM' || (slug.length > 0 && baseUrl.trim().length > 0)) &&
    !duplicate

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      const value = provider === 'CUSTOM' ? encodeValue(apiKey.trim(), baseUrl.trim()) : encodeValue(apiKey.trim())
      await api.post('/secrets', { scopeType: 'global', key: secretKey, value })
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-md border border-line bg-surface-1 p-4">
      {error && <Alert tone="alarm" title={error} />}
      {duplicate && <Alert tone="amber">A key for this provider already exists — remove it first to replace it.</Alert>}

      <Field label="Provider" id="provider-key-provider">
        <Select value={provider} onChange={v => setProvider(v as ProviderChoice)} className="w-full">
          {FIXED_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="CUSTOM">OpenAI-compatible (custom base URL)</option>
        </Select>
      </Field>

      {provider === 'CUSTOM' && (
        <>
          <Field label="Name" id="provider-key-name">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Together AI" />
          </Field>
          <Field label="Base URL" id="provider-key-base-url">
            <Input
              type="url"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="font-mono"
            />
          </Field>
        </>
      )}

      <Field label="API key" id="provider-key-value" hint="Stored encrypted; never shown again.">
        <Input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          className="font-mono"
        />
      </Field>

      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>Save key</Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  )
}
