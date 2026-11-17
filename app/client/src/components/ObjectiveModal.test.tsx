// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { chooseOption, click, optionsOf, press } from '../test/render'

// Flush microtasks + a macrotask so api.get(...).then(setState) settles, then
// force any scheduled renders to commit. (The container ships a PRODUCTION React
// build, which omits `act`, so we drive commits with flushSync instead.)
async function flush() {
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  flushSync(() => {})
  await Promise.resolve()
}
import type { ModelRow, Objective } from '@operationkit/shared'
import { modelOptions } from '../lib/model-options'

// obj 700128 — prove ObjectiveModal is memoized so board-level WebSocket
// broadcasts (which re-render the board every few seconds while live sessions
// run) do NOT re-render the open modal. A broadcast-driven re-render reconciled
// ~36 attribute changes across the modal subtree, which dismissed any open
// native <select> in Chrome (the "bouncing/closing" bug). React.memo + the fact
// that all props from the board are referentially stable means an identical-
// props parent re-render skips the modal entirely — while a changed `objective`
// prop (e.g. Edit a different card) still re-renders it.

// We count ObjectiveModalImpl renders by spying on useAuth, which it calls
// unconditionally at the top of every render. With everything else mocked,
// ObjectiveModalImpl is the only caller, so call-count == render-count.
// Mutable so a test can supply org subfolders; default is "no projects yet".
const { PROJECTS } = vi.hoisted(() => ({ PROJECTS: [] as Array<Record<string, unknown>> }))
// obj 900863: registry rows GET /models returns; empty unless a test fills it.
const { MODEL_ROWS } = vi.hoisted(() => ({ MODEL_ROWS: [] as Array<Record<string, unknown>> }))

const { useAuthSpy } = vi.hoisted(() => ({
  useAuthSpy: vi.fn(() => ({ user: { id: 1, role: 'admin', username: 'operator' } })),
}))

vi.mock('../context/AuthContext', () => ({ useAuth: () => useAuthSpy() }))

vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    slugs: ['example', 'example-project'],
    labelOf: (s: string) => s === 'example-project' ? 'Example Project' : s,
    agentPoolOf: () => [],
  }),
}))

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url === '/models') return Promise.resolve({ models: MODEL_ROWS, default: MODEL_ROWS.length ? 'claude-opus-5-5' : '' })
      if (url === '/admin/users') return Promise.resolve([])
      if (url === '/workspaces-config') return Promise.resolve({ workspaces: {} })
      // obj 708826 — the Project control now reads the projects table.
      if (url.startsWith('/projects')) return Promise.resolve(PROJECTS)
      return Promise.resolve([])
    }),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve()),
  },
}))

// Pass children straight through so the modal body renders into the DOM.
// Keep the real primitives (Button, IconButton, Input, …); stub only these.
vi.mock('./ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  useConfirm: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))

import { ObjectiveModal } from './ObjectiveModal'
import { api } from '../lib/api'

// React 19 overrides the value setter on controlled inputs; go through the
// prototype descriptor so the synthetic change event carries the new value.
function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el)
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
}
// ui/Select triggers (button[role="combobox"]) carry an aria-label.
const selectNamed = (root: ParentNode, name: string) =>
  root.querySelector<HTMLElement>(`button[role="combobox"][aria-label="${name}"]`)

// Module-level stable prop identities — these must NEVER change between renders,
// mirroring the board's useCallback-stabilized handlers. If they changed,
// memo's shallow compare would (correctly) re-render and the test would be moot.
const onClose = vi.fn()
const onCreate = vi.fn((_data: unknown) => Promise.resolve({} as Objective))
const onUpdate = vi.fn(() => Promise.resolve({} as Objective))
const onDelete = vi.fn(() => Promise.resolve())

let forceParentRender: () => void = () => {}

function Harness({ objective, workspace = 'example' }: { objective: Objective | null; workspace?: string }) {
  const [, setTick] = useState(0)
  forceParentRender = () => setTick(t => t + 1)
  return (
    <ObjectiveModal
      objective={objective}
      workspace={workspace}
      onClose={onClose}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onDelete={onDelete}
    />
  )
}

const SAMPLE_OBJECTIVE = { id: 42, title: 'Edit me', workspace: 'example' } as unknown as Objective

// obj 901200: the New card dialog keeps its draft in localStorage. Start every
// test from an empty store so one test's typed title never seeds the next.
beforeEach(() => { localStorage.clear() })

describe('ObjectiveModal — memoized against parent re-renders (obj 700128)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    useAuthSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  it('does NOT re-render when the parent re-renders with identical props', async () => {
    flushSync(() => root.render(<Harness objective={null} />))
    // Let mount-time async effects (api.get .then setState) settle so their
    // renders are already counted before we measure the delta.
    await flush()

    const before = useAuthSpy.mock.calls.length
    expect(before).toBeGreaterThan(0) // it did render at least once on mount

    // Force a parent re-render with byte-for-byte identical ObjectiveModal props.
    flushSync(() => forceParentRender())
    await flush()

    const after = useAuthSpy.mock.calls.length
    expect(after - before).toBe(0) // memo skipped it — zero extra renders
  })

  it('DOES re-render when the `objective` prop changes (Edit a different card)', async () => {
    flushSync(() => root.render(<Harness objective={null} />))
    await flush()

    const before = useAuthSpy.mock.calls.length

    // Re-render the tree with a different objective — memo must NOT block this.
    flushSync(() => root.render(<Harness objective={SAMPLE_OBJECTIVE} />))
    await flush()

    const after = useAuthSpy.mock.calls.length
    expect(after).toBeGreaterThan(before)
    // And the new objective's title is rendered (it really re-rendered with new props).
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Edit card')
  })
})

// ── obj 708877: model + delegate + assign + files restored to create form ─────
// The form must collect TITLE, DESCRIPTION, ORGANIZATION, PROJECT,
// MODEL, DELEGATOR MODE (admin), ASSIGN TO (admin), and FILES.
describe('ObjectiveModal — create form fields (obj 708877)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    onCreate.mockClear()
    ;(api.get as unknown as { mockClear: () => void }).mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  async function mount(objective: Objective | null, workspace?: string) {
    flushSync(() => root.render(<Harness objective={objective} workspace={workspace} />))
    await flush()
    return container.querySelector('[role="dialog"]') as HTMLElement
  }

  it('renders two textareas (title, description)', async () => {
    const dialog = await mount(null)
    expect(dialog.querySelectorAll('textarea')).toHaveLength(2)
  })

  it('renders workspace and project selects (labelled Workspace, not Organization — obj 900758)', async () => {
    const dialog = await mount(null)
    const labels = [...dialog.querySelectorAll('label')].map(l => l.textContent?.trim())
    expect(labels).toContain('Workspace')
    expect(labels).not.toContain('Organization')
    expect(labels).toContain('Project')
  })

  it('has a file input for attachments', async () => {
    const dialog = await mount(null)
    expect(dialog.querySelectorAll('input[type="file"]')).toHaveLength(1)
  })

  it('has a delegator-mode checkbox for admins', async () => {
    // useAuthSpy defaults to admin role
    const dialog = await mount(null)
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
    const label = dialog.querySelector('label[for="delegate-mode"]')
    expect(label?.textContent?.toLowerCase()).toContain('delegator')
  })

  it('does NOT show delegator checkbox for non-admins', async () => {
    // mockImplementation (not Once) so every re-render triggered by async effects
    // also sees the member role — Once only covers the first call and re-renders
    // revert to the default admin mock, incorrectly re-rendering the checkbox.
    useAuthSpy.mockImplementation(() => ({ user: { id: 2, role: 'member', username: 'casey' } }))
    try {
      const dialog = await mount(null)
      expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    } finally {
      useAuthSpy.mockImplementation(() => ({ user: { id: 1, role: 'admin', username: 'operator' } }))
    }
  })

  it('does not show the model select when registry returns no models', async () => {
    const dialog = await mount(null)
    const labels = [...dialog.querySelectorAll('label')].map(l => l.textContent?.trim())
    // models is empty (default mock), so the select is hidden
    expect(labels).not.toContain('Model')
  })

  // obj 708826 — single Project control bound to project_id
  it('has a single Project control from the projects table', async () => {
    const dialog = await mount(null)
    const labels = [...dialog.querySelectorAll('label')].map(l => l.textContent?.trim())
    expect(labels.filter(l => l === 'Project')).toHaveLength(1)
    expect(labels).not.toContain('Repository')
    const urls = (api.get as unknown as { mock: { calls: string[][] } }).mock.calls.map(c => c[0])
    expect(urls).not.toContain('/workspaces-config')
    expect(urls.some(u => u.startsWith('/projects?workspace='))).toBe(true)
  })

  it('submits project_id (not the repo-link project) when a project is selected', async () => {
    PROJECTS.splice(0, PROJECTS.length,
      { id: 7, workspace: 'example', name: 'Designer', description: null, color: null, sort_order: 0, archived: false, created_at: '', updated_at: '' },
    )
    try {
      const dialog = await mount(null)
      const projectSelect = selectNamed(dialog, 'Project')!
      expect(projectSelect).toBeTruthy()
      expect(projectSelect.textContent).toContain('No project')

      const title = dialog.querySelector('textarea') as HTMLTextAreaElement
      setNativeValue(title, 'Pull the MLS feed')
      flushSync(() => title.dispatchEvent(new Event('input', { bubbles: true })))
      await chooseOption(projectSelect, 'Designer')

      const form = dialog.querySelector('form') as HTMLFormElement
      flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
      await flush()

      expect(onCreate).toHaveBeenCalledTimes(1)
      const payload = onCreate.mock.calls[0][0] as Record<string, unknown>
      expect(payload.project_id).toBe(7)
      expect(payload).not.toHaveProperty('project')
    } finally {
      PROJECTS.length = 0
    }
  })

  it('edit mode shows all fields including title and description', async () => {
    const dialog = await mount(SAMPLE_OBJECTIVE)
    expect(dialog.textContent).toContain('Edit card')
    expect(dialog.querySelectorAll('textarea')).toHaveLength(2)
  })

  it('does not default Workspace to Example on the All-workspaces board', async () => {
    const dialog = await mount(null, 'all')
    const orgSelect = selectNamed(dialog, 'Workspace')!
    expect(orgSelect).toBeTruthy()
    // Nothing picked: the trigger shows the disabled "Select workspace…" row.
    expect(orgSelect.textContent).toContain('Select workspace…')
    await click(orgSelect)
    const optionTexts = optionsOf(orgSelect).map(o => o.textContent?.trim())
    expect(optionTexts).toContain('Select workspace…')
    expect(optionTexts).toContain('Example Project')
    await press('Escape')
  })

  it('refuses to create from All workspaces until a workspace is picked', async () => {
    const dialog = await mount(null, 'all')
    const title = dialog.querySelector('textarea') as HTMLTextAreaElement
    setNativeValue(title, 'MFG delete messages')
    flushSync(() => title.dispatchEvent(new Event('input', { bubbles: true })))

    const form = dialog.querySelector('form') as HTMLFormElement
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()

    expect(onCreate).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain('Pick a workspace')
  })

  it('creates into Example Project when that org is picked from All', async () => {
    const dialog = await mount(null, 'all')
    const title = dialog.querySelector('textarea') as HTMLTextAreaElement
    setNativeValue(title, 'MFG delete messages')
    flushSync(() => title.dispatchEvent(new Event('input', { bubbles: true })))

    await chooseOption(selectNamed(dialog, 'Workspace'), 'Example Project')


    const form = dialog.querySelector('form') as HTMLFormElement
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()

    expect(onCreate).toHaveBeenCalledTimes(1)
    const payload = onCreate.mock.calls[0][0] as Record<string, unknown>
    expect(payload.workspace).toBe('example-project')
    expect(payload.title).toBe('MFG delete messages')
  })
})

// ── multi-owner picker (obj 711023) ──────────────────────────────────────────
describe('ObjectiveModal — multi-owner picker (obj 711023)', () => {
  let container: HTMLElement
  let root: Root

  const USERS = [
    { id: 10, username: 'alice' },
    { id: 20, username: 'bob' },
    { id: 30, username: 'carol' },
  ]

  beforeEach(() => {
    onCreate.mockClear()
    onUpdate.mockClear()
    ;(api.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/models') return Promise.resolve({ models: [], default: '' })
      if (url === '/admin/users') return Promise.resolve(USERS)
      if (url.startsWith('/projects')) return Promise.resolve([])
      return Promise.resolve([])
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  async function mount(objective: Objective | null, workspace = 'example', waitForPicker = true) {
    flushSync(() => root.render(<Harness objective={objective} workspace={workspace} />))
    await flush()
    // The picker only renders once GET /admin/users has resolved AND React has
    // committed setUsers. That commit runs on a scheduler task (default lane),
    // not inside flush()'s single setTimeout(0) — on a loaded CI runner it can
    // land a tick later, which failed all three tests below at once on the
    // public-tree leg (obj 900869, run 43679009686). Wait for it, bounded.
    const deadline = Date.now() + 2000
    while (waitForPicker && !selectNamed(container, 'Add owner') && Date.now() < deadline) await flush()
    return container.querySelector('[role="dialog"]') as HTMLElement
  }

  it('create: selecting 2 owners sends assigned_user_ids as ordered array', async () => {
    const dialog = await mount(null)

    // Pick alice then bob from the add-owner select
    const ownerSelect = selectNamed(dialog, 'Add owner')
    expect(ownerSelect).toBeTruthy()

    await chooseOption(ownerSelect, 'alice')
    await flush()

    // After selecting alice, the dropdown now lists bob (alice is in chips, hidden from options)
    const ownerSelect2 = selectNamed(dialog, 'Add owner')
    expect(ownerSelect2).toBeTruthy()
    await click(ownerSelect2)
    expect(optionsOf(ownerSelect2!).map(o => o.textContent?.trim())).not.toContain('alice')
    await press('Escape')
    await chooseOption(ownerSelect2, 'bob')
    await flush()

    // Fill in title so submit passes validation
    const title = dialog.querySelector('textarea') as HTMLTextAreaElement
    setNativeValue(title, 'Multi-owner objective')
    flushSync(() => title.dispatchEvent(new Event('input', { bubbles: true })))

    const form = dialog.querySelector('form') as HTMLFormElement
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()

    expect(onCreate).toHaveBeenCalledTimes(1)
    const payload = onCreate.mock.calls[0][0] as Record<string, unknown>
    expect(payload.assigned_user_ids).toEqual([10, 20])
    expect(payload).not.toHaveProperty('assigned_user_id')
  })

  it('edit: seeds from assigned_user_ids on the objective', async () => {
    const obj = {
      id: 99,
      title: 'Pre-assigned obj',
      workspace: 'example',
      assigned_user_ids: [10, 20],
      assigned_user_id: 10,
    } as unknown as Objective

    const dialog = await mount(obj)

    // Both alice and bob should appear as chips
    const chipText = dialog.textContent ?? ''
    expect(chipText).toContain('alice')
    expect(chipText).toContain('bob')
    // First chip should show "primary" badge
    const chips = [...dialog.querySelectorAll('[class*="rounded-full"]')]
    expect(chips[0].textContent).toContain('primary')
  })

  it('edit: clearing all owners sends an empty array', async () => {
    const obj = {
      id: 99,
      title: 'Pre-assigned obj',
      workspace: 'example',
      assigned_user_ids: [10],
      assigned_user_id: 10,
    } as unknown as Objective

    const dialog = await mount(obj)

    // Remove alice's chip
    const removeBtn = dialog.querySelector('button[aria-label="Remove alice"]') as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    flushSync(() => removeBtn.click())
    await flush()

    const form = dialog.querySelector('form') as HTMLFormElement
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()

    expect(onUpdate).toHaveBeenCalledTimes(1)
    const payload = (onUpdate.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(payload.assigned_user_ids).toEqual([])
  })

  it('non-admin: sends undefined for assignment (no regression)', async () => {
    useAuthSpy.mockImplementation(() => ({ user: { id: 2, role: 'member', username: 'casey' } }))
    try {
      const dialog = await mount(null, 'example', false) // members get no picker

      const title = dialog.querySelector('textarea') as HTMLTextAreaElement
      setNativeValue(title, 'Member obj')
      flushSync(() => title.dispatchEvent(new Event('input', { bubbles: true })))

      const form = dialog.querySelector('form') as HTMLFormElement
      flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
      await flush()

      expect(onCreate).toHaveBeenCalledTimes(1)
      const payload = onCreate.mock.calls[0][0] as Record<string, unknown>
      expect(payload.assigned_user_ids).toBeUndefined()
    } finally {
      useAuthSpy.mockImplementation(() => ({ user: { id: 1, role: 'admin', username: 'operator' } }))
    }
  })
})

describe('ObjectiveModal model picker uses the shared model list (obj 900863)', () => {
  it('lists the registry rows in the same format as Settings → Models and the bot page', async () => {
    const rows: ModelRow[] = [
      { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', engine: 'claude', enabled: true, is_default: false, is_planner: false, sort_order: 1 },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', engine: 'claude', enabled: true, is_default: true, is_planner: true, sort_order: 4 },
      { id: 'grok-4', label: 'Grok 4', engine: 'grok', enabled: true, is_default: false, is_planner: false, sort_order: 40 },
    ]
    MODEL_ROWS.splice(0, MODEL_ROWS.length, ...(rows as unknown as Array<Record<string, unknown>>))
    ;(api.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/models') return Promise.resolve({ models: MODEL_ROWS, default: 'claude-opus-5-5' })
      return Promise.resolve([])
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      flushSync(() => root.render(<Harness objective={null} />))
      await flush()
      const trigger = selectNamed(container, 'Model')!
      expect(trigger.textContent).toContain('Claude Opus 5.5 (claude-opus-5-5)')
      await click(trigger)
      await flush()
      expect(optionsOf(trigger).map(o => o.textContent!.trim())).toEqual(modelOptions(rows).map(o => o.label))
    } finally {
      MODEL_ROWS.splice(0, MODEL_ROWS.length)
      flushSync(() => root.unmount())
      container.remove()
    }
  })
})

// ── obj 901200: a typed new-card draft is never lost silently on close ────────
describe('ObjectiveModal — new-card draft survives closing (obj 901200)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    onCreate.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  async function mount(objective: Objective | null) {
    flushSync(() => root.render(<Harness objective={objective} />))
    await flush()
    return container.querySelector('[role="dialog"]') as HTMLElement
  }
  function unmount() { flushSync(() => root.render(<></>)) }
  function type(el: HTMLTextAreaElement, value: string) {
    setNativeValue(el, value)
    flushSync(() => el.dispatchEvent(new Event('input', { bubbles: true })))
  }
  const fields = (d: HTMLElement) => [...d.querySelectorAll('textarea')] as HTMLTextAreaElement[]

  it('restores the title and description after the dialog closes and reopens', async () => {
    let dialog = await mount(null)
    const [title, desc] = fields(dialog)
    type(title, 'Draft title that should not be lost')
    type(desc, 'Some detail')
    unmount() // Escape / click outside / X / Cancel all unmount the dialog

    dialog = await mount(null)
    const [title2, desc2] = fields(dialog)
    expect(title2.value).toBe('Draft title that should not be lost')
    expect(desc2.value).toBe('Some detail')
    expect(dialog.querySelector('[data-testid="new-card-draft-restored"]')).toBeTruthy()
  })

  it('forgets the draft once the card is created', async () => {
    let dialog = await mount(null)
    type(fields(dialog)[0], 'Ship it')
    const form = dialog.querySelector('form') as HTMLFormElement
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(onCreate).toHaveBeenCalledTimes(1)
    unmount()

    dialog = await mount(null)
    expect(fields(dialog)[0].value).toBe('')
    expect(dialog.querySelector('[data-testid="new-card-draft-restored"]')).toBeNull()
  })

  it('keeps the draft when the create is refused', async () => {
    onCreate.mockImplementationOnce(() => Promise.reject(new Error('boom')))
    let dialog = await mount(null)
    type(fields(dialog)[0], 'Refused card')
    const form = dialog.querySelector('form') as HTMLFormElement
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    unmount()

    dialog = await mount(null)
    expect(fields(dialog)[0].value).toBe('Refused card')
  })

  it('"Discard draft" empties the fields and forgets the draft', async () => {
    let dialog = await mount(null)
    expect([...dialog.querySelectorAll('button')].some(b => b.textContent === 'Discard draft')).toBe(false)
    type(fields(dialog)[0], 'Throw me away')
    const discard = [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Discard draft')!
    expect(discard).toBeTruthy()
    flushSync(() => discard.click())
    expect(fields(dialog)[0].value).toBe('')
    unmount()

    dialog = await mount(null)
    expect(fields(dialog)[0].value).toBe('')
  })

  it('edit mode neither reads nor writes the new-card draft', async () => {
    let dialog = await mount(null)
    type(fields(dialog)[0], 'New card draft')
    unmount()

    dialog = await mount(SAMPLE_OBJECTIVE)
    expect(fields(dialog)[0].value).toBe('Edit me')
    type(fields(dialog)[0], 'Edited title')
    expect([...dialog.querySelectorAll('button')].some(b => b.textContent === 'Discard draft')).toBe(false)
    unmount()

    dialog = await mount(null)
    expect(fields(dialog)[0].value).toBe('New card draft')
  })
})
