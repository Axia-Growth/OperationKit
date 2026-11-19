import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { RepoRightsSection } from './RepoRightsSection'
import type { ChatAgentInfo } from './types'

/* obj 901492 — GitHub repo rights on the Dev bot's settings panel: off by default
   (no repo listed), an admin adds one repo at a time (PUT {repo, enabled:true})
   and switches one off (PUT {repo, enabled:false}); a non-admin sees it
   read-only; no other bot shows it at all. The credential is named, never shown. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DEV = { slug: 'operation-kit-dev', name: 'Operation Kit Dev' } as unknown as ChatAgentInfo
const OTHER = { slug: 'example-cto', name: 'Example CTO' } as unknown as ChatAgentInfo

let host: HTMLDivElement
let root: Root
let repos: string[] = []
let stored = false
let requests: { url: string; method: string; body: { repo?: string; enabled?: boolean } | null }[] = []

const payload = () => ({
  repo_rights: {
    slug: 'operation-kit-dev', eligible: true, operator_tools_on: true,
    repos: repos.map(repo => ({ repo, granted_by: 1, granted_by_username: 'operator', created_at: '2026-11-19 04:00:00' })),
    credential_name: 'DEV_BOT_GITHUB_TOKEN', credential_stored: stored,
  },
})

beforeEach(() => {
  repos = []
  stored = false
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, method: init?.method ?? 'GET', body })
    if (init?.method === 'PUT') repos = body.enabled ? [...repos, String(body.repo).toLowerCase()] : repos.filter(r => r !== body.repo)
    return new Response(JSON.stringify(payload()), { status: 200, headers: { 'content-type': 'application/json' } })
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

async function render(agent: ChatAgentInfo, isAdmin: boolean) {
  await act(async () => { root.render(<RepoRightsSection agent={agent} isAdmin={isAdmin} />) })
  await act(async () => { await Promise.resolve() })
}

function type(value: string) {
  const input = host.querySelector<HTMLInputElement>('input')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!

describe('RepoRightsSection', () => {
  it('is off by default: no repo listed, and it says where the GitHub login comes from', async () => {
    await render(DEV, true)
    expect(requests[0]).toMatchObject({ url: '/api/agent-chat/agents/operation-kit-dev/repo-rights', method: 'GET' })
    expect(host.textContent).toContain('GitHub repo rights')
    expect(host.textContent).toContain('Off')
    expect(host.querySelector('ul')).toBeNull()
    expect(host.textContent).toContain('DEV_BOT_GITHUB_TOKEN')
    expect(host.textContent).toContain('It never deploys')
  })

  it('an admin adds one repo with one PUT, and only a full owner/name is accepted', async () => {
    await render(DEV, true)
    type('acme')
    expect(button('Switch on').disabled).toBe(true)
    type('acme/*')
    expect(button('Switch on').disabled).toBe(true)
    type('Acme/App')
    expect(button('Switch on').disabled).toBe(false)
    await act(async () => { button('Switch on').click() })
    await act(async () => { await Promise.resolve() })
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { repo: 'Acme/App', enabled: true } })
    expect(host.textContent).toContain('acme/app')
    expect(host.textContent).toContain('On for 1 repo')
    expect(host.textContent).toContain('switched on by operator')
  })

  it('an admin switches one repo off with one PUT', async () => {
    repos = ['acme/app', 'acme/site']
    await render(DEV, true)
    await act(async () => { button('Switch off acme/app').click() })
    await act(async () => { await Promise.resolve() })
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { repo: 'acme/app', enabled: false } })
    expect(host.textContent).not.toContain('acme/app')
    expect(host.textContent).toContain('acme/site')
  })

  it('is read-only for a non-admin, and names a stored credential without showing it', async () => {
    repos = ['acme/app']
    stored = true
    await render(DEV, false)
    expect(host.querySelector('input')).toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(host.textContent).toContain('Only an admin can change this.')
    expect(host.textContent).toContain('GitHub calls use the secret DEV_BOT_GITHUB_TOKEN.')
  })

  it('no other bot shows it or asks the server for it', async () => {
    await render(OTHER, true)
    expect(host.textContent).toBe('')
    expect(requests).toHaveLength(0)
  })
})
