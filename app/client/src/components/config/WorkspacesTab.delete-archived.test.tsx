// @vitest-environment jsdom
/**
 * obj 900870 — the owner can DELETE an archived workspace so it leaves the
 * archived list. Delete sits only on archived rows, needs an explicit confirm
 * in the shared danger dialog, and Cancel deletes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, click, render } from '../../test/render'

// Fictional orgs — see the note in OrgSwitcher.test.tsx.
const ACTIVE = {
  slug: 'acme', name: 'Acme', short_label: 'AC', badge_color: null,
  vault_path: null, doc_read_roots: [], doc_write_roots: [], default_agent_pool: [],
  archived: false, sort_order: 0, created_at: '', updated_at: '',
}
const ARCHIVED = { ...ACTIVE, slug: 'northwind', name: 'Northwind', short_label: 'NW', archived: true, sort_order: 1 }

let adminList: unknown[] = [ACTIVE, ARCHIVED]
const refreshWorkspaces = vi.fn(() => Promise.resolve())

vi.mock('../../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    workspaces: [ACTIVE], slugs: [ACTIVE.slug], loading: false,
    refresh: refreshWorkspaces,
    labelOf: (s: string) => s, shortOf: (s: string) => s,
    badgeOf: () => null, agentPoolOf: () => [],
  }),
}))
vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ slugs: [], loading: false, labelOf: (s: string) => s }),
}))
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'admin' }, loading: false }),
}))

const post = vi.fn((path: string, _body?: unknown) => {
  if (path === '/admin/workspaces/northwind/delete') adminList = [ACTIVE]
  return Promise.resolve({ ok: true })
})
const del = vi.fn((_path: string) => Promise.resolve({}))
vi.mock('../../lib/api', () => ({
  api: {
    get: (p: string) => {
      if (p === '/admin/workspaces') return Promise.resolve(adminList)
      if (p === '/workspaces-config') return Promise.resolve({ workspaces: {} })
      return Promise.resolve([])
    },
    post: (p: string, b: unknown) => post(p, b),
    patch: vi.fn(() => Promise.resolve({})),
    del: (p: string) => del(p),
  },
}))

import { WorkspacesTab } from './WorkspacesTab'

async function settle() {
  const { act } = await import('react')
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const dialogButton = (name: string) =>
  Array.from(dialog()!.querySelectorAll('button')).find(b => b.textContent === name)!

describe('WorkspacesTab — delete an archived workspace (obj 900870)', () => {
  beforeEach(() => {
    adminList = [ACTIVE, ARCHIVED]
    post.mockClear(); del.mockClear(); refreshWorkspaces.mockClear()
  })
  afterEach(cleanup)

  it('offers Delete only on archived rows, never on an active workspace', async () => {
    const { container } = await render(<WorkspacesTab />)
    await settle()
    const archived = container.querySelector('[data-testid="archived-organizations"]')!
    const active = container.querySelector('[data-testid="active-organizations"]')!
    expect(archived.querySelector('[data-testid="delete-archived-northwind"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="delete-archived-acme"]')).toBeNull()
    expect(active.textContent).not.toContain('Delete')
  })

  it('confirm dialog states it is a soft delete and how to recover; Cancel deletes nothing', async () => {
    const { container } = await render(<WorkspacesTab />)
    await settle()
    await click(container.querySelector('[data-testid="delete-archived-northwind"]'))
    await settle()
    const d = dialog()!
    expect(d).toBeTruthy()
    expect(d.textContent).toContain('Delete archived workspace?')
    expect(d.textContent).toContain('Nothing is permanently deleted')
    expect(d.textContent).toContain('no other workspace or Shared secret is touched')
    expect(d.textContent).toContain('/api/admin/workspaces/northwind/undelete')
    await click(dialogButton('Cancel'))
    await settle()
    expect(post).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="archived-organizations"]')!.textContent).toContain('Northwind')
  })

  it('confirming deletes it through the admin route and it leaves the archived list', async () => {
    const { container } = await render(<WorkspacesTab />)
    await settle()
    await click(container.querySelector('[data-testid="delete-archived-northwind"]'))
    await settle()
    await click(dialogButton('Delete workspace'))
    await settle()
    expect(post).toHaveBeenCalledWith('/admin/workspaces/northwind/delete', { confirm: 'northwind' })
    expect(del).not.toHaveBeenCalled()
    expect(refreshWorkspaces).toHaveBeenCalled()
    // Only archived org gone → the whole archived group disappears.
    expect(container.querySelector('[data-testid="archived-organizations"]')).toBeNull()
    expect(container.textContent).toContain('Acme')
  })
})
