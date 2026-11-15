/**
 * obj 900947 — board owner-bot filter + the owner bot's avatar on each card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { Objective, User, Workspace } from '@operationkit/shared'

// Hoisted above vi.mock factories' first call (they run lazily on import).
let mockObjectives: Objective[] = []

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

// ── Mocks ────────────────────────────────────────────────────────────────────

// Control which user is returned from useAuth.
let mockUser: User = {
  id: 1,
  username: 'operator',
  role: 'admin',
  workspaces: [],
  created_at: '2026-01-01T00:00:00Z',
}

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}))

vi.mock('../context/nav', () => ({
  useNavigate: () => vi.fn(),
  NavContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
}))

vi.mock('../hooks/useObjectives', () => ({
  useObjectives: () => ({
    objectives: mockObjectives, loading: false, error: null, connectionState: 'connected',
    changeStatus: vi.fn(), createObjective: vi.fn(), updateObjective: vi.fn(),
    deleteObjective: vi.fn(), doneObjectives: [], doneLoading: false,
    doneLoaded: true, doneHasMore: false, loadMoreDone: vi.fn(),
  }),
}))

vi.mock('../hooks/useProjects', () => ({
  ALL_ORGS: '*',
  useProjects: () => ({
    projects: [], loading: false, refresh: vi.fn(),
    createProject: vi.fn(), renameProject: vi.fn(), deleteProject: vi.fn(),
  }),
}))

vi.mock('../hooks/useWorkspaces', () => ({
  invalidateWorkspacesCache: vi.fn(),
  useWorkspaces: () => ({
    workspaces: [
      { slug: 'example', name: 'Example', short_label: 'Example' },
      { slug: 'example2', name: 'Example3', short_label: 'GF' },
    ],
    slugs: ['example', 'example2'],
    loading: false,
    refresh: vi.fn(),
    labelOf: (s: string) => s,
    shortOf: (s: string) => s,
    badgeOf: () => null,
    agentPoolOf: () => [],
  }),
}))

vi.mock('../hooks/useSlashSearch', () => ({
  useSlashSearch: () => [false, vi.fn()] as [boolean, (v: boolean) => void],
}))

vi.mock('../hooks/useMediaQuery', () => ({
  useIsBoardMobile: () => false,
}))

// The bot list the board reads avatars from (GET /api/agent-chat/agents); everything else answers [].
vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn((path: string) => Promise.resolve(path === '/agent-chat/agents'
      ? { agents: [
          { slug: 'your-org-cto', name: 'CTO', file_name: 'CTO', avatar: 'CT', colour: 'blue' },
          { slug: 'okit-dev', name: 'Operation Kit Dev', file_name: 'Operation Kit Dev', avatar: 'OK', colour: 'green' },
        ] }
      : [])),
    post: vi.fn(), patch: vi.fn(), del: vi.fn(),
  },
}))

vi.mock('../components/SessionViewer', () => ({
  SessionViewer: () => null,
}))

vi.mock('../components/ObjectiveModal', () => ({
  ObjectiveModal: () => null,
}))

vi.mock('../components/ObjectiveSearchPanel', () => ({
  ObjectiveSearchPanel: () => null,
}))

// The real OwnerTag on a stub card, so the avatar on each card is the one the board renders.
vi.mock('./PreviewCard', async () => {
  const { OwnerTag } = await import('../components/OwnerTag')
  return {
    PreviewCard: ({ objective }: { objective: Objective }) => (
      <div data-testid="card" data-id={objective.id}><OwnerTag objective={objective} /></div>
    ),
  }
})

vi.mock('../components/design/primitives', () => ({
  STATUS_META: {
    planning:  { label: 'Plan',      tw: '', tone: '' },
    queue:     { label: 'Queue',     tw: '', tone: '' },
    working:   { label: 'Working',   tw: '', tone: '' },
    ai_review: { label: 'AI Rev',    tw: '', tone: '' },
    review:    { label: 'Needs You', tw: '', tone: '' },
    done:      { label: 'Done',      tw: '', tone: '' },
    cancelled: { label: 'Retired',   tw: '', tone: '' },
  },
  StatusDot: () => null,
  AgentMonogram: () => null,
}))

// Keep the real primitives (Button, IconButton, Input, …); stub only these.
vi.mock('../components/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfirm: () => ({ confirm: () => Promise.resolve(true), confirmDialog: null }),
}))

import { PreviewBoard } from './PreviewBoard'



// obj 900947 — the board's owner filter by bot (built on obj 900869's Bots group)
// plus the owner bot's avatar on each card, and the bot Work tab's
// "Open on board" deep link (/?owner=bot:<id>).
function card(id: number, bot: { id: string; name: string } | null, status: Objective['status'] = 'working'): Objective {
  return {
    id, title: `card ${id}`, status, session_id: status === 'working' ? `cc-${id}-1` : null, workspace: 'example', parent_id: null,
    routine_id: null, delegate_mode: 0, has_blockers: 0, assigned_usernames: [], agent_context: 'general',
    owner_bot: bot?.id ?? null, bot_owner: bot?.id ?? null, bot_owner_name: bot?.name ?? null,
    updated_at: '2026-11-12 14:00:00', created_at: '2026-11-12 14:00:00',
  } as unknown as Objective
}
const CTO = { id: 'Grok: CTO', name: 'CTO' }
const DEV = { id: 'Operation Kit Dev', name: 'Operation Kit Dev' }

describe('PreviewBoard — owner bot filter + avatar (obj 900947)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '/')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockObjectives = [card(1, CTO), card(2, DEV), card(3, null), card(4, CTO, 'queue')]
  })

  const shown = () => Array.from(container.querySelectorAll('[data-testid="card"]')).map(e => Number(e.getAttribute('data-id'))).sort((a, b) => a - b)

  it('each bot-owned card shows its owner bot\'s avatar; a card with no bot shows none', async () => {
    window.history.replaceState(null, '', '/?owner=' + encodeURIComponent('bot:Grok: CTO'))
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} />))
    await flush()
    const avatarOf = (id: number) => container.querySelector(`[data-testid="card"][data-id="${id}"] [data-testid="bot-avatar-mini"]`)
    expect(avatarOf(1)?.textContent).toBe('CT')
    expect(avatarOf(1)?.getAttribute('data-bot-slug')).toBe('your-org-cto')
  })

  it('/?owner=bot:<id> filters the board to that bot\'s cards, and the param is dropped', async () => {
    window.history.replaceState(null, '', '/?owner=' + encodeURIComponent('bot:Grok: CTO'))
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} />))
    await flush()
    expect(shown()).toEqual([1, 4])
    expect(window.location.search).toBe('')
    expect(container.querySelector('[data-testid="owner-filter"]')?.textContent).toContain('CTO')
    // Saved like a click, so the board keeps the bot filter on its next visit.
    expect(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes('example'))!)!)).toEqual(['bot:Grok: CTO'])
  })

  it('the owner filter lists the bots with their avatars, and picking one shows only its cards', async () => {
    window.history.replaceState(null, '', '/?owner=' + encodeURIComponent('bot:Operation Kit Dev'))
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} />))
    await flush()
    expect(shown()).toEqual([2])
    const trigger = container.querySelector('[data-testid="owner-filter"] button') as HTMLButtonElement
    trigger.click()
    await flush()
    const row = (token: string) => document.body.querySelector(`[data-owner="${token}"]`) as HTMLElement
    expect(row('bot:Grok: CTO').querySelector('[data-testid="bot-avatar-mini"]')?.textContent).toBe('CT')
    expect(row('bot:Operation Kit Dev').querySelector('[data-testid="bot-avatar-mini"]')?.textContent).toBe('OK')
    row('bot:Grok: CTO').click()
    await flush()
    expect(shown()).toEqual([1, 2, 4])
  })
})
