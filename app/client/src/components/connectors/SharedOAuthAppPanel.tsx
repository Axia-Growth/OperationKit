/**
 * OPTIONAL shared third-party OAuth app (Sprint 7.7, obj 900511).
 *
 * A standalone, collapsed-by-default section on an eligible Integrations card.
 * It lets an admin point THIS ONE connector at a shared OAuth app run by a third
 * party of their choosing, for providers where registering your own app is
 * hard. It is never required, never on by default, and ships with every field
 * empty — Operation Kit runs no shared app and suggests none.
 *
 * Renders only from `connector.shared_app` (null → renders nothing). Holds no
 * secret: issuer, client id and redirect URI are public values.
 */
import { useId, useState, type FormEvent } from 'react'
import type { ConnectorSharedApp, ConnectorSummary } from '@operationkit/shared'
import { ChevronDown } from 'lucide-react'
import { Badge, Button, Checkbox, Field, Input, useConfirm } from '../ui'
import { useBranding } from '../../hooks/useBranding'

export interface SharedAppInput {
  enabled: boolean
  issuer: string
  client_id: string
  redirect_uri: string
  provider_label?: string
}

export function sharedAppStateLabel(s: ConnectorSharedApp): { text: string; tone: 'neutral' | 'amber' } {
  if (!s.enabled) return { text: 'Off', tone: 'neutral' }
  if (s.own_app_configured) return { text: 'On — not used (your own app wins)', tone: 'neutral' }
  return { text: 'On', tone: 'amber' }
}

export function SharedOAuthAppPanel({
  connector: c,
  isAdmin,
  onSave,
  onRemove,
  defaultOpen = false,
}: {
  connector: ConnectorSummary
  isAdmin: boolean
  onSave?: (input: SharedAppInput) => Promise<boolean>
  onRemove?: () => Promise<boolean>
  defaultOpen?: boolean
}) {
  const s = c.shared_app ?? null
  const brand = useBranding().name
  const ids = useId()
  const [open, setOpen] = useState(defaultOpen)
  const [busy, setBusy] = useState(false)
  const { confirm, confirmDialog } = useConfirm()
  const [form, setForm] = useState<SharedAppInput>(() => ({
    enabled: s?.enabled ?? false,
    issuer: s?.issuer ?? '',
    client_id: s?.client_id ?? '',
    redirect_uri: s?.redirect_uri ?? '',
    provider_label: s?.provider_label ?? '',
  }))
  if (!s) return null

  const state = sharedAppStateLabel(s)
  const editable = isAdmin && !!onSave
  const complete = form.issuer.trim() !== '' && form.client_id.trim() !== '' && form.redirect_uri.trim() !== ''

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!onSave || !complete) return
    setBusy(true)
    try {
      await onSave({ ...form, issuer: form.issuer.trim(), client_id: form.client_id.trim(), redirect_uri: form.redirect_uri.trim() })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!onRemove) return
    // Destructive: asks first (polish F5, obj 900806).
    const ok = await confirm({
      title: `Remove the shared app for ${c.name}?`,
      message: `${c.name} stops signing in through the third party's shared app. Anyone who connected through it will need to connect again.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      if (await onRemove()) setForm({ enabled: false, issuer: '', client_id: '', redirect_uri: '', provider_label: '' })
    } finally {
      setBusy(false)
    }
  }

  const field = (key: 'issuer' | 'client_id' | 'redirect_uri' | 'provider_label', label: string, help: string, placeholder: string) => (
    <Field id={`${ids}-${key}`} label={label} hint={help}>
      <Input
        type="text"
        autoComplete="off"
        spellCheck={false}
        disabled={!editable || busy}
        value={form[key] ?? ''}
        placeholder={placeholder}
        onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
        className="font-mono"
      />
    </Field>
  )

  return (
    <div className="border-t border-line-soft" data-testid={`shared-app-${c.id}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${ids}-body`}
        onClick={() => setOpen(o => !o)}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-2 text-left transition-colors duration-fast ease-out hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 sm:px-5"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-0">
            Shared third-party app
            <Badge>Optional</Badge>
            <Badge tone={state.tone}>{state.text}</Badge>
          </span>
          <span className="block text-xs text-fg-3">
            Only if you can't register your own {c.name} app. Not needed for a normal install.
          </span>
        </span>
        <ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 text-fg-3 transition-transform duration-fast ease-out ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div id={`${ids}-body`} className="space-y-4 px-4 pb-5 pt-1 sm:px-5">
          <div className="space-y-2 text-xs leading-relaxed text-fg-2">
            <p>
              Optional convenience. Some providers make it hard to register your own OAuth app. If so, you can sign in
              to {c.name} through a shared app that <strong className="text-fg-1">a third party you choose</strong> runs
              (an MCP auth provider, for example).
            </p>
            <p>
              <strong className="text-fg-1">This makes {c.name} depend on that third party, not on {brand}.</strong>{' '}
              {brand} does not run a shared app and does not pick one for you. Your install works without this.
              Leave it off to use your own {c.name} app.
            </p>
            {s.own_app_configured && (
              <p className="text-fg-1">This install already has its own {c.name} app, so that app is used and this setting is ignored.</p>
            )}
            <p>
              The third party must send the sign-in back to this install at{' '}
              <code className="break-all font-mono text-fg-1">{s.install_callback_uri}</code>.
            </p>
          </div>

          {!isAdmin && <p className="text-xs text-fg-3">Only an admin can change this.</p>}

          <form className="space-y-3" onSubmit={submit} aria-label={`Shared third-party app for ${c.name}`}>
            {field('provider_label', 'Who runs it (optional)', 'Shown on the connection so everyone can see who it depends on.', 'e.g. the company that runs the shared app')}
            {field('issuer', 'Issuer URL', "The third party's OAuth server. Must be https.", 'Paste from the third party you chose')}
            {field('client_id', 'Client ID', 'The client ID the third party gave you for its shared app.', 'Paste from the third party you chose')}
            {field('redirect_uri', 'Redirect URI', 'The redirect URI registered on the shared app. Must be https.', 'Paste from the third party you chose')}
            <Checkbox
              disabled={!editable || busy}
              checked={form.enabled}
              onChange={e => setForm(prev => ({ ...prev, enabled: e.target.checked }))}
              label={`Use this shared app for ${c.name} when this install has no app of its own`}
            />
            {editable && (
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" loading={busy} disabled={!complete}>Save</Button>
                {s.configured && onRemove && (
                  // Kept apart from Save (far end of the row); confirms first.
                  <Button type="button" variant="danger" className="ml-auto" disabled={busy} onClick={() => void remove()}>Remove</Button>
                )}
              </div>
            )}
          </form>
        </div>
      )}
      {confirmDialog}
    </div>
  )
}
