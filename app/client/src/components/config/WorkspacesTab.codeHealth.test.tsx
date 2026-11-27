// @vitest-environment jsdom
/**
 * obj 901770 — an admin turns on the recurring code-health Job for a linked repo
 * from the repo's row menu (Settings → Workspaces → Repos & projects). It is off
 * by default, so the row shows no badge until it is switched on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WorkspaceRepo } from '@operationkit/shared'

const ACME = {
  slug: 'acme', name: 'Acme', short_label: 'AC', badge_color: null,
  vault_path: null, doc_read_roots: [], doc_write_roots: [], default_agent_pool: [],
  archived: false, sort_order: 0, created_at: '', updated_at: '',
}
const OFF = {
  repo_id: 7, enabled: false, cadence: 'weekly' as const, routine_id: null, paused: false,
  next_run_at: null, limits: { maxFiles: 8, maxLines: 200 }, unavailable: null,
}
const REPO: WorkspaceRepo = {
  id: 7, workspace: 'acme', name: 'widget', description: null, github: 'acme/widget', repo_path: null,
  stack: [], docs_path: 'docs/product', docs_enabled: false, created_at: '', code_health: OFF,
}

vi.mock('../../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    workspaces: [ACME], slugs: [ACME.slug], loading: false, refresh: vi.fn(() => Promise.resolve()),
    labelOf: (s: string) => s, shortOf: (s: string) => s, badgeOf: () => null, agentPoolOf: () => [],
  }),
}))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ slugs: [], loading: false, labelOf: (s: string) => s }) }))
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'admin' }, loading: false }),
}))
const confirmSpy = vi.fn((_o: { title: string; message: string }) => Promise.resolve(true))
vi.mock('../ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ui')>()),
  useConfirm: () => ({ confirm: (o: { title: string; message: string }) => confirmSpy(o), confirmDialog: null }),
}))

const put = vi.fn((_p: string, body: { enabled: boolean; cadence?: string }) =>
  Promise.resolve({ ...OFF, enabled: body.enabled, cadence: body.cadence ?? 'weekly', routine_id: 99, next_run_at: '2026-11-30T07:49:00.000Z' }))
vi.mock('../../lib/api', () => ({
  api: {
    get: (p: string) => {
      if (p === '/admin/workspaces') return Promise.resolve([ACME])
      if (p === '/workspaces-config') return Promise.resolve({ workspaces: {} })
      if (p === '/admin/workspaces/acme/repos') return Promise.resolve([REPO])
      return Promise.resolve([])
    },
    post: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    put: (p: string, b: { enabled: boolean; cadence?: string }) => put(p, b),
    del: vi.fn(() => Promise.resolve({})),
  },
}))

import { WorkspacesTab } from './WorkspacesTab'

describe('WorkspacesTab — code-health Job per repo (obj 901770)', () => {
  beforeEach(() => { put.mockClear(); confirmSpy.mockClear() })
  afterEach(async () => { const { cleanup } = await import('../../test/render'); await cleanup() })

  it('is off by default, and "Code health weekly" switches it on after a plain-language confirm', async () => {
    const { render, click } = await import('../../test/render')
    const { container } = await render(<WorkspacesTab />)
    const expand = Array.from(container.querySelectorAll('button[aria-expanded]')).find(b => b.textContent?.includes('Acme'))
    await click(expand ?? null)
    expect(container.textContent).toContain('widget')
    expect(container.textContent).not.toContain('code health ·')

    const trigger = container.querySelector('[aria-label="Actions for widget"]')
    await click(trigger)
    const menuId = trigger?.getAttribute('aria-controls')
    const menu = (menuId && document.getElementById(menuId)) || document
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const on = items.find(m => m.textContent?.trim() === 'Code health weekly')
    expect(on).toBeTruthy()
    await click(on!)

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const msg = confirmSpy.mock.calls[0][0].message
    expect(msg).toContain('acme/widget')
    expect(msg).toContain('at most one small pull request')
    expect(msg).toContain('Needs You')
    expect(msg).toContain('Nothing is deployed')
    expect(put).toHaveBeenCalledWith('/admin/workspaces/acme/repos/7/code-health', { enabled: true, cadence: 'weekly' })
    expect(container.textContent).toContain('code health · weekly')
  })
})
