// @vitest-environment jsdom
/**
 * obj 900023 — Settings → Users must say, per person, whether Cloudflare
 * Access will actually let them in.
 *
 * Behind Cloudflare Access the app is the SECOND door. An admin who adds a
 * teammate here has historically had no way to know that the person will hit
 * Cloudflare's "That account does not have access" page instead of the app —
 * the Users tab looked identical either way. `GET /api/admin/users` now carries
 * `cloudflare_access` per user and this tab renders it as a badge.
 *
 * The third state matters as much as the first two: an install that is NOT
 * behind Cloudflare Access has no second door, so it must show NO badge rather
 * than a misleading "blocked".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

const BASE = { role: 'member' as const, workspaces: [], created_at: '' }
const ALLOWED = {
  ...BASE, id: 1, username: 'ada', email: 'ada@example.com',
  cloudflare_access: { status: 'can_sign_in', detail: 'allowed_directly' },
}
const BLOCKED = {
  ...BASE, id: 2, username: 'grace', email: 'grace@elsewhere.com',
  cloudflare_access: { status: 'blocked', detail: 'not_allowed' },
}
const NO_ACCESS_INSTALL = {
  ...BASE, id: 3, username: 'alan', email: 'alan@example.com',
  cloudflare_access: { status: 'not_applicable', detail: 'access_not_configured' },
}
const UNCONFIRMED = {
  ...BASE, id: 4, username: 'edsger', email: 'edsger@example.com',
  cloudflare_access: { status: 'blocked', detail: 'sync_not_configured' },
}

let users: unknown[] = []
type Sync = { applies: boolean; configured: boolean; source: 'settings' | 'env' | null; updated_at: string | null; health: string | null }
const NOT_SET_UP: Sync = { applies: true, configured: false, source: null, updated_at: null, health: null }
let sync: Sync = NOT_SET_UP
const apiCalls: Array<{ method: string; path: string; body?: unknown }> = []

vi.mock('../../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    workspaces: [], slugs: [], loading: false, refresh: () => Promise.resolve(),
    labelOf: (s: string) => s, shortOf: (s: string) => s, badgeOf: () => null, agentPoolOf: () => [],
  }),
}))

vi.mock('../../lib/api', () => ({
  api: {
    get: (path: string) => (path === '/admin/users' ? Promise.resolve(users)
      : path === '/admin/users/cloudflare-sync' ? Promise.resolve(sync) : Promise.resolve([])),
    post: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    // The server answers a save with the STATE only — never the token.
    put: vi.fn((path: string, body?: unknown) => {
      apiCalls.push({ method: 'PUT', path, body })
      sync = { applies: true, configured: true, source: 'settings', updated_at: '2026-11-16 15:00:00', health: 'ok' }
      return Promise.resolve(sync)
    }),
    del: vi.fn((path: string) => {
      apiCalls.push({ method: 'DELETE', path })
      if (path === '/admin/users/cloudflare-sync') { sync = NOT_SET_UP; return Promise.resolve(sync) }
      return Promise.resolve({})
    }),
  },
}))

import { MemoryRouter } from 'react-router-dom'
import { UsersTab } from './UsersTab'

describe('UsersTab — Cloudflare Access status (obj 900023)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    sync = NOT_SET_UP
    apiCalls.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  async function mount(list: unknown[]) {
    users = list
    flushSync(() => root.render(<MemoryRouter><UsersTab /></MemoryRouter>))
    await flush()
    return container
  }

  it('shows "can sign in" for someone the Access policy allows', async () => {
    const el = await mount([ALLOWED])
    expect(el.textContent).toContain('can sign in')
    expect(el.textContent).not.toContain('blocked at Cloudflare')
  })

  it('shows "blocked at Cloudflare" for someone it does not', async () => {
    const el = await mount([BLOCKED])
    expect(el.textContent).toContain('blocked at Cloudflare')
    expect(el.textContent).not.toContain('can sign in')
  })

  it('shows each person their own status in a mixed list', async () => {
    const el = await mount([ALLOWED, BLOCKED])
    expect(el.textContent).toContain('can sign in')
    expect(el.textContent).toContain('blocked at Cloudflare')
  })

  it('shows no badge at all when the install is not behind Cloudflare Access', async () => {
    const el = await mount([NO_ACCESS_INSTALL])
    expect(el.textContent).toContain('alan')
    expect(el.textContent).not.toContain('can sign in')
    expect(el.textContent).not.toContain('blocked at Cloudflare')
  })

  it('explains an unconfirmed status instead of showing an error', async () => {
    const el = await mount([UNCONFIRMED])
    expect(el.textContent).toContain('blocked at Cloudflare')
    const badge = [...el.querySelectorAll('[title]')].find(n => n.textContent?.includes('blocked at Cloudflare'))
    expect(badge?.getAttribute('title')).toContain('Cloudflare sync is not set up')
  })

  it('renders without a badge when the server sent no status at all', async () => {
    const el = await mount([{ ...BASE, id: 9, username: 'legacy', email: 'legacy@example.com' }])
    expect(el.textContent).toContain('legacy')
    expect(el.textContent).not.toContain('blocked at Cloudflare')
  })

  describe('token without Access rights (obj 900023)', () => {
  it('shows a visible note, not an error, when the Cloudflare token lacks Access-edit rights', async () => {
    sync = { applies: true, configured: true, source: 'settings', updated_at: '2026-11-16 15:00:00', health: 'forbidden' }
    const el = await mount([{ ...BASE, id: 11, username: 'outsider', email: 'pat@other.org',
      cloudflare_access: { status: 'blocked', detail: 'forbidden' } }])
    expect(el.textContent).toContain('Cloudflare sync is paused')
    expect(el.textContent).toContain('not allowed to edit Access policies')
    expect(el.textContent).toContain('Access: Apps and Policies → Edit')
    expect(el.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows no sync note when the token works', async () => {
    sync = { applies: true, configured: true, source: 'settings', updated_at: '2026-11-16 15:00:00', health: 'ok' }
    const el = await mount([{ ...BASE, id: 12, username: 'ok', email: 'ok@example.com',
      cloudflare_access: { status: 'can_sign_in', detail: 'allowed_directly' } }])
    expect(el.textContent).not.toContain('Cloudflare sync is paused')
  })
})

  describe('Cloudflare sign-in sync token (obj 900023)', () => {
    const SECRET = ['pasted', 'cloudflare', 'token', 'value', '1234567890'].join('_')

    it('says "Cloudflare sync not set up" and offers the token field when no token is set', async () => {
      const el = await mount([BLOCKED])
      expect(el.querySelector('[data-testid="cf-sync-not-set-up"]')?.textContent).toContain('Cloudflare sync not set up')
      const input = el.querySelector<HTMLInputElement>('#cf-access-sync-token')
      expect(input?.type).toBe('password')
      expect(input?.value).toBe('')
    })

    it('sends the token once on Save, clears the field, and shows only the state', async () => {
      const el = await mount([BLOCKED])
      const input = el.querySelector<HTMLInputElement>('#cf-access-sync-token')!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      flushSync(() => { setter.call(input, SECRET); input.dispatchEvent(new Event('input', { bubbles: true })) })
      await flush()
      const form = input.closest('form')!
      flushSync(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
      await flush()
      expect(apiCalls).toEqual([{ method: 'PUT', path: '/admin/users/cloudflare-sync', body: { token: SECRET } }])
      expect(el.querySelector<HTMLInputElement>('#cf-access-sync-token')!.value).toBe('')
      expect(el.textContent).toContain('Cloudflare sync is on')
      expect(el.innerHTML).not.toContain(SECRET)
    })

    it('a saved token is never shown: the field stays empty and only offers Replace / Remove', async () => {
      sync = { applies: true, configured: true, source: 'settings', updated_at: '2026-11-16 15:00:00', health: 'ok' }
      const el = await mount([ALLOWED])
      expect(el.querySelector<HTMLInputElement>('#cf-access-sync-token')!.value).toBe('')
      expect(el.textContent).toContain('Replace the Cloudflare API token')
      const remove = [...el.querySelectorAll('button')].find(b => b.textContent === 'Remove token')!
      flushSync(() => remove.click())
      await flush()
      expect(apiCalls).toEqual([{ method: 'DELETE', path: '/admin/users/cloudflare-sync' }])
      expect(el.textContent).toContain('Cloudflare sync not set up')
    })

    it('an installer-set (env) token shows as on, with no Remove button (it is not the UI\'s to remove)', async () => {
      sync = { applies: true, configured: true, source: 'env', updated_at: null, health: 'ok' }
      const el = await mount([ALLOWED])
      expect(el.textContent).toContain('set by the installer')
      expect([...el.querySelectorAll('button')].some(b => b.textContent === 'Remove token')).toBe(false)
    })

    it('shows no sync card at all on an install that is not behind Cloudflare Access', async () => {
      sync = { applies: false, configured: false, source: null, updated_at: null, health: null }
      const el = await mount([NO_ACCESS_INSTALL])
      expect(el.querySelector('[data-testid="cf-access-sync-card"]')).toBeNull()
      expect(el.textContent).not.toContain('Cloudflare sync not set up')
    })
  })
})
