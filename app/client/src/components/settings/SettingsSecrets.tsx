/**
 * Settings → Secrets — the ONE place for every secret (obj 900681).
 *
 * Sub-tabs split by WHO the secret belongs to, not by where it used to live:
 *   - Mine             every signed-in user; their own `user`-scoped secrets
 *                      (was "My Secrets" on API & MCP).
 *   - Shared           workspace / global admins; the cross-scope store
 *                      (organization, Command Center, and per-user rows).
 *   - Test credentials workspace / global admins; reviewer login bundles.
 *
 * Admins land on Shared (their usual job); everyone else lands on Mine, which
 * is the only sub-tab they get. `?view=mine|shared|test` deep-links a sub-tab.
 * See docs/settings/API-MCP-SECRETS-CLEANUP.md for the structure decision.
 */
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { SegmentedControl } from '../ui'
import type { TabItem } from '../ui'
import { SecretsPage } from '../SecretsPage'
import { TestCredentialsPage } from '../TestCredentialsPage'
import { MySecretsSection } from '../account-settings/MySecretsSection'
import { canManageSharedSecrets } from '../../lib/secretsAccess'
import { SecurityStrip } from '../secrets/SecurityStrip'

export { canManageSharedSecrets }

type View = 'mine' | 'shared' | 'test'

export function SettingsSecrets() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const isAdmin = canManageSharedSecrets(user)

  const items: TabItem[] = isAdmin
    ? [
        { key: 'shared', label: 'Shared' },
        { key: 'mine', label: 'Mine' },
        { key: 'test', label: 'Test credentials' },
      ]
    : [{ key: 'mine', label: 'Mine' }]

  const requested = params.get('view') as View | null
  const view: View = requested && items.some(i => i.key === requested) ? requested : isAdmin ? 'shared' : 'mine'

  function select(key: string) {
    const next = new URLSearchParams(params)
    next.set('view', key)
    setParams(next, { replace: true })
  }

  const body = (
    <>
      {view === 'mine' && (
        <div>
          {/* Same three promises as Shared (obj 900749): your own secrets are just as write-only. */}
          <SecurityStrip />
          <MySecretsSection />
        </div>
      )}
      {view === 'shared' && <SecretsPage embedded />}
      {view === 'test' && <TestCredentialsPage embedded />}
    </>
  )

  return (
    <div>
      {items.length > 1 ? (
        // Which list to show — Settings owns the page's one tab row, so this is
        // a SegmentedControl (obj 900807), never a second, nested Tabs.
        <>
          <SegmentedControl items={items} value={view} onChange={select} label="Secret lists" />
          <div className="mt-4">{body}</div>
        </>
      ) : (
        body
      )}
    </div>
  )
}
