/**
 * Settings → Users → "Cloudflare sign-in sync" (obj 900023).
 *
 * Behind Cloudflare Access an admin can add a teammate here and still have them
 * turned away at Cloudflare, unless their email is on the Access "Allowed people"
 * policy. With a Cloudflare API token that can edit Access policies, the server
 * adds and removes those emails itself. This card is where an admin enters that
 * token.
 *
 * The token is WRITE-ONLY: the field always starts empty, the value is sent once
 * on Save and then cleared from memory, and no API ever sends it back — the card
 * only ever sees whether one is set, where from, and whether it works.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CfAccessSyncState } from '@operationkit/shared'
import { Alert, Button, Card, CardHeader, Field, Input } from '../ui'
import { api } from '../../lib/api'

/** Plain-language reading of the health check. Never shows a credential. */
const HEALTH_NOTE: Record<Exclude<CfAccessSyncState['health'], 'ok' | null>, string> = {
  not_configured: 'The token is saved, but this install is missing its Cloudflare Access settings. Re-run the installer update.',
  forbidden: 'The token works, but it is not allowed to edit Access policies. Create one with Account → Access: Apps and Policies → Edit, then paste it here.',
  app_not_found: "The token can't see this site's Access application. Check that it is for the Cloudflare account that hosts this site.",
  policy_not_found: 'This site\'s Access application has no "Allowed people" policy. Re-run the installer update to recreate it.',
  policy_refused: 'The configured Access policy is not an allow policy, so it is left alone.',
  unreachable: "Cloudflare couldn't be reached just now. People can still be added; their status will update when it is back.",
  cloudflare_error: 'Cloudflare returned an error just now. People can still be added; their status will update later.',
}

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function CfAccessSyncCard({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<CfAccessSyncState | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await api.get<CfAccessSyncState>('/admin/users/cloudflare-sync'))
    } catch {
      setState(null)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  // Not behind Cloudflare Access: there is no second door, so nothing to set up.
  if (!state || !state.applies) return null

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      setState(await api.put<CfAccessSyncState>('/admin/users/cloudflare-sync', { token: draft.trim() }))
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the token')
    } finally {
      setDraft('') // never keep the value around, success or not
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      setState(await api.del<CfAccessSyncState>('/admin/users/cloudflare-sync'))
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the token')
    } finally {
      setBusy(false)
    }
  }

  const healthNote = state.configured && state.health && state.health !== 'ok' ? HEALTH_NOTE[state.health] : null

  return (
    <Card inset data-testid="cf-access-sync-card">
      <CardHeader title="Cloudflare sign-in sync" />
      <div className="space-y-3 p-4">
        {!state.configured && (
          <Alert tone="amber" title="Cloudflare sync not set up: add the token below" data-testid="cf-sync-not-set-up">
            Without it, people you add here show
            an amber &ldquo;blocked&rdquo; badge until someone adds them in the Cloudflare dashboard. With the
            token, adding or removing someone here updates Cloudflare for you.
          </Alert>
        )}
        {state.configured && state.health === 'ok' && (
          <Alert tone="verify" title="Cloudflare sync is on" data-testid="cf-sync-on">
            Adding, re-emailing or removing someone here updates this site&apos;s &ldquo;Allowed people&rdquo; list at Cloudflare.
            {state.source === 'env'
              ? ' The token was set by the installer.'
              : state.updated_at ? ` Token saved ${when(state.updated_at)}.` : ''}
          </Alert>
        )}
        {healthNote && (
          <Alert tone="info" title="Cloudflare sync is paused" data-testid="cf-sync-paused">
            {healthNote} Adding and removing people here still works.
          </Alert>
        )}
        <form onSubmit={save} className="space-y-3">
          <Field
            label={state.configured ? 'Replace the Cloudflare API token' : 'Cloudflare API token'}
            id="cf-access-sync-token"
            hint={
              <>
                In Cloudflare: My Profile → API Tokens → Create Token → Custom token. Give it one permission,
                Account → Access: Apps and Policies → Edit, for the account that hosts this site. It is stored
                encrypted and never shown again.
              </>
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={state.configured ? 'Saved (hidden). Paste a new token to replace it' : 'Paste the token'}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="font-mono"
            />
          </Field>
          {error && <Alert tone="alarm" title={error} />}
          <div className="flex justify-end gap-2">
            {state.source === 'settings' && (
              <Button type="button" variant="ghost" size="sm" onClick={() => void remove()} disabled={busy}>
                Remove token
              </Button>
            )}
            <Button type="submit" variant="primary" size="sm" disabled={busy || !draft.trim()}>
              {busy ? 'Saving…' : 'Save token'}
            </Button>
          </div>
        </form>
      </div>
    </Card>
  )
}
