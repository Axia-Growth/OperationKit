/**
 * One Settings app: Models | API & MCP | Integrations | Secrets | Workspaces |
 * Branding | Email | Knowledge search (admin: embedding provider + index status).
 *
 * Agents & Skills is NOT a Settings tab (obj 900684): it was a second copy of
 * the registry that already lives on the Agents & Skills page (/agents). The old
 * /settings/agents-skills URL redirects there (LEGACY_REDIRECTS in lib/routes.ts).
 *
 * Sprint 4b reorg (obj 900496): renamed from the earlier You / Connectors /
 * Secrets / Seats / Org / Agents / Platform set — see
 * docs/settings/SPRINT-4B-REORG.md for the why. Old bookmarks still work via
 * the redirects below.
 *
 * obj 900686: the Platform tab is gone. '/settings/platform' has redirected to
 * Jobs since obj 900495 (LEGACY_REDIRECTS), so the tab was only a link to Jobs.
 * Its last piece, the queue auto-start switch, now lives on the Jobs page.
 */
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { PageContainer, PageHeader, Tabs } from '../ui'
import type { TabItem } from '../ui'
import { canManageSharedSecrets } from '../../lib/secretsAccess'

const MODELS = 'models'
const API_MCP = 'api-mcp'
const INTEGRATIONS = 'integrations'
const SECRETS = 'secrets'
const WORKSPACES = 'workspaces'
const BRANDING = 'branding'
const EMAIL = 'email'
const KNOWLEDGE_SEARCH = 'knowledge-search'

const TAB_COPY: Record<string, string> = {
  [MODELS]: 'Subscription seats, API-key providers, and which model runs by default.',
  [API_MCP]: 'Connect a coding agent, your API key, MCP agent keys, and webhooks.',
  [INTEGRATIONS]: 'Accounts agents can work in for you, like GitHub and Google Workspace.',
  [SECRETS]: 'Your own secrets, shared workspace secrets, and reviewer test credentials.',
  [WORKSPACES]: 'Workspaces and users.',
  [BRANDING]: 'Logo, colors, and name shown across the app.',
  [EMAIL]: 'Outbound mail and onboarding notifications.',
  [KNOWLEDGE_SEARCH]: 'How knowledge search matches pages by meaning, and the state of its index.',
}

export function SettingsPage() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const isGlobalAdmin = user?.role === 'admin'
  const canSharedSecrets = canManageSharedSecrets(user)

  const tabs: TabItem[] = [
    ...(isGlobalAdmin ? [{ key: MODELS, label: 'Models' }] : []),
    { key: API_MCP, label: 'API & MCP' },
    { key: INTEGRATIONS, label: 'Integrations' },
    // Everyone gets Secrets since obj 900681: "Mine" (personal secrets, folded in
    // from API & MCP) is for every user; the Shared / Test credentials sub-tabs
    // stay admin-only inside SettingsSecrets.
    { key: SECRETS, label: 'Secrets' },
    ...(isGlobalAdmin
      ? [
          { key: WORKSPACES, label: 'Workspaces' },
          { key: BRANDING, label: 'Branding' },
          { key: EMAIL, label: 'Email' },
          { key: KNOWLEDGE_SEARCH, label: 'Knowledge search' },
        ]
      : []),
  ]

  const segment = location.pathname.split('/')[2] || API_MCP
  const allowed = new Set(tabs.map(t => t.key))
  // Old bookmarks from before the sprint 4b reorg (obj 900496), plus the
  // older Account/Test-credentials ones from before that.
  if (segment === 'account' || segment === 'you') {
    return <Navigate to={{ pathname: `/settings/${API_MCP}`, search: location.search }} replace />
  }
  if (segment === 'connectors') {
    return <Navigate to={{ pathname: `/settings/${INTEGRATIONS}`, search: location.search }} replace />
  }
  if (segment === 'seats') {
    return <Navigate to={{ pathname: `/settings/${MODELS}`, search: location.search }} replace />
  }
  // Settings → Org became Settings → Workspaces (obj 900758).
  if (segment === 'org') {
    return <Navigate to={{ pathname: `/settings/${WORKSPACES}`, search: location.search }} replace />
  }
  if (segment === 'test-credentials') {
    return <Navigate to={`/settings/${SECRETS}`} replace />
  }
  if (!allowed.has(segment)) {
    return <Navigate to={`/settings/${tabs[0]?.key ?? API_MCP}`} replace />
  }

  return (
    // One content width for every tab (polish F5, obj 900806): the 1200px reading
    // width, and no tab sets its own cap. Before, Models / API & MCP /
    // Integrations stopped at ~790–920px while Secrets / Workspaces / Branding
    // ran to 1600px, so the page jumped as you switched tabs.
    <PageContainer width="default" scroll="page">
      <PageHeader
        title="Settings"
        description={
          segment === SECRETS && !canSharedSecrets
            ? 'Your own secrets. Stored encrypted; never shown again after you save them.'
            : TAB_COPY[segment] || 'Your settings.'
        }
      />
      <Tabs
        items={tabs}
        value={segment}
        onChange={key => navigate(`/settings/${key}`)}
        label="Settings sections"
        activation="manual"
        panelClassName="mt-5"
      >
        <div data-testid="settings-content" className="w-full min-w-0">
          <Outlet />
        </div>
      </Tabs>
    </PageContainer>
  )
}
