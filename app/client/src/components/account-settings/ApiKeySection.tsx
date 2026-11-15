/**
 * Command Center API key — Settings → You.
 * Generate once, copy, paste into Grok Bot / any agent. Revoke or rotate here.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { useConfirm } from '../ui'
// Direct module paths (not the '../ui' barrel) so suites that mock the barrel
// with only Modal/useConfirm still render this card.
import { Badge } from '../ui/Badge'
import { Button } from '../../components/ui/Button'
import { Alert } from '../ui/Alert'
import { Field, Input } from '../ui/Field'
import { SectionHeader } from '../ui/SettingsSection'
import { fmtDate } from './helpers'
import type { ApiKeyIssued, ApiKeySummary } from '@operationkit/shared'

export function ApiKeySection() {
  const [summary, setSummary] = useState<ApiKeySummary | null>(null)
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    setLoading(true)
    setError('')
    try {
      setSummary(await api.get<ApiKeySummary>('/auth/api-key'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API key')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  async function generate() {
    if (summary?.configured) {
      const ok = await confirm({
        title: 'Replace API key?',
        message: 'The old key stops working immediately. Anything using it (Grok Bot, scripts) must get the new one.',
        confirmLabel: 'Generate new key',
        danger: true,
      })
      if (!ok) return
    }
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      const issued = await api.post<ApiKeyIssued>('/auth/api-key')
      setPlaintext(issued.token)
      setSummary({ configured: true, last4: issued.last4, created_at: issued.created_at })
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body as { error?: string })?.error || err.message
        : err instanceof Error ? err.message : 'Generate failed'
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    const ok = await confirm({
      title: 'Revoke API key?',
      message: 'Grok Bot and any scripts using this key will get 401 until you generate a new one.',
      confirmLabel: 'Revoke',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      await api.del('/auth/api-key')
      setPlaintext(null)
      setCopied(false)
      setSummary({ configured: false, last4: null, created_at: null })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!plaintext) return
    try {
      await navigator.clipboard.writeText(plaintext)
      setCopied(true)
    } catch {
      setError('Could not copy — select the key and copy it yourself.')
    }
  }

  const configured = !!summary?.configured

  return (
    <section className="rounded-lg border border-line bg-surface-1 p-5" aria-labelledby="api-key-heading">
      <SectionHeader
        headingId="api-key-heading"
        className="mb-4"
        title="API key"
        description={
          <>
            For your own scripts: full REST access that acts as you everywhere. Paste as{' '}
            <span className="font-mono">Authorization: Bearer …</span>. We only show the full key once. Do not give it
            to a bot — make a scoped agent key above instead (this key is read-only over MCP).
          </>
        }
        actions={
          configured && (
            // Same green status badge as Connected / Healthy / Active elsewhere; the
            // greige uppercase chip read as a warning (QA obj 900621).
            <Badge tone="verify" className="shrink-0">Active</Badge>
          )
        }
      />

      {error && <Alert tone="alarm" title={error} className="mb-3" />}

      {loading ? (
        <div className="text-base text-fg-3">Loading…</div>
      ) : (
        <div className="space-y-3">
          {plaintext && (
            <Field label="Copy this now — it will not be shown again">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input readOnly value={plaintext} className="font-mono" onFocus={e => e.currentTarget.select()} />
                <Button variant="primary" className="shrink-0" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </Field>
          )}

          {!plaintext && configured && (
            <p className="font-mono text-base text-fg-1">cc_live_••••••••{summary!.last4}</p>
          )}
          {configured && summary?.created_at && (
            <p className="text-xs text-fg-3">Created {fmtDate(summary.created_at)}</p>
          )}
          {!configured && !plaintext && (
            <p className="text-base text-fg-2">No key yet. Generate one, copy it, paste it into Grok Bot.</p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => void generate()} disabled={busy}>
              {busy ? 'Working…' : configured ? 'Generate new key' : 'Generate API key'}
            </Button>
            {configured && (
              <Button type="button" variant="danger" onClick={() => void revoke()} disabled={busy}>
                Revoke
              </Button>
            )}
          </div>
        </div>
      )}
      {confirmDialog}
    </section>
  )
}
