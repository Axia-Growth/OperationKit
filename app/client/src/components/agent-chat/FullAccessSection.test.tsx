import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { BotFullAccess, BotFullAccessResponse, BotFullAccessSummary, FullAccessAuditEntry } from '@operationkit/shared'
import { FullAccessSection } from './FullAccessSection'
import { chooseOption, click, optionsOf, press as key } from '../../test/render'

/* obj 900972 — Full access on the bot's settings panel: one card per granted
   workspace with the Full access switch and an optional expiry, the four
   exclusion switches (each its own switch, off by default, only usable while
   Full access is on), the change log, and read-only for anyone who is not an
   admin signed in to the browser. The fake server below is stateful, so the
   screen after a click is the screen the real server would produce. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS = [{ slug: 'ops', name: 'Ops' }, { slug: 'sales', name: 'Sales' }]
const NO_EXCLUSIONS = { billing: false }

function off(workspace: string): BotFullAccess {
  return { slug: 'dev', workspace, enabled: false, expires_at: null, state: 'off', allow: { ...NO_EXCLUSIONS }, updated_by: null, updated_at: null }
}

let host: HTMLDivElement
let root: Root
let requests: { url: string; method: string; body: Record<string, unknown> | null }[] = []
let rows: BotFullAccess[]
let audit: FullAccessAuditEntry[]
let canManage = true
let failNext: string | null = null

const sqlite = (iso: string) => iso.slice(0, 19).replace('T', ' ')

function payload(): BotFullAccessResponse {
  return { slug: 'dev', workspaces: rows, workspace_options: OPTIONS, can_manage: canManage, audit }
}

beforeEach(() => {
  requests = []
  rows = [off('ops'), off('sales')]
  audit = []
  canManage = true
  failNext = null
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if (failNext && method !== 'GET') {
      const error = failNext
      failNext = null
      return json({ error, code: 'admin_only' }, 403)
    }
    if (method === 'PUT') {
      const ws = decodeURIComponent(url.split('/').pop()!)
      const row = rows.find(r => r.workspace === ws)!
      if (body.enabled === true) Object.assign(row, { enabled: true, state: 'on', allow: { ...NO_EXCLUSIONS }, updated_by: 'jordan' })
      if (body.enabled === false) Object.assign(row, { enabled: false, state: 'off', expires_at: null, allow: { ...NO_EXCLUSIONS } })
      if ('expires_at' in body && row.enabled) row.expires_at = body.expires_at ? sqlite(body.expires_at) : null
      if (body.allow) Object.assign(row.allow, body.allow)
      audit = [{
        id: audit.length + 1, event: body.enabled === false ? 'disabled' : body.allow ? 'exclusion_changed' : body.enabled ? 'enabled' : 'expiry_changed',
        slug: 'dev', workspace: ws, actor: 'jordan', enabled: row.enabled, expires_at: row.expires_at, exclusion: body.allow ? (Object.keys(body.allow)[0] as never) : null,
        ability: null, objective_id: null, detail: body.allow ? 'Billing allowed' : null, created_at: '2026-11-15 20:00:00',
      }, ...audit]
    }
    return json(payload())
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

async function render(isAdmin = true, onChanged?: (s: BotFullAccessSummary) => void) {
  await act(async () => {
    root.render(<FullAccessSection agent={{ slug: 'dev', name: 'Operation Kit Dev' }} isAdmin={isAdmin} onChanged={onChanged} />)
  })
}

const card = (ws: string) => host.querySelector(`[data-full-access-workspace="${ws}"]`) as HTMLElement
const sw = (label: string) => host.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLButtonElement
const isOn = (el: Element) => el.getAttribute('aria-checked') === 'true'
const isDisabled = (el: HTMLButtonElement) => el.disabled || el.hasAttribute('data-disabled') || !!el.closest('fieldset:disabled')
const stateOf = (ws: string) => card(ws).querySelector('[data-full-access-state]')!.textContent
const expiryPicker = (ws: string) => host.querySelector(`#bot-full-access-expiry-dev-${ws}`) as HTMLElement
const puts = () => requests.filter(r => r.method === 'PUT')
const pill = () => host.querySelector('h4')!.nextElementSibling!.textContent
/** The expiry choices, read from the opened picker (then closed again). */
async function choices(ws: string) {
  await click(expiryPicker(ws))
  const out = optionsOf(expiryPicker(ws)).map(o => (o.textContent ?? '').trim())
  await key('Escape')
  return out
}
async function press(el: HTMLElement) {
  await act(async () => { el.click() })
}

/** The one exclusion with a switch. */
const EXCLUSIONS = ['Billing']
/** Never part of Full access: listed, with no switch at all. */
const NEVER = ['Secret values', 'Minting or revoking keys', 'DNS and Cloudflare Access']

describe('Full access section', () => {
  it('lists secret values, keys, DNS / Cloudflare Access and protected pull requests as always blocked, with no switch, on or off', async () => {
    await render()
    const check = (ws: string) => {
      const never = card(ws).querySelector('[data-full-access-never]') as HTMLElement
      expect(never.textContent).toContain('Never included')
      expect(never.textContent).toContain('There is no switch for these')
      const kinds = [...never.querySelectorAll('[data-full-access-never-kind]')] as HTMLElement[]
      expect(kinds.map(k => k.dataset.fullAccessNeverKind)).toEqual(['secret_values', 'keys', 'dns_access', 'protected_prs'])
      for (const k of kinds) expect(k.textContent).toContain('Always blocked')
      for (const x of NEVER) expect(never.textContent).toContain(x)
      expect(never.textContent).toContain('PR 645')
      // No switch, button or input of any kind in that block, and none anywhere for those three.
      expect(never.querySelectorAll('button, input, [role="switch"]').length).toBe(0)
      for (const x of NEVER) expect(sw(`${x} in ${ws}`)).toBeNull()
    }
    check('ops')
    await press(sw('Full access in ops'))
    check('ops')
    check('sales')
  })

  it('shows one card per granted workspace, Full access off, and the billing exclusion off', async () => {
    await render()
    expect(pill()).toBe('Off')
    for (const ws of ['ops', 'sales']) {
      expect(stateOf(ws)).toBe('Off')
      expect(isOn(sw(`Full access in ${ws}`))).toBe(false)
      for (const x of EXCLUSIONS) {
        const s = sw(`${x} in ${ws}`)
        expect(s, `${x} switch in ${ws}`).not.toBeNull()
        expect(isOn(s)).toBe(false)
        // An exclusion can only be switched while Full access is on.
        expect(isDisabled(s)).toBe(true)
        expect(s.textContent).toContain('Blocked')
      }
    }
    expect(card('ops').textContent).toContain('Ops (ops)')
    expect(card('ops').textContent).toContain('Not included unless you switch it on')
    expect(host.textContent).toContain('Merge and deploy approvals are not part of Full access')
  })

  it('switches Full access on with no expiry by default', async () => {
    const onChanged = vi.fn()
    await render(true, onChanged)
    expect(await choices('ops')).toEqual(['No expiry', '24 hours', '7 days', '30 days', '90 days'])
    await press(sw('Full access in ops'))
    expect(puts()).toEqual([{ url: '/api/agent-chat/agents/dev/full-access/ops', method: 'PUT', body: { enabled: true, expires_at: null } }])
    expect(isOn(sw('Full access in ops'))).toBe(true)
    expect(stateOf('ops')).toBe('On, no expiry')
    expect(stateOf('sales')).toBe('Off')
    expect(pill()).toBe('On in 1 workspace')
    expect(onChanged).toHaveBeenLastCalledWith({ workspaces: [{ workspace: 'ops', expires_at: null }] })
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Full access is on for Operation Kit Dev in ops.')
  })

  it('takes an expiry picked before switching on, and shows when it ends', async () => {
    await render()
    await chooseOption(expiryPicker('ops'), '7 days')
    expect(puts()).toHaveLength(0) // picking an expiry while it is off saves nothing yet
    const before = Date.now()
    await press(sw('Full access in ops'))
    const sent = puts()[0].body as { enabled: boolean; expires_at: string }
    expect(sent.enabled).toBe(true)
    const ms = new Date(sent.expires_at).getTime() - before
    expect(ms).toBeGreaterThan(7 * 86_400_000 - 5_000)
    expect(ms).toBeLessThan(7 * 86_400_000 + 5_000)
    expect(stateOf('ops')).toMatch(/^On until .*\d/)
    // The stored date is offered as the current choice, with the presets to change it.
    expect(await choices('ops')).toHaveLength(6)
  })

  it('changes or removes the expiry while it is on', async () => {
    rows[0] = { ...off('ops'), enabled: true, state: 'on', expires_at: '2026-12-01 12:00:00' }
    await render()
    expect(stateOf('ops')).toMatch(/^On until /)
    await chooseOption(expiryPicker('ops'), 'No expiry')
    expect(puts()).toEqual([{ url: '/api/agent-chat/agents/dev/full-access/ops', method: 'PUT', body: { expires_at: null } }])
    expect(stateOf('ops')).toBe('On, no expiry')
  })

  it('billing is its own switch: usable only while Full access is on, one request per change', async () => {
    await render()
    await press(sw('Full access in ops'))
    for (const x of EXCLUSIONS) {
      expect(isOn(sw(`${x} in ops`))).toBe(false)
      expect(isDisabled(sw(`${x} in ops`))).toBe(false)
      // The other workspace's stay locked: Full access is off there.
      expect(isDisabled(sw(`${x} in sales`))).toBe(true)
    }
    await press(sw('Billing in ops'))
    expect(puts()[1]).toEqual({ url: '/api/agent-chat/agents/dev/full-access/ops', method: 'PUT', body: { allow: { billing: true } } })
    expect(isOn(sw('Billing in ops'))).toBe(true)
    expect(sw('Billing in ops').textContent).toContain('Allowed')
    await press(sw('Billing in ops'))
    expect(puts()[2].body).toEqual({ allow: { billing: false } })
    expect(isOn(sw('Billing in ops'))).toBe(false)
  })

  it('switching Full access off puts billing back to off', async () => {
    rows[0] = { ...off('ops'), enabled: true, state: 'on', allow: { billing: true } }
    await render()
    expect(isOn(sw('Billing in ops'))).toBe(true)
    await press(sw('Full access in ops'))
    expect(puts()).toEqual([{ url: '/api/agent-chat/agents/dev/full-access/ops', method: 'PUT', body: { enabled: false } }])
    expect(isOn(sw('Full access in ops'))).toBe(false)
    expect(isOn(sw('Billing in ops'))).toBe(false)
    expect(pill()).toBe('Off')
  })

  it('shows an expired workspace as expired, not on', async () => {
    rows[0] = { ...off('ops'), enabled: true, state: 'expired', expires_at: '2026-11-01 12:00:00' }
    await render()
    expect(stateOf('ops')).toMatch(/^Expired /)
    expect(isOn(sw('Full access in ops'))).toBe(false)
    expect(pill()).toBe('Off')
    expect(isDisabled(sw('Billing in ops'))).toBe(true)
  })

  it('shows the change log: what changed, who, when', async () => {
    await render()
    await press(sw('Full access in ops'))
    await press(sw('Billing in ops'))
    const log = [...host.querySelectorAll('[aria-label="Full access change log"] li')].map(li => li.textContent)
    expect(log).toHaveLength(2)
    expect(log[0]).toContain('Billing allowed in ops')
    expect(log[1]).toContain('Full access switched on in ops, no expiry')
    expect(log[0]).toContain('jordan')
    expect(host.querySelector('details summary')!.textContent).toBe('Change log (2)')
  })

  it('is read-only for someone who is not an admin', async () => {
    canManage = false
    await render(false)
    for (const ws of ['ops', 'sales']) {
      expect(isDisabled(sw(`Full access in ${ws}`))).toBe(true)
      for (const x of EXCLUSIONS) expect(isDisabled(sw(`${x} in ${ws}`))).toBe(true)
    }
    await press(sw('Full access in ops'))
    expect(puts()).toHaveLength(0)
    expect(host.textContent).toContain('Only an admin can change Full access.')
  })

  it('is read-only for an admin who is not signed in to the browser (an API key)', async () => {
    canManage = false
    rows[0] = { ...off('ops'), enabled: true, state: 'on' }
    await render(true)
    expect(isDisabled(sw('Full access in ops'))).toBe(true)
    expect(isDisabled(sw('Billing in ops'))).toBe(true)
    expect(host.textContent).toContain('API keys and bots can\'t change it')
  })

  it('says to grant a workspace first when the bot has none', async () => {
    rows = []
    await render()
    expect(host.querySelector('[role="switch"]')).toBeNull()
    expect(host.textContent).toContain('Grant a workspace under Workspace access first')
  })

  it('shows the server\'s refusal and changes nothing', async () => {
    await render()
    failNext = 'Only an admin, signed in to Command Center in the browser, can change a bot\'s Full access.'
    await press(sw('Full access in ops'))
    expect(host.querySelector('[role="alert"]')?.textContent ?? host.textContent).toContain('Only an admin, signed in')
    expect(isOn(sw('Full access in ops'))).toBe(false)
    expect(stateOf('ops')).toBe('Off')
  })
})
