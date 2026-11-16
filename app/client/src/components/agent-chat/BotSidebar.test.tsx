import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* obj 900798 — the Bots sidebar on the screen: pinned rail, sections,
   previews + unread dots, the left filter, and the per-bot context menu.

   The server-side rules (per-person rows, unread vs side threads, the admin
   gate on Rename/Delete) are proved in app/server/src/routes/agent-chat-sidebar.test.ts.
   What is asserted HERE is what only the page can get wrong: that each menu
   action sends the right request for the right bot, that the screen follows
   the stored state, that Delete asks first, and that Rename/Delete are not
   offered to someone who is not an admin. The fake server below is stateful,
   so the screen after an action is the screen the real server would produce. */

let role: 'admin' | 'member' = 'member'
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle(n = 12) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

const agent = (slug: string, name: string, source = 'file') => ({
  slug, name, file_name: name, description: `${name} description`, avatar: name.slice(0, 2).toUpperCase(), colour: 'blue',
  knowledge_folders: [], tools: [], model: null, provider: null, version: null, author: 'Test', source,
  answered_by: { id: 'demo', model: 'scripted' },
})

type Bot = {
  pinned: boolean; pin_position: number; section_id: number | null; hidden: boolean; marked_unread: boolean
  unread_count: number; unread: boolean
  last_message: { id: number; role: 'user' | 'assistant'; preview: string; created_at: string; thread_id: number | null; thread_title: string | null } | null
}
const bot = (p: Partial<Bot> = {}): Bot => ({
  pinned: false, pin_position: 0, section_id: null, hidden: false, marked_unread: false, unread_count: 0, unread: false, last_message: null, ...p,
})

let agents: ReturnType<typeof agent>[] = []
let sb: { sections: { id: number; name: string; position: number; collapsed: boolean }[]; bots: Record<string, Bot>; max_pins: number; max_sections: number }
let calls: { url: string; method: string; body: unknown }[] = []
let nextSection = 10
let root: Root
let host: HTMLDivElement

function mount(path = '/chat') {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return import('./AgentChatPage').then(({ AgentChatPage }) => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chat" element={<AgentChatPage />} />
          <Route path="/chat/:slug" element={<AgentChatPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

const nav = () => host.querySelector('nav[aria-label="Bots"]')!
const rail = () => [...host.querySelectorAll('section[aria-label="Pinned bots"] button')].map(b => b.getAttribute('title'))
const sectionNames = (sel = 'section') => [...nav().querySelectorAll(sel)].map(s => s.getAttribute('aria-label'))
const rowsIn = (title: string) =>
  [...(nav().querySelector(`section[aria-label="${title}"]`)?.querySelectorAll('li[data-bot]') ?? [])].map(li => li.getAttribute('data-bot'))
const row = (slug: string) => nav().querySelector(`li[data-bot="${slug}"]`) as HTMLLIElement | null
const writes = () => calls.filter(c => c.method !== 'GET')
const menuItem = (label: string) =>
  [...document.body.querySelectorAll('[role="menu"] :is([role="menuitem"], [role="menuitemradio"])')].find(b => (b.textContent ?? '').startsWith(label)) as HTMLElement | undefined
const menuLabels = () => [...document.body.querySelectorAll('[role="menu"] :is([role="menuitem"], [role="menuitemradio"])')].map(b => b.textContent ?? '')

async function openMenu(slug: string) {
  const name = agents.find(a => a.slug === slug)!.name
  ;(host.querySelector(`button[aria-label="Actions for ${name}"]`) as HTMLButtonElement).click()
  await settle(4)
  expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
}

beforeEach(() => {
  role = 'member'
  calls = []
  nextSection = 10
  agents = [agent('dev-bot', 'Dev Bot'), agent('marketing-bot', 'Marketing Bot'), agent('ops-bot', 'Ops Bot'), agent('helper', 'Helper', 'builtin')]
  sb = {
    sections: [
      { id: 1, name: 'Development', position: 0, collapsed: false },
      { id: 2, name: 'Marketing', position: 1, collapsed: false },
    ],
    bots: {
      'dev-bot': bot({ section_id: 1, last_message: { id: 4, role: 'user', preview: 'ship it', created_at: '2026-11-13 09:00:00', thread_id: null, thread_title: null } }),
      'marketing-bot': bot({
        unread: true, unread_count: 1,
        last_message: { id: 9, role: 'assistant', preview: 'Draft is ready', created_at: '2026-11-13 10:00:00', thread_id: 7, thread_title: 'Launch' },
      }),
      'ops-bot': bot({ pinned: true, pin_position: 0 }),
      helper: bot(),
    },
    max_pins: 12,
    max_sections: 20,
  }
  // No real socket in tests: the live push is driven through dispatchServerMessage.
  vi.stubGlobal('WebSocket', class { close() {} send() {} readyState = 0 })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url, method, body })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') return json({ agents, demo: false, providers: { demo: true }, default_provider: null })
    const m = url.match(/^\/api\/agent-chat\/sidebar\/bots\/([^/]+)(\/read|\/unread)?$/)
    if (m) {
      const b = sb.bots[m[1]]
      if (m[2] === '/read') Object.assign(b, { unread: false, unread_count: 0, marked_unread: false })
      else if (m[2] === '/unread') Object.assign(b, { unread: true, marked_unread: true })
      else {
        if (body.pinned === true) Object.assign(b, { pinned: true, hidden: false, pin_position: 99 })
        if (body.pinned === false) b.pinned = false
        if (body.hidden === true) Object.assign(b, { hidden: true, pinned: false })
        if (body.hidden === false) b.hidden = false
        if ('section_id' in body) b.section_id = body.section_id
      }
      return json(sb)
    }
    if (url === '/api/agent-chat/sidebar/sections' && method === 'POST') {
      const section = { id: nextSection++, name: body.name, position: sb.sections.length, collapsed: false }
      sb.sections.push(section)
      return json({ section, ...sb }, 201)
    }
    if (url === '/api/agent-chat/sidebar/sections/order') {
      sb.sections = (body.ids as number[]).map((id, i) => ({ ...sb.sections.find(s => s.id === id)!, position: i }))
      return json(sb)
    }
    const sm = url.match(/^\/api\/agent-chat\/sidebar\/sections\/(\d+)$/)
    if (sm) {
      const id = Number(sm[1])
      if (method === 'DELETE') {
        sb.sections = sb.sections.filter(s => s.id !== id)
        for (const b of Object.values(sb.bots)) if (b.section_id === id) b.section_id = null
        return json({ ok: true, moved: 0, ...sb })
      }
      Object.assign(sb.sections.find(s => s.id === id)!, body)
      return json({ section: sb.sections.find(s => s.id === id), ...sb })
    }
    if (url === '/api/agent-chat/sidebar') return json(sb)
    const cfg = url.match(/^\/api\/agent-chat\/agents\/([^/]+)\/config$/)
    if (cfg && method === 'PUT') {
      const a = agents.find(x => x.slug === cfg[1])!
      a.name = body.name || a.file_name
      return json({ agent: a })
    }
    const del = url.match(/^\/api\/agent-chat\/agents\/([^/]+)$/)
    if (del && method === 'DELETE') {
      agents = agents.filter(x => x.slug !== del[1])
      delete sb.bots[del[1]]
      return json({ ok: true })
    }
    if (url.includes('/threads')) return json({ threads: [], max_open: 10 })
    if (url.includes('/messages')) return json({ messages: [], drafts: [], cards: [] })
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  document.body.querySelectorAll('[role="menu"]').forEach(n => n.remove())
  vi.unstubAllGlobals()
})

describe('layout', () => {
  it('shows the pinned rail, the person\'s sections in order, then Other bots', async () => {
    await mount()
    await settle()
    expect(rail()).toEqual(['Ops Bot'])
    expect(sectionNames('section[aria-label]:not([aria-label="Pinned bots"])')).toEqual(['Development', 'Marketing', 'Other bots'])
    expect(rowsIn('Development')).toEqual(['dev-bot'])
    expect(rowsIn('Other bots')).toEqual(['marketing-bot', 'helper'])
    // A pinned bot is in the rail, not repeated as a row.
    expect(row('ops-bot')).toBeNull()
  })

  it('shows the last-message preview (side thread named, "You:" for your own) and a pending badge', async () => {
    await mount()
    await settle()
    expect(row('marketing-bot')!.textContent).toContain('Launch · Draft is ready')
    expect(row('marketing-bot')!.querySelector('[aria-label="1 unread reply"]')).not.toBeNull()
    expect(row('dev-bot')!.textContent).toContain('You: ship it')
    expect(row('dev-bot')!.querySelector('[data-pending-badge]')).toBeNull()
  })

  it('opening a bot marks it read', async () => {
    await mount('/chat/marketing-bot')
    await settle()
    expect(writes().some(c => c.method === 'POST' && c.url === '/api/agent-chat/sidebar/bots/marketing-bot/read')).toBe(true)
    expect(row('marketing-bot')!.querySelector('[role="img"]')).toBeNull()
  })

  it('falls back to a plain list when the server has no sidebar route', async () => {
    sb = undefined as never
    await mount()
    await settle()
    expect(nav().querySelectorAll('li[data-bot]').length).toBe(4)
  })
})

describe('the left filter', () => {
  it('narrows by text and by Unread / a section', async () => {
    await mount()
    await settle()
    const search = host.querySelector('input[type="search"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(search, 'draft')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(4)
    expect([...nav().querySelectorAll('li[data-bot]')].map(li => li.getAttribute('data-bot'))).toEqual(['marketing-bot'])
    setter.call(search, '')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(4)

    const chip = (t: string) => [...host.querySelectorAll('[role="search"] button[aria-pressed]')].find(b => (b.textContent ?? '').startsWith(t)) as HTMLButtonElement
    chip('Unread').click()
    await settle(4)
    expect([...nav().querySelectorAll('li[data-bot]')].map(li => li.getAttribute('data-bot'))).toEqual(['marketing-bot'])
    expect(rail()).toEqual([])
    chip('Development').click()
    await settle(4)
    expect([...nav().querySelectorAll('li[data-bot]')].map(li => li.getAttribute('data-bot'))).toEqual(['dev-bot'])
  })
})

describe('the per-bot context menu', () => {
  it('lists the actions; Rename and Delete only for an admin', async () => {
    await mount()
    await settle()
    await openMenu('dev-bot')
    const member = menuLabels()
    expect(member.some(l => l.startsWith('Pin to top'))).toBe(true)
    expect(member.some(l => l.startsWith('Move to section'))).toBe(true)
    expect(member.some(l => l.startsWith('Mark as unread'))).toBe(true)
    expect(member.some(l => l.startsWith('Copy ID'))).toBe(true)
    expect(member.some(l => l.startsWith('Hide from sidebar'))).toBe(true)
    expect(member.some(l => l.startsWith('Rename'))).toBe(false)
    expect(member.some(l => l.startsWith('Delete'))).toBe(false)
  })

  it('Pin to top pins this bot and it joins the rail', async () => {
    await mount()
    await settle()
    await openMenu('dev-bot')
    menuItem('Pin to top')!.click()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/bots/dev-bot', method: 'PATCH', body: { pinned: true } })
    expect(rail()).toEqual(['Ops Bot', 'Dev Bot'])
  })

  it('Move to section moves the bot into the picked section', async () => {
    await mount()
    await settle()
    await openMenu('marketing-bot')
    menuItem('Move to section')!.click()
    await settle(4)
    menuItem('Marketing')!.click()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/bots/marketing-bot', method: 'PATCH', body: { section_id: 2 } })
    expect(rowsIn('Marketing')).toEqual(['marketing-bot'])
  })

  it('Move to section → New section… creates it and moves the bot there', async () => {
    await mount()
    await settle()
    await openMenu('helper')
    menuItem('Move to section')!.click()
    await settle(4)
    menuItem('New section')!.click()
    await settle(4)
    const input = document.body.querySelector('#bot-sidebar-dialog-input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'Support')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(2)
    ;(input.form as HTMLFormElement).requestSubmit()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/sections', method: 'POST', body: { name: 'Support' } })
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/bots/helper', method: 'PATCH', body: { section_id: 10 } })
    expect(rowsIn('Support')).toEqual(['helper'])
  })

  it('Mark as unread puts a badge (no number) on the bot', async () => {
    await mount()
    await settle()
    await openMenu('dev-bot')
    menuItem('Mark as unread')!.click()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/bots/dev-bot/unread', method: 'POST', body: null })
    expect(row('dev-bot')!.querySelector('[aria-label="Marked unread"]')).not.toBeNull()
  })

  it('Copy ID copies the bot id', async () => {
    await mount()
    await settle()
    await openMenu('dev-bot')
    menuItem('Copy ID')!.click()
    await settle()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('dev-bot')
  })

  it('Hide from sidebar hides it; the Hidden filter brings it back', async () => {
    await mount()
    await settle()
    await openMenu('dev-bot')
    menuItem('Hide from sidebar')!.click()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/bots/dev-bot', method: 'PATCH', body: { hidden: true } })
    expect(row('dev-bot')).toBeNull()
    const hidden = [...host.querySelectorAll('[role="search"] button[aria-pressed]')].find(b => (b.textContent ?? '').startsWith('Hidden')) as HTMLButtonElement
    hidden.click()
    await settle(4)
    expect(row('dev-bot')).not.toBeNull()
    await openMenu('dev-bot')
    menuItem('Show in sidebar')!.click()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/bots/dev-bot', method: 'PATCH', body: { hidden: false } })
  })

  it('Rename (admin) renames the bot for everyone through the bot config', async () => {
    role = 'admin'
    await mount()
    await settle()
    await openMenu('dev-bot')
    menuItem('Rename')!.click()
    await settle(4)
    const input = document.body.querySelector('#bot-sidebar-dialog-input') as HTMLInputElement
    expect(input.value).toBe('Dev Bot')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'Engineering')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(2)
    ;(input.form as HTMLFormElement).requestSubmit()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/agents/dev-bot/config', method: 'PUT', body: { name: 'Engineering' } })
    expect(row('dev-bot')!.textContent).toContain('Engineering')
  })

  it('Delete (admin) asks first: Cancel sends nothing, confirming deletes the bot', async () => {
    role = 'admin'
    await mount()
    await settle()
    const confirmBtn = (label: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent === label && !host.contains(b) && !b.closest('[role="menu"]'))

    await openMenu('dev-bot')
    menuItem('Delete')!.click()
    await settle(4)
    expect(document.body.textContent).toContain('Delete Dev Bot for everyone?')
    confirmBtn('Cancel')!.click()
    await settle()
    expect(writes().some(c => c.method === 'DELETE')).toBe(false)
    expect(row('dev-bot')).not.toBeNull()

    await openMenu('dev-bot')
    menuItem('Delete')!.click()
    await settle(4)
    confirmBtn('Delete bot')!.click()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/agents/dev-bot', method: 'DELETE', body: null })
    expect(row('dev-bot')).toBeNull()
  })

  it('a built-in bot cannot be deleted from the menu (admin sees why)', async () => {
    role = 'admin'
    await mount()
    await settle()
    await openMenu('helper')
    const del = menuItem('Delete')!
    expect(del.getAttribute('aria-disabled')).toBe('true')
    expect(del.textContent).toContain('hide it instead')
  })
})

describe('section management', () => {
  it('deleting a section asks first and keeps its bots (they move to Other bots)', async () => {
    await mount()
    await settle()
    ;(host.querySelector('button[aria-label="Actions for the section Development"]') as HTMLButtonElement).click()
    await settle(4)
    menuItem('Delete section')!.click()
    await settle(4)
    const ok = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Delete section' && !b.closest('[role="menu"]'))!
    ok.click()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/sections/1', method: 'DELETE', body: null })
    expect(rowsIn('Other bots')).toContain('dev-bot')
  })

  it('Move down reorders the sections', async () => {
    await mount()
    await settle()
    ;(host.querySelector('button[aria-label="Actions for the section Development"]') as HTMLButtonElement).click()
    await settle(4)
    menuItem('Move down')!.click()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/sections/order', method: 'PUT', body: { ids: [2, 1] } })
    expect(sectionNames('section[aria-label]:not([aria-label="Pinned bots"])')).toEqual(['Marketing', 'Development', 'Other bots'])
  })
})

/* obj 900866 — the pending badge (count, live, clears on open) and the New bot button. */
describe('pending badge (obj 900866)', () => {
  const badge = (slug: string) => row(slug)?.querySelector('[data-pending-badge]') as HTMLElement | null
  const tile = (name: string) => host.querySelector(`section[aria-label="Pinned bots"] button[title="${name}"]`) as HTMLButtonElement | null
  const ping = async (slug: string) => {
    const { dispatchServerMessage } = await import('../../hooks/useWebSocket')
    dispatchServerMessage({ type: 'agent_chat_unread', payload: { user_id: 2, agent_slug: slug } })
  }

  it('shows the number of waiting replies on the row and the pinned tile, capped at 99+', async () => {
    Object.assign(sb.bots['marketing-bot'], { unread: true, unread_count: 3 })
    Object.assign(sb.bots['ops-bot'], { unread: true, unread_count: 120 })
    await mount()
    await settle()
    expect(badge('marketing-bot')!.textContent).toBe('3')
    expect(badge('marketing-bot')!.getAttribute('aria-label')).toBe('3 unread replies')
    const pinned = tile('Ops Bot')!
    expect(pinned.querySelector('[data-pending-badge]')!.textContent).toBe('99+')
    expect(pinned.getAttribute('aria-label')).toBe('Ops Bot (120 unread replies) — pinned')
    expect(badge('dev-bot')).toBeNull()
  })

  it('says how many replies are waiting in the header, and that line opens the Unread filter', async () => {
    Object.assign(sb.bots['marketing-bot'], { unread: true, unread_count: 2 })
    Object.assign(sb.bots['dev-bot'], { unread: true, marked_unread: true, unread_count: 0 })
    await mount()
    await settle()
    const line = [...host.querySelectorAll('button')].find(b => b.textContent === '3 replies waiting on you')!
    expect(line).toBeDefined()
    line.click()
    await settle(4)
    expect(host.querySelector('button[aria-pressed="true"]')!.textContent).toContain('Unread')
    expect(rowsIn('Development')).toEqual(['dev-bot'])
    expect(rowsIn('Other bots')).toEqual(['marketing-bot'])
  })

  it('a collapsed section shows the count of waiting replies inside it', async () => {
    sb.sections[0].collapsed = true
    Object.assign(sb.bots['dev-bot'], { unread: true, unread_count: 4 })
    await mount()
    await settle()
    expect(nav().querySelector('[aria-label="4 unread in this section"]')!.textContent).toBe('4')
  })

  it('appears live when the server pings a new reply, without waiting for the poll', async () => {
    await mount()
    await settle()
    expect(badge('dev-bot')).toBeNull()
    const reads = calls.filter(c => c.url === '/api/agent-chat/sidebar').length
    // A reply lands for dev-bot on the server, and the server pings this person.
    Object.assign(sb.bots['dev-bot'], { unread: true, unread_count: 1 })
    await ping('dev-bot')
    await ping('dev-bot') // a burst becomes one re-read
    await new Promise(r => setTimeout(r, 300))
    await settle()
    expect(calls.filter(c => c.url === '/api/agent-chat/sidebar').length).toBe(reads + 1)
    expect(badge('dev-bot')!.textContent).toBe('1')
  })

  it('ignores other socket messages', async () => {
    await mount()
    await settle()
    const reads = calls.filter(c => c.url === '/api/agent-chat/sidebar').length
    const { dispatchServerMessage } = await import('../../hooks/useWebSocket')
    dispatchServerMessage({ type: 'alert_acked', payload: { id: 1 } })
    await new Promise(r => setTimeout(r, 300))
    await settle()
    expect(calls.filter(c => c.url === '/api/agent-chat/sidebar').length).toBe(reads)
  })

  it('clears the moment the bot is opened', async () => {
    await mount()
    await settle()
    expect(badge('marketing-bot')).not.toBeNull()
    ;(row('marketing-bot')!.querySelector('button') as HTMLButtonElement).click()
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/bots/marketing-bot/read', method: 'POST', body: null })
    expect(badge('marketing-bot')).toBeNull()
  })

  it('a new reply in the bot you have open is read at once; one for another bot gets a badge', async () => {
    await mount('/chat/dev-bot')
    await settle()
    calls = []
    Object.assign(sb.bots['dev-bot'], { unread: true, unread_count: 1 })
    Object.assign(sb.bots['ops-bot'], { unread: true, unread_count: 2 })
    await ping('dev-bot')
    await new Promise(r => setTimeout(r, 300))
    await settle()
    expect(writes()).toContainEqual({ url: '/api/agent-chat/sidebar/bots/dev-bot/read', method: 'POST', body: null })
    expect(writes().some(c => c.url.includes('/ops-bot/read'))).toBe(false)
    expect(badge('dev-bot')).toBeNull()
    expect(tile('Ops Bot')!.querySelector('[data-pending-badge]')!.textContent).toBe('2')
  })

  it('does not undo "Mark as unread" on the bot you have open', async () => {
    await mount('/chat/dev-bot')
    await settle()
    await openMenu('dev-bot')
    menuItem('Mark as unread')!.click()
    await settle()
    calls = []
    await ping('marketing-bot')
    await new Promise(r => setTimeout(r, 300))
    await settle()
    expect(writes().some(c => c.url.includes('/dev-bot/read'))).toBe(false)
    expect(row('dev-bot')!.querySelector('[aria-label="Marked unread"]')).not.toBeNull()
  })
})

describe('New bot button (obj 900866)', () => {
  const newBot = () => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'New bot') as HTMLButtonElement | undefined
  const aside = () => host.querySelector('nav[aria-label="Bots"]')!.parentElement!

  it('is a visible, filled primary in the Bots header for an admin, and the only one in the sidebar', async () => {
    role = 'admin'
    await mount()
    await settle()
    const b = newBot()!
    expect(b).toBeDefined()
    expect(b.closest('[aria-label="Pinned bots"], [role="menu"]')).toBeNull()
    expect(b.className).toContain('bg-accent')
    const filled = [...aside().querySelectorAll('button')].filter(x => /(^|\s)bg-accent(\s|$)/.test(x.className))
    expect(filled).toEqual([b])
  })

  it('is not offered to someone who cannot add bots', async () => {
    await mount()
    await settle()
    expect(newBot()).toBeUndefined()
  })

  it('opens the existing create flow — template and paste, plus the Dev bot when it is installed — and creates nothing itself', async () => {
    role = 'admin'
    agents.push(agent('operation-kit-dev', 'Dev'))
    sb.bots['operation-kit-dev'] = bot()
    await mount()
    await settle()
    const before = writes().length
    newBot()!.click()
    await settle(4)
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('New bot')
    const links = [...dialog.querySelectorAll('a[data-new-bot]')].map(a => [a.getAttribute('data-new-bot'), a.getAttribute('href')])
    const { devBotLink } = await import('../agents/CreateAgentGuide')
    expect(links).toEqual([
      ['dev', devBotLink('bot')],
      ['template', '/agents?tab=templates'],
      ['paste', '/agents?tab=templates&paste=1'],
    ])
    expect(writes().length).toBe(before)
  })

  it('without the Dev bot it still offers the template and paste paths', async () => {
    role = 'admin'
    await mount()
    await settle()
    newBot()!.click()
    await settle(4)
    const keys = [...document.body.querySelectorAll('[role="dialog"] a[data-new-bot]')].map(a => a.getAttribute('data-new-bot'))
    expect(keys).toEqual(['template', 'paste'])
  })

  it('"Ask the Dev bot" opens its conversation with the request typed, not sent', async () => {
    role = 'admin'
    agents.push(agent('operation-kit-dev', 'Dev'))
    sb.bots['operation-kit-dev'] = bot()
    await mount()
    await settle()
    newBot()!.click()
    await settle(4)
    ;(document.body.querySelector('[role="dialog"] a[data-new-bot="dev"]') as HTMLAnchorElement).click()
    await settle()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    const { CREATE_PROMPTS } = await import('../agents/CreateAgentGuide')
    const box = host.querySelector('textarea') as HTMLTextAreaElement
    expect(box.value).toBe(CREATE_PROMPTS.bot)
    expect(writes().some(c => c.url.endsWith('/messages'))).toBe(false)
  })
})

/* obj 900972 — a bot with Full access is marked in the sidebar (row and pinned
   tile) and on its page header, where the workspace and the expiry are named.
   A bot without it carries no badge. */
describe('Full access badge', () => {
  const withFullAccess = (slug: string, workspaces: { workspace: string; expires_at: string | null }[]) => {
    Object.assign(agents.find(a => a.slug === slug)!, { full_access: { workspaces } })
  }

  it('marks a bot with Full access in its sidebar row, and only that bot', async () => {
    withFullAccess('dev-bot', [{ workspace: 'operationkit', expires_at: null }])
    await mount()
    await settle()
    const badge = row('dev-bot')!.querySelector('[data-full-access-badge]')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toContain('Full access')
    // Read out in full for screen readers and on hover.
    expect(badge!.getAttribute('title')).toBe('Full access in operationkit')
    expect(badge!.querySelector('.sr-only')!.textContent).toBe('Full access in operationkit')
    expect(row('marketing-bot')!.querySelector('[data-full-access-badge]')).toBeNull()
    expect(row('helper')!.querySelector('[data-full-access-badge]')).toBeNull()
  })

  it('marks a pinned bot on its tile', async () => {
    withFullAccess('ops-bot', [{ workspace: 'ops', expires_at: null }])
    await mount()
    await settle()
    const tile = host.querySelector('li[data-bot-tile="ops-bot"]')!
    expect(tile.querySelector('[data-full-access-badge]')!.getAttribute('title')).toBe('Full access in ops')
    expect(tile.querySelector('button')!.getAttribute('aria-label')).toContain('Full access in ops')
  })

  it('shows the workspace and the expiry on the bot page header', async () => {
    withFullAccess('dev-bot', [{ workspace: 'operationkit', expires_at: '2030-03-09 12:00:00' }])
    await mount('/chat/dev-bot')
    await settle()
    const header = host.querySelector('section[aria-label="Conversation with Dev Bot"] header')!
    const badge = header.querySelector('[data-full-access-badge]')!
    expect(badge.textContent).toMatch(/Full access · operationkit · until .*2030/)
    expect(badge.getAttribute('title')).toMatch(/^Full access in operationkit \(until .*2030\)$/)
    // The row badge stays compact: no workspace, no date.
    expect(row('dev-bot')!.querySelector('[data-full-access-badge] [aria-hidden="true"]:not(svg)')!.textContent).toBe('Full access')
  })

  it('names how many workspaces when there is more than one, and no expiry when none is set', async () => {
    withFullAccess('dev-bot', [{ workspace: 'ops', expires_at: null }, { workspace: 'sales', expires_at: null }])
    await mount('/chat/dev-bot')
    await settle()
    const header = host.querySelector('section[aria-label="Conversation with Dev Bot"] header')!
    expect(header.querySelector('[data-full-access-badge]')!.textContent).toContain('Full access · 2 workspaces')
    expect(header.querySelector('[data-full-access-badge]')!.textContent).not.toContain('until')
  })

  it('shows no badge on the header of a bot without Full access', async () => {
    await mount('/chat/dev-bot')
    await settle()
    expect(host.querySelector('section[aria-label="Conversation with Dev Bot"] header [data-full-access-badge]')).toBeNull()
  })
})
