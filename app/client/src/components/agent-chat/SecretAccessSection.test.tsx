import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { SecretAccessSection, type SecretAccessPanelData } from './SecretAccessSection'
import type { ChatAgentInfo } from './types'

/* obj 901484 — the Secret access panel: five ticks and ONE Save give one bot
   read access to five keys; a suggested host is only text in a box until Save;
   All secrets is one tick + confirm hosts + Save; a non-admin sees no names. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AGENT = { slug: 'gtm', name: 'GTM Engineer' } as unknown as ChatAgentInfo
const NAMES = ['ACME_API_KEY', 'APIFY_API_TOKEN', 'EXA_API_KEY', 'HUNTER_API_KEY', 'ZETA_API_KEY']
const HOST: Record<string, string> = { ACME_API_KEY: 'api.acme.example', APIFY_API_TOKEN: 'api.apify.com', EXA_API_KEY: 'api.exa.ai', HUNTER_API_KEY: 'api.hunter.io' }

let host: HTMLDivElement
let root: Root
let requests: { url: string; method: string; body: any }[] = []

const status = (name: string, usable = false) => ({ name, usable, reason: usable ? 'ok' : 'no_host', detail: usable ? `GTM Engineer can send ${name}.` : `${name} has no destination host yet, so it cannot be sent anywhere.`, via: [], hosts: [], methods: [] })
function panel(over: Partial<SecretAccessPanelData> = {}): SecretAccessPanelData {
  return {
    slug: 'gtm', workspace: 'growth', workspaces: ['growth'], tool_on: false, full_access_here: false,
    all_secrets: { enabled: false, mode: 'read' },
    needs_host: NAMES,
    secrets: NAMES.map(name => ({
      name, scope: 'workspace', grant: null, confirmed_hosts: [], covered_by_all: false, workspace_wide: null,
      // ZETA has no suggestion: the admin must type its host.
      suggestions: HOST[name] ? [{ host: HOST[name], source: 'known_vendor' as const }] : [],
      status: status(name),
    })),
    ...over,
  }
}

beforeEach(() => {
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body })
    const json = method === 'PUT'
      ? { saved: { added: body.grants.map((g: any) => g.name), changed: [], removed: [], tool_switched_on: true, all_secrets: body.all_secrets.enabled ? 'on_read' : null, hosts_confirmed: body.hosts.map((h: any) => h.name), hosts_cleared: [] }, secret_access: panel({ tool_on: true }), agent: { ...AGENT, tools: ['secrets'] } }
      : method === 'POST'
        ? { test: { tool_on: true, checked_at: '', results: [status('APIFY_API_TOKEN', true), status('ZETA_API_KEY')] } }
        : { secret_access: panel() }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
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

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
async function render(isAdmin: boolean, onSaved = vi.fn()) {
  await act(async () => { root.render(<SecretAccessSection agent={AGENT} isAdmin={isAdmin} onSaved={onSaved} />) })
  await flush()
  return onSaved
}
const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!
const tickBox = (name: string) => q<HTMLInputElement>(`[aria-label="Let GTM Engineer use ${name}"]`)
const hostBox = (name: string) => q<HTMLInputElement>(`[aria-label="Host for ${name}"]`)
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))!
const click = async (el: HTMLElement) => { await act(async () => { el.click() }); await flush() }
async function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const puts = () => requests.filter(r => r.method === 'PUT')

describe('SecretAccessSection', () => {
  it('a non-admin sees no secret names and nothing is fetched', async () => {
    await render(false)
    expect(requests).toHaveLength(0)
    expect(host.textContent).toContain('Only an admin')
    expect(host.textContent).not.toContain('APIFY_API_TOKEN')
  })

  it('five ticks and one Save give the bot read access to five keys', async () => {
    const onSaved = await render(true)
    expect(requests[0]).toMatchObject({ url: '/api/agent-chat/agents/gtm/secret-access', method: 'GET' })
    for (const n of NAMES) await click(tickBox(n))
    // Ticking puts the suggested host in the box, labelled as a suggestion. Nothing is sent yet.
    expect(hostBox('APIFY_API_TOKEN').value).toBe('api.apify.com')
    expect(host.textContent).toContain('Suggested: the vendor’s usual API host. Check it before you save.')
    expect(puts()).toHaveLength(0)

    // ZETA has no suggestion and an empty box: Save is stopped here, nothing is sent.
    await click(button('Save secret access'))
    expect(puts()).toHaveLength(0)
    expect(host.textContent).toContain('Type the host for ZETA_API_KEY')

    await type(hostBox('ZETA_API_KEY'), 'api.zeta.example')
    await click(button('Save secret access'))
    expect(puts()).toHaveLength(1) // ONE save for all five
    const body = puts()[0].body
    expect(body.workspace).toBe('growth')
    expect(body.grants).toHaveLength(5)
    expect(body.grants.find((g: any) => g.name === 'ZETA_API_KEY')).toEqual({ name: 'ZETA_API_KEY', hosts: ['api.zeta.example'], methods: ['GET', 'HEAD'] })
    for (const g of body.grants) expect(g.methods).toEqual(['GET', 'HEAD']) // read only by default
    expect(body.all_secrets).toEqual({ enabled: false, mode: 'read' })
    expect(body.hosts).toEqual([])
    expect(host.textContent).toContain('the “Use secrets by name” tool was switched on')
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('an edited host is what gets saved, and write is a per-key choice', async () => {
    await render(true)
    await click(tickBox('EXA_API_KEY'))
    await type(hostBox('EXA_API_KEY'), 'eu.exa.example')
    const mode = q<HTMLSelectElement>('[aria-label="What the bot may do with EXA_API_KEY"]')
    await act(async () => { mode.value = 'write'; mode.dispatchEvent(new Event('change', { bubbles: true })) })
    await click(button('Save secret access'))
    expect(puts()[0].body.grants).toEqual([{ name: 'EXA_API_KEY', hosts: ['eu.exa.example'], methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }])
  })

  it('All secrets: one tick, confirm the hosts in one go, Save. Unconfirmed suggestions are not sent', async () => {
    await render(true)
    await click(q('[data-testid="all-secrets"]'))
    expect(host.textContent).toContain('GTM Engineer will be able to read data at every vendor')
    expect(host.textContent).toContain('5 keys have no host yet')
    expect(hostBox('HUNTER_API_KEY').value).toBe('api.hunter.io') // suggested, in a box

    // Saving WITHOUT pressing Confirm sends the switch but no host.
    await click(button('Save secret access'))
    expect(puts()[0].body).toMatchObject({ grants: [], all_secrets: { enabled: true, mode: 'read' }, hosts: [] })

    // Confirm: the four keys with a host in the box. ZETA is blank and stays out.
    await click(q('[data-testid="all-secrets"]'))
    expect(button('Confirm 4 hosts')).toBeTruthy()
    expect(host.textContent).toContain('Keys left blank stay unusable')
    await click(button('Confirm 4 hosts'))
    await click(q('[data-testid="all-secrets-write"]'))
    expect(host.textContent).toContain('read and change data')
    await click(button('Save secret access'))
    const body = puts()[1].body
    expect(body.all_secrets).toEqual({ enabled: true, mode: 'write' })
    expect(body.hosts.map((h: any) => h.name).sort()).toEqual(['ACME_API_KEY', 'APIFY_API_TOKEN', 'EXA_API_KEY', 'HUNTER_API_KEY'])
    expect(body.hosts.find((h: any) => h.name === 'EXA_API_KEY')).toEqual({ name: 'EXA_API_KEY', hosts: ['api.exa.ai'] })
  })

  it('Test access lists yes/no with the reason per secret', async () => {
    await render(true)
    await click(button('Test access'))
    expect(requests.at(-1)).toMatchObject({ url: '/api/agent-chat/agents/gtm/secret-access/test', method: 'POST', body: { workspace: 'growth' } })
    const box = q('[data-testid="secret-access-test"]')
    expect(box.textContent).toContain('Nothing was sent to any vendor')
    expect(box.textContent).toContain('Yes APIFY_API_TOKEN')
    expect(box.textContent).toContain('No ZETA_API_KEY: ZETA_API_KEY has no destination host yet')
  })
})
