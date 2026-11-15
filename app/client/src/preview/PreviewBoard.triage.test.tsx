// @vitest-environment jsdom
/**
 * obj 900869 — Needs You bulk triage on the live board: select cards, confirm,
 * and the action goes to the server as an audited batch. Also: the owner
 * filter lists bots and selecting one filters the board to that bot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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


vi.mock('../components/SessionViewer', () => ({
  SessionViewer: () => null,
}))

vi.mock('../components/ObjectiveModal', () => ({
  ObjectiveModal: () => null,
}))

vi.mock('../components/ObjectiveSearchPanel', () => ({
  ObjectiveSearchPanel: () => null,
}))



const apiPost = vi.fn()
const apiGet = vi.fn((path: string) => {
  if (path.startsWith('/board-triage/owners')) {
    return Promise.resolve({ humans: [{ id: 1, username: 'operator' }, { id: 2, username: 'casey' }], bots: [{ id: 'operation-kit', name: 'Operation Kit' }] })
  }
  if (path.startsWith('/board-triage/batches')) return Promise.resolve({ batches: [] })
  return Promise.resolve([])
})
vi.mock('../lib/api', () => ({
  api: { get: (p: string) => apiGet(p), post: (...a: unknown[]) => apiPost(...a), patch: vi.fn(), del: vi.fn() },
}))

import { PreviewBoard } from './PreviewBoard'

function card(id: number, status: Objective['status'], extra: Partial<Objective> = {}): Objective {
  return {
    id, title: `card ${id}`, status, session_id: null, workspace: 'example', parent_id: null,
    routine_id: null, delegate_mode: 0, has_blockers: 0, assigned_usernames: [],
    updated_at: '2026-11-12 14:00:00', created_at: '2026-11-12 14:00:00',
    ...extra,
  } as unknown as Objective
}

describe('PreviewBoard — Needs You bulk triage (obj 900869)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    apiPost.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    root.unmount()
    container.remove()
    document.body.innerHTML = ''
  })

  const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
  const click = async (el: Element | null) => {
    expect(el).toBeTruthy()
    flushSync(() => (el as HTMLElement).click())
    await flush()
  }
  const boxes = () => Array.from(container.querySelectorAll('section[data-status="review"] [data-testid="triage-select"]')) as HTMLInputElement[]
  const buttonByText = (text: string) =>
    Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === text) ?? null

  async function mount() {
    mockObjectives = [
      card(1, 'review', { assigned_usernames: ['operator'], bot_owner: 'operation-kit', bot_owner_name: 'Operation Kit' }),
      card(2, 'review', { assigned_usernames: ['operator'] }),
      card(3, 'review'),
      card(4, 'review', { session_id: 'cc-4-1' }), // agent still on it → Working, not selectable
      card(5, 'working', { session_id: 'cc-5-1', bot_owner: 'operation-kit', bot_owner_name: 'Operation Kit' }),
    ]
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} />))
    await flush()
  }

  it('no select boxes until Select is turned on; only Needs You cards get one', async () => {
    await mount()
    expect(boxes()).toHaveLength(0)
    expect(q('[data-testid="triage-bar"]')).toBeNull()
    await click(q('[data-testid="triage-toggle"]'))
    expect(q('[data-testid="triage-bar"]')).toBeTruthy()
    expect(boxes()).toHaveLength(3)
    expect(container.querySelectorAll('section[data-status="working"] [data-testid="triage-select"]')).toHaveLength(0)
    expect(q('[data-testid="triage-count"]')?.textContent).toBe('0 of 3 selected')
  })

  it('approve asks for confirmation, then sends ONE audited batch with only the selected ids', async () => {
    apiPost.mockResolvedValue({
      batch_id: 41, action: 'approve', requested: 2, ok: 2, skipped: 0, failed: 0,
      items: [
        { objective_id: 1, title: 'card 1', result: 'ok', from_status: 'review', to_status: 'done' },
        { objective_id: 3, title: 'card 3', result: 'ok', from_status: 'review', to_status: 'done' },
      ],
    })
    await mount()
    await click(q('[data-testid="triage-toggle"]'))
    const ids = () => boxes().map(b => b.getAttribute('aria-label'))
    await click(boxes().find(b => b.getAttribute('aria-label')?.startsWith('Select #1 '))!)
    await click(boxes().find(b => b.getAttribute('aria-label')?.startsWith('Select #3 '))!)
    expect(ids()).toHaveLength(3)
    expect(q('[data-testid="triage-count"]')?.textContent).toBe('2 of 3 selected')

    await click(q('[data-testid="triage-approve"]'))
    // Nothing is sent before the person confirms.
    expect(apiPost).not.toHaveBeenCalled()
    const dialog = q('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Approve 2 cards?')
    expect(dialog?.textContent).toContain('#1 card 1')
    expect(dialog?.textContent).toContain('#3 card 3')

    await click(buttonByText('Approve 2'))
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiPost.mock.calls[0][0]).toBe('/board-triage/batches')
    expect(apiPost.mock.calls[0][1]).toEqual({ action: 'approve', objective_ids: [1, 3] })
    const result = q('[data-testid="triage-result"]')
    expect(result?.textContent).toContain('2 approved')
    expect(result?.textContent).toContain('#41')
  })

  it('cancelling the confirmation sends nothing', async () => {
    await mount()
    await click(q('[data-testid="triage-toggle"]'))
    await click(buttonByText('Select all 3'))
    expect(q('[data-testid="triage-count"]')?.textContent).toBe('3 of 3 selected')
    await click(q('[data-testid="triage-dismiss"]'))
    expect(q('[role="alertdialog"]')?.textContent).toContain('Dismiss 3 cards?')
    await click(buttonByText('Cancel'))
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('skipped cards are listed with the reason and stay selected', async () => {
    apiPost.mockResolvedValue({
      batch_id: 42, action: 'dismiss', requested: 2, ok: 1, skipped: 1, failed: 0,
      items: [
        { objective_id: 2, title: 'card 2', result: 'ok', from_status: 'review', to_status: 'cancelled' },
        { objective_id: 3, title: 'card 3', result: 'skipped', from_status: 'review', to_status: null, error: 'You do not have access to this objective' },
      ],
    })
    await mount()
    await click(q('[data-testid="triage-toggle"]'))
    await click(boxes().find(b => b.getAttribute('aria-label')?.startsWith('Select #2 '))!)
    await click(boxes().find(b => b.getAttribute('aria-label')?.startsWith('Select #3 '))!)
    await click(q('[data-testid="triage-dismiss"]'))
    await click(buttonByText('Dismiss 2'))
    expect(apiPost.mock.calls[0][1]).toEqual({ action: 'dismiss', objective_ids: [2, 3] })
    const result = q('[data-testid="triage-result"]')
    expect(result?.textContent).toContain('1 dismissed, 1 skipped')
    expect(result?.textContent).toContain('You do not have access to this objective')
    await click(buttonByText('Close'))
    // card 2 changed and left the selection; card 3 was skipped and stays selected.
    expect(q('[data-testid="triage-count"]')?.textContent).toBe('1 of 3 selected')
  })

  it('reassign hands the selection to a person through the same audited batch route', async () => {
    apiPost.mockResolvedValue({ batch_id: 43, action: 'reassign', requested: 1, ok: 1, skipped: 0, failed: 0, items: [
      { objective_id: 2, title: 'card 2', result: 'ok', from_status: 'review', to_status: 'review' },
    ] })
    await mount()
    await click(q('[data-testid="triage-toggle"]'))
    await click(boxes().find(b => b.getAttribute('aria-label')?.startsWith('Select #2 '))!)
    await click(q('[data-testid="triage-reassign"]'))
    expect(q('[data-testid="reassign-dialog"]')).toBeTruthy()
    expect(apiGet).toHaveBeenCalledWith('/board-triage/owners')
    // Nothing chosen yet → the confirm button is disabled.
    expect((q('[data-testid="reassign-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('PreviewBoard — owner filter lists bots (obj 900869)', () => {
  let container: HTMLElement
  let root: Root
  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { root.unmount(); container.remove(); document.body.innerHTML = '' })

  it('the Owner panel has a Bots group, and picking only the bot shows only its cards', async () => {
    mockObjectives = [
      card(1, 'working', { session_id: 'cc-1-1', bot_owner: 'operation-kit', bot_owner_name: 'Operation Kit' }),
      card(2, 'queue', { assigned_usernames: ['operator'] }),
      card(3, 'queue'),
    ]
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} />))
    await flush()
    const cardIds = () => Array.from(container.querySelectorAll('article .text-base.font-medium')).map(e => e.textContent)
    expect(cardIds().sort()).toEqual(['card 1', 'card 2', 'card 3'])

    // Open the Owner dropdown.
    const trigger = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Owner'))
    flushSync(() => trigger!.click())
    await flush()
    const botRow = document.querySelector('[data-owner="bot:operation-kit"]') as HTMLElement
    expect(botRow).toBeTruthy()
    expect(botRow.textContent).toContain('Operation Kit')
    expect(document.body.textContent).toContain('Bots')

    // Turn off Unassigned and operator, turn on the bot.
    for (const t of ['__unassigned__', 'operator']) {
      flushSync(() => (document.querySelector(`[data-owner="${t}"]`) as HTMLElement).click())
      await flush()
    }
    flushSync(() => (document.querySelector('[data-owner="bot:operation-kit"]') as HTMLElement).click())
    await flush()
    expect(cardIds()).toEqual(['card 1'])
  })
})
