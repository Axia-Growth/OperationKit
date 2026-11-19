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

type Body = { action: string; objective_ids: number[]; dry_run?: boolean }
/** The dry run the bar asks for before it confirms (obj 901519). `skip` = ids the server would leave alone. */
function previewOf(body: Body, skip: Record<number, string> = {}) {
  const items = body.objective_ids.map(id => skip[id]
    ? { objective_id: id, title: `card ${id}`, result: 'skipped', from_status: 'review', to_status: null, error: skip[id] }
    : { objective_id: id, title: `card ${id}`, result: 'would_change', from_status: 'review', to_status: body.action === 'approve' ? 'done' : 'cancelled' })
  const would = items.filter(i => i.result === 'would_change').length
  return { dry_run: true, action: body.action, requested: items.length, would_change: would, skipped: items.length - would, failed: 0, items, note: 'Nothing was changed.' }
}
/** Dry-run posts answer with a preview; the real post answers with `real`. */
function serveTriage(real: unknown, skip: Record<number, string> = {}) {
  apiPost.mockImplementation(async (_p: unknown, body: unknown) => ((body as Body).dry_run ? previewOf(body as Body, skip) : real))
}
const realPosts = () => apiPost.mock.calls.filter(c => !(c[1] as Body).dry_run)
const dryPosts = () => apiPost.mock.calls.filter(c => (c[1] as Body).dry_run)

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
    serveTriage({
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
    // Before the person confirms, only the dry run is sent: it changes nothing.
    expect(realPosts()).toHaveLength(0)
    expect(dryPosts()).toHaveLength(1)
    expect(dryPosts()[0][1]).toEqual({ action: 'approve', objective_ids: [1, 3], dry_run: true })
    const dialog = q('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('nothing has been changed yet')
    expect(dialog?.textContent).toContain('Approve 2 cards?')
    expect(dialog?.textContent).toContain('#1 card 1')
    expect(dialog?.textContent).toContain('#3 card 3')

    await click(buttonByText('Approve 2'))
    expect(realPosts()).toHaveLength(1)
    expect(realPosts()[0][0]).toBe('/board-triage/batches')
    expect(realPosts()[0][1]).toEqual({ action: 'approve', objective_ids: [1, 3] })
    const result = q('[data-testid="triage-result"]')
    expect(result?.textContent).toContain('2 approved')
    expect(result?.textContent).toContain('#41')
  })

  it('cancelling the confirmation changes nothing (only the dry run was sent)', async () => {
    serveTriage(null)
    await mount()
    await click(q('[data-testid="triage-toggle"]'))
    await click(buttonByText('Select all 3'))
    expect(q('[data-testid="triage-count"]')?.textContent).toBe('3 of 3 selected')
    await click(q('[data-testid="triage-dismiss"]'))
    expect(q('[role="alertdialog"]')?.textContent).toContain('Dismiss 3 cards?')
    await click(buttonByText('Cancel'))
    expect(realPosts()).toHaveLength(0)
  })

  it('skipped cards are listed with the reason and stay selected', async () => {
    serveTriage({
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
    expect(realPosts()[0][1]).toEqual({ action: 'dismiss', objective_ids: [2, 3] })
    const result = q('[data-testid="triage-result"]')
    expect(result?.textContent).toContain('1 dismissed, 1 skipped')
    expect(result?.textContent).toContain('You do not have access to this objective')
    await click(buttonByText('Close'))
    // card 2 changed and left the selection; card 3 was skipped and stays selected.
    expect(q('[data-testid="triage-count"]')?.textContent).toBe('1 of 3 selected')
  })

  it('the confirmation shows the server dry run: which cards would change and which would be left alone, and why', async () => {
    serveTriage(
      { batch_id: 44, action: 'dismiss', requested: 3, ok: 2, skipped: 1, failed: 0, items: [] },
      { 2: 'An agent is still running on this card — it is not in Needs You.' },
    )
    await mount()
    await click(q('[data-testid="triage-toggle"]'))
    await click(buttonByText('Select all 3'))
    await click(q('[data-testid="triage-dismiss"]'))
    const dialog = q('[role="alertdialog"]')
    // The count is what the server would really change, not how many were ticked.
    expect(dialog?.textContent).toContain('Dismiss 2 cards?')
    expect(q('[data-testid="triage-preview-will"]')?.textContent).toContain('#1 card 1')
    expect(q('[data-testid="triage-preview-will"]')?.textContent).not.toContain('#2 card 2')
    expect(q('[data-testid="triage-preview-wont"]')?.textContent).toContain('#2 card 2: An agent is still running')
    expect(realPosts()).toHaveLength(0)
    await click(buttonByText('Dismiss 2'))
    expect(realPosts()).toHaveLength(1)
  })

  it('when the dry run says nothing would change, confirming sends no action', async () => {
    serveTriage(null, { 1: 'Not in Needs You (status done).', 2: 'Not in Needs You (status done).', 3: 'Not in Needs You (status done).' })
    await mount()
    await click(q('[data-testid="triage-toggle"]'))
    await click(buttonByText('Select all 3'))
    await click(q('[data-testid="triage-approve"]'))
    expect(q('[role="alertdialog"]')?.textContent).toContain('Nothing to approve')
    await click(buttonByText('OK'))
    expect(realPosts()).toHaveLength(0)
  })

  it('if the dry run cannot be loaded, the plain confirmation still works', async () => {
    apiPost.mockImplementation(async (_p: unknown, body: unknown) => {
      if ((body as Body).dry_run) throw new Error('offline')
      return { batch_id: 45, action: 'approve', requested: 3, ok: 3, skipped: 0, failed: 0, items: [] }
    })
    await mount()
    await click(q('[data-testid="triage-toggle"]'))
    await click(buttonByText('Select all 3'))
    await click(q('[data-testid="triage-approve"]'))
    expect(q('[role="alertdialog"]')?.textContent).toContain('Approve 3 cards?')
    await click(buttonByText('Approve 3'))
    expect(realPosts()).toHaveLength(1)
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
