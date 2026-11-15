import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { DelegationGrant, DelegationGrantsResponse } from '@operationkit/shared'
import { DelegationSection } from './DelegationSection'
import { chooseOption } from '../../test/render'

/* obj 900839 — "Approve on my behalf" on the bot's settings panel. The owner
   switches it on, picks one workspace, ticks actions and an expiry, and
   grants; each active grant has a one-click Revoke; switching off revokes
   them all. Anyone else sees it read-only, and a non-admin never even loads
   the grants. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS = [{ slug: 'growth', name: 'Growth' }, { slug: 'ops', name: 'Ops' }]
let grants: DelegationGrant[] = []
let canManage = true
let requests: { url: string; method: string; body: Record<string, unknown> | null }[] = []
let host: HTMLDivElement
let root: Root
let nextId = 1

function g(over: Partial<DelegationGrant>): DelegationGrant {
  return {
    id: nextId++, granting_user_id: 1, granted_by: 'owner', bot_name: 'Grok: CTO', agent_slug: 'acme-cto',
    workspace: 'growth', actions: ['merge'], created_at: '2026-11-14 12:00:00', expires_at: '2026-11-21 12:00:00',
    revoked_at: null, revoked_by: null, created_by: 'owner', state: 'active', ...over,
  }
}

function payload(): DelegationGrantsResponse {
  return { bot: { id: 'Grok: CTO', name: 'CTO' }, workspace_options: OPTIONS, grants, can_manage: canManage }
}

beforeEach(() => {
  grants = []
  canManage = true
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body })
    if (method === 'POST') grants = [g({ workspace: body.workspace, actions: body.actions, expires_at: body.expires_at }), ...grants]
    if (method === 'DELETE') {
      const id = Number(url.split('/').pop())
      grants = grants.map(x => (x.id === id ? { ...x, state: 'revoked', revoked_at: '2026-11-14 13:00:00', revoked_by: 'owner' } : x))
    }
    return new Response(JSON.stringify(payload()), { status: method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function render(isAdmin = true) {
  await act(async () => { root.render(<DelegationSection agent={{ slug: 'acme-cto', name: 'CTO' }} isAdmin={isAdmin} />) })
}
const button = (t: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t || b.getAttribute('aria-label') === t)
const theSwitch = () => host.querySelector<HTMLElement>('[role="switch"]')!
const fieldFor = (label: string) => {
  const l = [...host.querySelectorAll('label')].find(x => x.textContent?.trim() === label)
  return l ? host.querySelector<HTMLElement>(`#${l.htmlFor}`) : null
}
const checkbox = (label: string) => [...host.querySelectorAll('label')].find(x => x.textContent?.trim() === label)?.querySelector('input') as HTMLInputElement
async function click(el: Element) { await act(async () => { (el as HTMLElement).click() }) }

describe('DelegationSection', () => {
  it('is off with no grants; switching on opens the form; Grant POSTs workspace, ticked actions and an expiry', async () => {
    await render()
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/agent-chat/agents/acme-cto/delegations' })
    expect(host.textContent).toContain('Approve on my behalf')
    expect(host.textContent).toContain('Off')
    expect(theSwitch().getAttribute('aria-checked')).toBe('false')
    expect(button('Grant')).toBeUndefined()

    await click(theSwitch())
    expect(theSwitch().getAttribute('aria-checked')).toBe('true')
    expect(button('Grant')!.disabled).toBe(true) // nothing ticked yet
    await chooseOption(fieldFor('Workspace'), /\(ops\)$/)
    await click(checkbox('Merge'))
    await click(checkbox('Deploy'))
    await chooseOption(fieldFor('Expires after'), '30 days')
    const before = Date.now()
    await click(button('Grant')!)

    const post = requests.find(r => r.method === 'POST')!
    expect(post.url).toBe('/api/agent-chat/agents/acme-cto/delegations')
    expect(post.body).toMatchObject({ workspace: 'ops', actions: ['merge', 'deploy'] })
    const days = (new Date(String(post.body!.expires_at)).getTime() - before) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)
    expect(host.textContent).toContain('1 active')
    expect(host.textContent).toContain('CTO can now approve merge, deploy in ops on your behalf.')
  })

  it('lists active grants with a one-click Revoke, and ended grants under history', async () => {
    grants = [g({ id: 7, actions: ['merge', 'prod_migration', 'deploy'] }), g({ id: 3, state: 'expired', workspace: 'ops' })]
    await render()
    const row = host.querySelector('ul[aria-label="Active grants for CTO"] li')!
    expect(row.textContent).toContain('Grant #7 · Growth (growth)')
    expect(row.textContent).toContain('merge')
    expect(row.textContent).toContain('prod migration')
    expect(row.textContent).toContain('deploy')
    expect(host.textContent).toContain('Ended grants (1)')

    await click(button('Revoke grant #7')!)
    expect(requests.find(r => r.method === 'DELETE')?.url).toBe('/api/agent-chat/agents/acme-cto/delegations/7')
    expect(host.querySelector('ul[aria-label="Active grants for CTO"]')).toBeNull()
    expect(host.textContent).toContain('Revoked grant #7.')
    expect(host.textContent).toContain('Ended grants (2)')
  })

  it('switching off revokes every active grant', async () => {
    grants = [g({ id: 4 }), g({ id: 5, workspace: 'ops' })]
    await render()
    expect(theSwitch().getAttribute('aria-checked')).toBe('true')
    await click(theSwitch())
    expect(requests.filter(r => r.method === 'DELETE').map(r => r.url)).toEqual([
      '/api/agent-chat/agents/acme-cto/delegations/4',
      '/api/agent-chat/agents/acme-cto/delegations/5',
    ])
    expect(theSwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('an admin who is not signed in as the owner in the browser sees it read-only', async () => {
    canManage = false
    grants = [g({ id: 9 })]
    await render()
    expect(theSwitch().hasAttribute('disabled') || theSwitch().getAttribute('data-disabled') !== null).toBe(true)
    expect(button('Revoke grant #9')).toBeUndefined()
    expect(button('Add another grant')).toBeUndefined()
    expect(host.textContent).toContain("API keys and bots can't change them")
  })

  it('a non-admin never loads grants and is told only the owner can set this', async () => {
    await render(false)
    expect(requests).toHaveLength(0)
    expect(host.textContent).toContain('Only the owner can set this.')
    expect(host.querySelector('[role="switch"]')).toBeNull()
  })
})
