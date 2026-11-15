/**
 * Bot access for ONE secret name (obj 900749).
 *
 * Bots (in-app chat bots, MCP-connected bots, workers) never see a secret.
 * They name it — `{{secret:NAME}}` — and the server adds the value to one
 * outgoing HTTPS request, only to the hosts listed here, then blanks it out of
 * the reply. With no hosts, no bot can use it (default-deny).
 *
 * This dialog edits only that allowlist. It never shows, asks for or changes
 * the value, the scope or any other part of the stored secret.
 */
import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { Alert, Button, Checkbox, Field, IconButton, Modal, Textarea } from '../ui'
import type { SecretSummary } from '@operationkit/shared'
import { BOT_METHODS, clearBotAccess, saveBotAccess, type BotAccessEntry } from './botAccess'

interface Props {
  secret: SecretSummary
  entry: BotAccessEntry | null
  organizations: { slug: string; name: string }[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}

export function BotAccessModal({ secret, entry, organizations, onClose, onSaved }: Props) {
  const isGlobal = secret.scopeType === 'global'
  const [hosts, setHosts] = useState((entry?.hosts ?? []).join('\n'))
  const [methods, setMethods] = useState<string[]>(entry?.methods?.length ? entry.methods : [...BOT_METHODS])
  const [orgs, setOrgs] = useState<string[]>(entry?.workspaces ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const hostList = hosts.split(/[\s,]+/).map(h => h.trim()).filter(Boolean)
  const allMethods = methods.length === BOT_METHODS.length

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (hostList.length === 0) {
      setError('Add at least one host, or use "Turn off".')
      return
    }
    if (methods.length === 0) {
      setError('Pick at least one method.')
      return
    }
    setSaving(true)
    try {
      await saveBotAccess(secret.key, {
        hosts: hostList,
        ...(allMethods ? {} : { methods }),
        ...(isGlobal ? { workspaces: orgs } : entry?.workspaces?.length ? { workspaces: entry.workspaces } : {}),
        ...(entry?.description ? { description: entry.description } : {}),
      })
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  async function turnOff() {
    setSaving(true)
    setError('')
    try {
      await clearBotAccess(secret.key)
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn off')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="bot-access-title" panelClassName="max-w-lg bg-surface-1">
      <form className="p-6" onSubmit={submit} data-testid="bot-access-modal">
        <div className="mb-1 flex items-center justify-between">
          <h2 id="bot-access-title" className="text-lg font-semibold text-fg-0">Bot access</h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2 text-fg-3">
            <X className="h-5 w-5" aria-hidden />
          </IconButton>
        </div>
        <p className="mb-4 font-mono text-xs text-fg-1">{secret.key}</p>

        <p className="mb-4 rounded-md border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-fg-2">
          Bots never see this value. A bot writes <span className="font-mono text-fg-1">{`{{secret:${secret.key}}}`}</span> in a request;
          the server adds the value, sends it only to the hosts below, and blanks it out of the reply.
          Every use is logged by name.
        </p>

        <Field
          id="bot-access-hosts"
          label="Allowed hosts"
          className="mb-4"
          hint={<>One per line. HTTPS only. <span className="font-mono">*.example.com</span> covers its subdomains.</>}
        >
          <Textarea
            data-testid="bot-access-hosts"
            value={hosts}
            onChange={e => setHosts(e.target.value)}
            rows={3}
            placeholder={'api.example.com\n*.example.com'}
            className="font-mono"
          />
        </Field>

        <fieldset className="mb-4">
          <legend className="mb-1 text-sm font-medium text-fg-1">Methods</legend>
          <div className="flex flex-wrap gap-x-4">
            {BOT_METHODS.map(m => (
              <Checkbox
                key={m}
                checked={methods.includes(m)}
                onChange={() => setMethods(cur => toggle(cur, m))}
                label={<span className="font-mono text-xs">{m}</span>}
              />
            ))}
          </div>
        </fieldset>

        {isGlobal && (
          <fieldset className="mb-4">
            <legend className="mb-1 text-sm font-medium text-fg-1">Workspaces whose bots may use it</legend>
            {organizations.length === 0 ? (
              <p className="text-xs text-fg-3">No organizations.</p>
            ) : (
              <div className="flex flex-wrap gap-x-4" data-testid="bot-access-orgs">
                {organizations.map(o => (
                  <Checkbox
                    key={o.slug}
                    checked={orgs.includes(o.slug)}
                    onChange={() => setOrgs(cur => toggle(cur, o.slug))}
                    label={o.name}
                  />
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-fg-3">
              This secret applies everywhere. Bots and API keys only get it in the workspaces ticked here.
            </p>
          </fieldset>
        )}

        {error && <Alert tone="alarm" title={error} className="mb-3" />}

        <div className="flex items-center justify-between gap-3">
          {entry ? (
            <Button type="button" variant="danger" size="sm" onClick={() => void turnOff()} disabled={saving}>
              Turn off
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={saving}
              data-testid="bot-access-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
