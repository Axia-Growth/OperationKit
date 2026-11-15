/**
 * Agent webhooks — Settings → You (obj 719278).
 * Per agent key: where to POST when a card that key created or started moves,
 * the sender key the bot expects (stored in Secrets, never shown again), which
 * events to send, a test button and the recent delivery log.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { useConfirm } from '../ui'
// Direct module paths (not the '../ui' barrel) so suites that mock the barrel
// with only useConfirm still render this card.
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Skeleton } from '../../components/ui/Skeleton'
import { cn } from '../../components/ui/cn'
import { formatDateTime, humanize } from '../../lib/format'
import { Alert } from '../ui/Alert'
import { Checkbox, Field, Input } from '../ui/Field'
import { EmptyState } from '../ui/EmptyState'
import { SectionHeader } from '../ui/SettingsSection'
import {
  AGENT_WEBHOOK_EVENTS,
  AGENT_WEBHOOK_EVENT_DESCRIPTIONS,
  DEFAULT_AGENT_WEBHOOK_EVENTS,
  type AgentApiKeySummary,
  type AgentWebhookConfig,
  type AgentWebhookDelivery,
  type AgentWebhookEvent,
} from '@operationkit/shared'

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string })?.error || err.message
  return err instanceof Error ? err.message : fallback
}

type TestResult = { delivered: boolean; status_code: number | null; error: string | null }

const DELIVERY_TONE: Record<AgentWebhookDelivery['status'], 'verify' | 'amber' | 'alarm'> = {
  delivered: 'verify',
  pending: 'amber',
  failed: 'alarm',
}

export function AgentWebhooksSection() {
  const [keys, setKeys] = useState<AgentApiKeySummary[] | null>(null)
  const [hooks, setHooks] = useState<Record<number, AgentWebhookConfig | null>>({})
  const [openId, setOpenId] = useState<number | null>(null)
  const [error, setError] = useState('')

  async function loadHook(id: number) {
    try {
      const res = await api.get<{ webhook: AgentWebhookConfig | null }>(`/auth/agent-keys/${id}/webhook`)
      setHooks(prev => ({ ...prev, [id]: res?.webhook ?? null }))
    } catch {
      setHooks(prev => ({ ...prev, [id]: null }))
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ keys: AgentApiKeySummary[] }>('/auth/agent-keys')
        const active = (res?.keys ?? []).filter(k => !k.revoked_at)
        setKeys(active)
        await Promise.all(active.map(k => loadHook(k.id)))
      } catch (err) {
        setError(errorText(err, 'Failed to load agent keys'))
        setKeys([])
      }
    })()
  }, [])

  return (
    <section className="mt-6 rounded-lg border border-line bg-surface-1 p-5" aria-labelledby="agent-webhooks-heading">
      <SectionHeader
        headingId="agent-webhooks-heading"
        className="mb-4"
        title="Agent webhooks"
        description="Wake a bot when a card it created or started changes status, instead of it polling. Each POST carries the card id, title, status, PR and link — never a secret or transcript — and is signed with the sender key."
      />

      {error && <Alert tone="alarm" title={error} className="mb-3" />}

      {keys === null ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : keys.length === 0 ? (
        <EmptyState
          compact
          title="No active agent keys"
          description="Create an agent key above, then give it a webhook here."
          className="rounded-md border border-dashed border-line"
        />
      ) : (
        <ul className="divide-y divide-line-soft rounded-md border border-line">
          {keys.map(k => {
            const hook = hooks[k.id]
            const open = openId === k.id
            return (
              <li key={k.id} className="p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold text-fg-0">{k.label}</span>
                      {hook === undefined ? (
                        <Skeleton className="h-4 w-14" />
                      ) : hook === null ? (
                        <Badge>no webhook</Badge>
                      ) : hook.enabled ? (
                        <Badge tone="verify">on</Badge>
                      ) : (
                        <Badge tone="amber">paused</Badge>
                      )}
                    </div>
                    {hook && <p className="truncate font-mono text-xs text-fg-2">{hook.url}</p>}
                  </div>
                  <Button
                    className="min-h-[44px] shrink-0 self-start sm:min-h-0 sm:self-center"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : k.id)}
                  >
                    {open ? 'Close' : hook ? 'Edit webhook' : 'Add webhook'}
                  </Button>
                </div>
                {open && (
                  <WebhookEditor
                    keyId={k.id}
                    label={k.label}
                    hook={hook ?? null}
                    onSaved={w => setHooks(prev => ({ ...prev, [k.id]: w }))}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function WebhookEditor({
  keyId,
  label,
  hook,
  onSaved,
}: {
  keyId: number
  label: string
  hook: AgentWebhookConfig | null
  onSaved: (w: AgentWebhookConfig | null) => void
}) {
  const [url, setUrl] = useState(hook?.url ?? '')
  const [secret, setSecret] = useState('')
  const [headerName, setHeaderName] = useState(hook?.header_name ?? 'Authorization')
  const [headerPrefix, setHeaderPrefix] = useState(hook?.header_prefix ?? 'Bearer ')
  // obj 900270: needs_agent is offered on every key (the label pilot is gone) — the
  // one shared connection opts in here. A saved webhook keeps exactly its events.
  const offeredEvents = AGENT_WEBHOOK_EVENTS
  const [events, setEvents] = useState<AgentWebhookEvent[]>(hook?.events ?? [...DEFAULT_AGENT_WEBHOOK_EVENTS])
  const [enabled, setEnabled] = useState(hook?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revealedSecret, setRevealedSecret] = useState('')
  const [test, setTest] = useState<TestResult | null>(null)
  const [deliveries, setDeliveries] = useState<AgentWebhookDelivery[] | null>(hook ? null : [])
  const { confirm, confirmDialog } = useConfirm()

  async function loadDeliveries() {
    try {
      const res = await api.get<{ deliveries: AgentWebhookDelivery[] }>(`/auth/agent-keys/${keyId}/webhook/deliveries?limit=20`)
      setDeliveries(res?.deliveries ?? [])
    } catch {
      setDeliveries([])
    }
  }

  useEffect(() => {
    if (hook) void loadDeliveries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId])

  function toggleEvent(e: AgentWebhookEvent) {
    setEvents(prev => (prev.includes(e) ? prev.filter(x => x !== e) : AGENT_WEBHOOK_EVENTS.filter(x => x === e || prev.includes(x))))
  }

  const needsSecret = !hook?.has_secret
  const formFieldsValid = url.trim().length > 0 && events.length > 0 && headerName.trim().length > 0
  const canSave = formFieldsValid && (!needsSecret || secret.length >= 8)
  const canGenerate = formFieldsValid

  async function save(opts?: { generate?: boolean }) {
    const generate = opts?.generate ?? false
    if (!generate && !canSave) return
    setSaving(true)
    setError('')
    setNotice('')
    setRevealedSecret('')
    try {
      const res = await api.put<{ webhook: AgentWebhookConfig }>(`/auth/agent-keys/${keyId}/webhook`, {
        url: url.trim(),
        header_name: headerName.trim(),
        header_prefix: headerPrefix,
        events,
        enabled,
        ...(generate ? { generate_secret: true } : secret ? { secret } : {}),
      })
      setSecret('')
      onSaved(res?.webhook ?? null)
      if (res?.webhook?.generated_secret) {
        setRevealedSecret(res.webhook.generated_secret)
        setNotice('Saved. Copy the sender key below now — it will not be shown again.')
      } else {
        setNotice('Saved. The sender key is stored in Secrets and will not be shown again.')
      }
      void loadDeliveries()
    } catch (err) {
      setError(errorText(err, 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  async function generateAndSave() {
    if (!canGenerate) return
    const ok = hook?.has_secret
      ? await confirm({
          title: 'Replace the sender key?',
          message: 'A new key is generated and stored; the old one stops working for this webhook.',
          confirmLabel: 'Generate new key',
          danger: true,
        })
      : true
    if (!ok) return
    await save({ generate: true })
  }

  async function copyRevealedSecret() {
    try {
      await navigator.clipboard.writeText(revealedSecret)
      setNotice('Copied. This is the only time it will be shown.')
    } catch {
      // Clipboard API unavailable — the key is still selectable/visible in the field below.
    }
  }

  async function sendTest() {
    setTesting(true)
    setError('')
    setTest(null)
    try {
      const res = await api.post<TestResult>(`/auth/agent-keys/${keyId}/webhook/test`)
      setTest(res ?? null)
      void loadDeliveries()
    } catch (err) {
      setError(errorText(err, 'Test failed'))
    } finally {
      setTesting(false)
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Remove the webhook for “${label}”?`,
      message: 'Its sender key is deleted from Secrets and queued deliveries are dropped. The agent key keeps working.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    setRemoving(true)
    setError('')
    try {
      await api.del(`/auth/agent-keys/${keyId}/webhook`)
      onSaved(null)
    } catch (err) {
      setError(errorText(err, 'Remove failed'))
      setRemoving(false)
    }
  }

  const id = (s: string) => `wh-${keyId}-${s}`

  return (
    <form
      className="mt-3 space-y-4 rounded-md border border-line bg-surface-1 p-4"
      onSubmit={e => { e.preventDefault(); void save() }}
    >
      {error && <Alert tone="alarm" title={error} />}
      {notice && <Alert tone="verify" title={notice} />}

      <Field id={id('url')} label="Webhook URL">
        <Input
          type="url"
          inputMode="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://bot.example.com/cc-events"
          className="font-mono"
        />
      </Field>

      <div>
        <Field
          id={id('secret')}
          label="Sender key"
          hint={
            <>
              Sent as the auth header below and used to sign each body (<span className="font-mono">X-CC-Signature: sha256=…</span>).
              {hook?.has_secret && <> Stored in Secrets as <span className="font-mono">{hook.secret_name}</span>.</>}
              {' '}Generate has the server pick a random key instead of you typing one — shown once, right after you save.
            </>
          }
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <Input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={e => setSecret(e.target.value)}
              placeholder={hook?.has_secret ? 'Stored — leave blank to keep it' : 'Paste your bot’s key, or generate one below'}
              className="flex-1 font-mono"
            />
            <Button
              type="button"
              className="shrink-0"
              loading={saving}
              disabled={!canGenerate}
              onClick={() => void generateAndSave()}
            >
              {hook?.has_secret ? 'Generate new key' : 'Generate key'}
            </Button>
          </div>
        </Field>
        {revealedSecret && (
          <div role="status" className="mt-2 rounded-md border border-line-strong bg-surface-2 p-3">
            <p className="text-xs font-medium text-fg-1">Your new sender key (shown once — copy it now)</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs text-fg-0">{revealedSecret}</code>
              <Button type="button" className="shrink-0" onClick={() => void copyRevealedSecret()}>Copy</Button>
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={id('hname')} label="Header name">
          <Input value={headerName} maxLength={64} onChange={e => setHeaderName(e.target.value)} className="font-mono" />
        </Field>
        <Field id={id('hprefix')} label="Value prefix">
          <Input value={headerPrefix} maxLength={32} onChange={e => setHeaderPrefix(e.target.value)} placeholder="(none)" className="font-mono" />
        </Field>
      </div>
      <p className="-mt-2 text-xs text-fg-2">
        Sends <span className="font-mono text-fg-1">{headerName || '…'}: {headerPrefix}&lt;sender key&gt;</span>
      </p>

      <fieldset>
        <legend className="text-sm font-medium text-fg-1">Send these events</legend>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {offeredEvents.map(e => {
            const on = events.includes(e)
            return (
              <Checkbox
                key={e}
                checked={on}
                onChange={() => toggleEvent(e)}
                className={cn(
                  'flex min-h-[44px] rounded-md border px-2.5 py-2 transition-colors duration-base sm:min-h-[44px]',
                  on ? 'border-line-strong bg-surface-2' : 'border-transparent hover:bg-surface-3',
                )}
                label={<span className="block font-mono text-xs text-fg-0">{e}</span>}
                description={AGENT_WEBHOOK_EVENT_DESCRIPTIONS[e]}
              />
            )
          })}
        </div>
      </fieldset>

      <Checkbox checked={enabled} onChange={e => setEnabled(e.target.checked)} label="Enabled" />

      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>
          Save webhook
        </Button>
        {hook && (
          <Button type="button" loading={testing} onClick={() => void sendTest()}>
            Send test event
          </Button>
        )}
        {hook && (
          // Destructive: kept apart from Save (pushed to the far end) and confirms first.
          <Button type="button" variant="danger" className="sm:ml-auto" loading={removing} onClick={() => void remove()}>
            Remove
          </Button>
        )}
      </div>

      {test && (
        <div role="status" className={cn('text-base', test.delivered ? 'text-success' : 'text-danger')}>
          {test.delivered ? 'Delivered — the receiver accepted the test event.' : 'Not delivered — the receiver did not accept the test event.'}
          {(test.status_code != null || test.error) && (
            <details className="mt-1 text-xs text-fg-3">
              <summary>Details</summary>
              {[test.status_code != null ? `Status ${test.status_code}` : '', test.error ?? ''].filter(Boolean).join(' · ')}
            </details>
          )}
        </div>
      )}

      {hook && (
        <div>
          <SectionHeader level={3} title="Recent deliveries" className="mb-2" />
          {deliveries === null ? (
            <div className="space-y-1.5" aria-busy="true">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : deliveries.length === 0 ? (
            <p className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-fg-2">
              Nothing sent yet. Use “Send test event” to check the receiver.
            </p>
          ) : (
            <ul className="divide-y divide-line-soft rounded-md border border-line" aria-label="Recent deliveries">
              {deliveries.map(d => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                  <Badge tone={DELIVERY_TONE[d.status]}>{humanize(d.status)}</Badge>
                  <span className="font-mono text-fg-0">{d.event}</span>
                  <span className="text-fg-2">{d.objective_id ? `#${d.objective_id}` : 'test'}</span>
                  <span className="text-fg-2">
                    {d.attempts} {d.attempts === 1 ? 'try' : 'tries'}
                    {d.last_status_code != null && <span title={`Status ${d.last_status_code}`}> · {d.last_status_code < 300 ? 'accepted' : 'refused by the receiver'}</span>}
                  </span>
                  {d.last_error && d.status !== 'delivered' && <span className="min-w-0 truncate text-danger" title={d.last_error}>Last try failed</span>}
                  <span className="ml-auto text-fg-3" title={formatDateTime(d.delivered_at ?? d.created_at).title}>{formatDateTime(d.delivered_at ?? d.created_at).label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {confirmDialog}
    </form>
  )
}
