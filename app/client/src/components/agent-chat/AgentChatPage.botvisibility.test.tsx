import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

/* obj 900947 — bot visibility on the screen: the sidebar live line + status
   dot and the "Needs you" count across bots; the bot page's Work tab groups
   with spend vs ceiling and PR links; the High Agency Activity feed (daily
   summary, entries that expand into the full run and collapse again); the
   main-chat "needs you" post whose Approve and Reply call the EXISTING card
   routes; and older High Agency updates folded away, never deleted.

   The server rules (grouping, scoping, the four reasons, the routing rule) are
   proved in app/server/src/routes/agent-chat-bot-work.test.ts. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'operator', role: 'admin' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle(n = 14) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

const agent = (slug: string, name: string) => ({
  slug, name, file_name: name, description: `${name} description`, avatar: name.slice(0, 2).toUpperCase(), colour: 'blue',
  knowledge_folders: [], tools: [], model: null, provider: null, version: null, author: 'Test', source: 'file',
  answered_by: { id: 'demo', model: 'scripted' },
})
const agents = [agent('cto', 'CTO'), agent('okit-dev', 'Operation Kit Dev'), agent('helper', 'Helper')]

const counts = (p: Partial<Record<'running' | 'review' | 'queued' | 'done' | 'needs_you', number>> = {}) => ({ running: 0, review: 0, queued: 0, done: 0, needs_you: 0, ...p })
const STATUS = {
  bots: {
    cto: { slug: 'cto', state: 'waiting', line: 'Needs you on #41 · 1 running', focus_id: 41, counts: counts({ running: 1, review: 1, needs_you: 1 }) },
    'okit-dev': { slug: 'okit-dev', state: 'running', line: 'Working on #900936 · 2 in review', focus_id: 900936, counts: counts({ running: 1, review: 2 }) },
    helper: { slug: 'helper', state: 'idle', line: 'Idle', focus_id: null, counts: counts() },
  },
  needs_you_total: 3,
}

const wcard = (id: number, title: string, group: string, p: Record<string, unknown> = {}) => ({
  id, title, status: group === 'running' ? 'working' : group === 'review' ? 'review' : group === 'queued' ? 'queue' : 'done', workspace: 'ops', group,
  pr_url: null, spent_usd: 1, ceiling_usd: 10, ceiling_source: 'default:normal', ceiling_is_default: true, needs_you: [], is_wake: false,
  updated_at: '2026-11-15 10:00:00', ...p,
})
const WORK = {
  slug: 'cto',
  owner_token: 'bot:Grok: CTO',
  workspaces: ['ops'],
  groups: {
    running: [wcard(40, 'Ship the importer', 'running', { spent_usd: 12.5, ceiling_usd: 10, needs_you: ['over_ceiling'] })],
    review: [
      wcard(41, 'Pick a vendor', 'review', { needs_you: ['decision'], pr_url: 'https://github.com/acme/repo/pull/77', review_stage: 'sign_off' }),
      // obj 901387: in review, but not the person's turn — no "needs you" badge, a plain stage label instead.
      wcard(43, 'Importer PR', 'review', { needs_you: [], pr_url: 'https://github.com/acme/repo/pull/78', review_stage: 'awaiting_ai_review' }),
    ],
    queued: [],
    done: [wcard(39, 'Fix login', 'done', { pr_url: 'https://github.com/acme/repo/pull/70' })],
  },
  counts: counts({ running: 1, review: 1, done: 1, needs_you: 2 }),
  state: 'waiting',
  line: '2 need you · 1 running · 1 in review',
}
const ACTIVITY = {
  slug: 'cto',
  high_agency: true,
  workspaces: ['ops'],
  summary: {
    since: '2026-11-14 12:00:00',
    wakes: 2,
    shipped: [{ id: 39, title: 'Fix login', status: 'done', pr_url: 'https://github.com/acme/repo/pull/70', spent_usd: 2 }],
    spent_usd: 7.25,
    next: { next_wake_at: '2026-11-15T22:17:00.000Z', queued: [{ id: 42, title: 'Write the runbook' }], needs_you: 2 },
  },
  entries: [
    { wake_id: 90, at: '2026-11-15 09:00:00', status: 'done', picked: { id: 40, title: 'Ship the importer', status: 'working', pr_url: null, spent_usd: 4 }, did: 'Closed 2 cards and started the importer.', pr_url: null, cost_usd: 4.5, disposition: 'complete', needs_you: [] },
    { wake_id: 89, at: '2026-11-15 07:00:00', status: 'review', picked: null, did: 'Nothing worth starting.', pr_url: null, cost_usd: 0.3, disposition: 'needs_review', needs_you: ['decision'] },
  ],
  items: [
    { key: 'wake:90:2026-11-15 09:00:00', kind: 'wake', at: '2026-11-15 09:00:00', card: { id: 40, title: 'Ship the importer', status: 'working', pr_url: null, spent_usd: 4 }, wake_id: 90, detail: 'Closed 2 cards and started the importer.', pr_url: null },
    { key: 'wake:89:2026-11-15 07:00:00', kind: 'wake', at: '2026-11-15 07:00:00', card: { id: 89, title: 'High Agency wake', status: 'review', pr_url: null, spent_usd: 0.3 }, wake_id: 89, detail: 'Nothing worth starting.', pr_url: null },
  ],
}
const RUN = {
  ...ACTIVITY.entries[0], title: 'High Agency wake: CTO', workspace: 'ops', summary: 'Full run text: read 4 cards, closed 2, started #40.',
  review_note: 'Closed 2 cards and started the importer.', wake_spent_usd: 0.5, ceiling_usd: 10,
  children: [{ id: 40, title: 'Ship the importer', status: 'working', pr_url: 'https://github.com/acme/repo/pull/80', spent_usd: 4 }], updated_at: '2026-11-15 09:30:00',
}
const msg = (id: number, content: string, meta: Record<string, unknown> | null = null) => ({
  id, role: 'assistant', content, provider: 'demo', model: 'scripted', tool_name: null, meta, created_at: '2026-11-15 09:00:00',
})
const MESSAGES = [
  msg(1, 'Earlier answer'),
  msg(2, 'Your job finished — card #37', { bot_job: 37, activity_feed: true }),
  msg(3, 'Your job finished — card #38', { bot_job: 38, activity_feed: true }),
  msg(4, 'CTO needs a decision from you on card #41 "Pick a vendor".', { kind: 'bot_needs_you', objective_id: 41, reason: 'decision', title: 'Pick a vendor' }),
  msg(5, 'CTO needs you: card #40 "Ship the importer" has spent $12.50 against its $10.00 ceiling.', { kind: 'bot_needs_you', objective_id: 40, reason: 'over_ceiling', title: 'Ship the importer', spent_usd: 12.5, ceiling_usd: 10 }),
]

let calls: { url: string; method: string; body: unknown }[] = []
let root: Root
let host: HTMLDivElement
let location = ''

function LocationProbe() {
  const l = useLocation()
  location = `${l.pathname}${l.search}`
  return null
}

async function mount(path: string) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const { AgentChatPage } = await import('./AgentChatPage')
  root.render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/chat" element={<AgentChatPage />} />
        <Route path="/chat/:slug" element={<AgentChatPage />} />
      </Routes>
    </MemoryRouter>,
  )
  await settle()
}

const tab = (name: string) => [...host.querySelectorAll<HTMLElement>('[data-testid="bot-view-tabs"] [role="tab"]')].find(t => (t.textContent ?? '').startsWith(name))!
const button = (name: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(b => (b.textContent ?? '').trim() === name)

beforeEach(() => {
  calls = []
  vi.stubGlobal('WebSocket', class { close() {} send() {} readyState = 0 })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url, method, body })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') return json({ agents, demo: false, providers: { demo: true }, default_provider: null })
    if (url === '/api/agent-chat/bot-status') return json(STATUS)
    if (url === '/api/agent-chat/agents/cto/work') return json(WORK)
    if (url === '/api/agent-chat/agents/cto/activity') return json(ACTIVITY)
    if (url === '/api/agent-chat/agents/cto/activity/90') return json({ run: RUN })
    if (url === '/api/agent-chat/sidebar') return json({ sections: [], bots: {}, max_pins: 12, max_sections: 20 })
    if (url.includes('/threads')) return json({ threads: [], max_open: 10 })
    if (url.includes('/agent-chat/agents/cto/messages')) return json({ messages: MESSAGES, drafts: [], cards: [] })
    if (url.includes('/messages')) return json({ messages: [], drafts: [], cards: [] })
    if (url.startsWith('/api/objectives/')) return json({ ok: true })
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

describe('sidebar: live line, status dot, "Needs you" across bots', () => {
  it('shows each bot\'s line under its name with a running / waiting / idle dot', async () => {
    await mount('/chat')
    const line = (slug: string) => host.querySelector(`li[data-bot="${slug}"] [data-testid="bot-live-line"]`) as HTMLElement
    expect(line('okit-dev').textContent).toContain('Working on #900936 · 2 in review')
    expect(line('okit-dev').querySelector('[data-testid="bot-status-dot"]')!.getAttribute('data-state')).toBe('running')
    expect(line('cto').querySelector('[data-testid="bot-status-dot"]')!.getAttribute('data-state')).toBe('waiting')
    expect(line('cto').querySelector('[data-testid="bot-status-dot"]')!.textContent).toBe('Waiting on you')
    expect(line('helper').textContent).toContain('Idle')
    expect(line('helper').querySelector('[data-testid="bot-status-dot"]')!.getAttribute('data-state')).toBe('idle')
  })

  it('the header counts cards needing you across every bot and opens the first bot\'s Work tab', async () => {
    await mount('/chat')
    const needs = host.querySelector('[data-testid="bots-needs-you"]') as HTMLButtonElement
    expect(needs.textContent).toContain('3')
    expect(needs.textContent).toContain('Needs you')
    needs.click()
    await settle()
    expect(location).toBe('/chat/cto?view=work')
    expect(tab('Work').getAttribute('aria-selected')).toBe('true')
  })

  it('an older server without /bot-status leaves the rows exactly as before', async () => {
    const real = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === '/api/agent-chat/bot-status' ? new Response('not found', { status: 404 }) : real(url, init))))
    await mount('/chat')
    expect(host.querySelector('[data-testid="bot-live-line"]')).toBeNull()
    expect(host.querySelector('[data-testid="bots-needs-you"]')).toBeNull()
  })
})

describe('Work tab', () => {
  it('groups the cards Running / In review / Queued / Recently done, with spend vs ceiling and the PR', async () => {
    await mount('/chat/cto?view=work')
    const tabEl = host.querySelector('[data-testid="bot-work-tab"]')!
    expect(tabEl).not.toBeNull()
    const ids = (g: string) => [...host.querySelectorAll(`[data-testid="work-group-${g}"] [data-testid="work-card"]`)].map(li => Number(li.getAttribute('data-card')))
    expect(ids('running')).toEqual([40])
    expect(ids('review')).toEqual([41, 43])
    expect(ids('queued')).toEqual([])
    expect(ids('done')).toEqual([39])
    expect(host.querySelector('[data-testid="work-group-queued"]')!.textContent).toContain('Nothing queued.')
    const over = host.querySelector('[data-card="40"]')!
    expect(over.querySelector('[data-testid="spend-meter"]')!.getAttribute('data-over')).toBe('1')
    expect(over.textContent).toContain('$12.50 of $10.00')
    expect(over.textContent).toContain('Over its spend ceiling')
    const review = host.querySelector('[data-card="41"]')!
    expect(review.querySelector('[data-testid="spend-meter"]')!.textContent).toContain('$1.00 of $10.00 · default for normal effort')
    expect((review.querySelector('[data-testid="work-card-pr"]') as HTMLAnchorElement).href).toBe('https://github.com/acme/repo/pull/77')
    expect(review.textContent).toContain('Needs a decision')
    expect(review.querySelector('[data-testid="work-card-review-stage"]')).toBeNull()
    const waiting = host.querySelector('[data-card="43"]')!
    expect(waiting.textContent).not.toContain('Needs a decision')
    expect(waiting.querySelector('[data-testid="work-card-review-stage"]')!.textContent).toBe('Waiting on AI review')
    expect((host.querySelector('[data-testid="work-open-board"]') as HTMLAnchorElement).getAttribute('href')).toBe('/?owner=bot%3AGrok%3A%20CTO')
  })

  it('switching views updates the URL and only the chat view has the composer', async () => {
    await mount('/chat/cto')
    expect(host.querySelector('#agent-chat-input')).not.toBeNull()
    tab('Work').click()
    await settle()
    expect(location).toBe('/chat/cto?view=work')
    expect(host.querySelector('#agent-chat-input')).toBeNull()
    tab('Chat').click()
    await settle()
    expect(location).toBe('/chat/cto')
  })
})

describe('Activity feed', () => {
  it('puts the daily summary on top: shipped, spend, next', async () => {
    await mount('/chat/cto?view=activity')
    const s = host.querySelector('[data-testid="activity-summary"]')!
    expect(s.querySelector('[data-testid="summary-shipped"]')!.textContent).toContain('#39 Fix login')
    expect(s.querySelector('[data-testid="summary-spend"]')!.textContent).toBe('$7.25')
    expect(s.querySelector('[data-testid="summary-next"]')!.textContent).toContain('2 cards need you')
    expect(s.querySelector('[data-testid="summary-next"]')!.textContent).toContain('#42 Write the runbook')
  })

  it('one entry per wake; an entry expands into the full run and collapses again', async () => {
    await mount('/chat/cto?view=activity')
    const entries = [...host.querySelectorAll('[data-testid="activity-entry"]')]
    expect(entries.map(e => e.getAttribute('data-wake'))).toEqual(['90', '89'])
    const first = entries[0]
    expect(first.textContent).toContain('Closed 2 cards and started the importer.')
    expect(first.textContent).toContain('Picked #40 Ship the importer')
    expect(first.textContent).toContain('$4.50')
    expect(entries[1].textContent).toContain('Needs a decision')
    const toggle = first.querySelector('button[aria-expanded]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(first.querySelector('[data-testid="activity-run"]')).toBeNull()

    toggle.click()
    await settle()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const run = first.querySelector('[data-testid="activity-run"]')!
    expect(run.textContent).toContain('Full run text: read 4 cards, closed 2, started #40.')
    expect(run.textContent).toContain('#40 Ship the importer')
    expect(calls.some(c => c.url === '/api/agent-chat/agents/cto/activity/90')).toBe(true)

    toggle.click()
    await settle()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(first.querySelector('[data-testid="activity-run"]')).toBeNull()
  })
})

describe('main chat: needs-you posts and folded High Agency history', () => {
  it('older High Agency updates fold into one row that can be shown again; nothing is deleted', async () => {
    await mount('/chat/cto')
    const folded = host.querySelector('[data-testid="folded-activity"]')!
    expect(folded.textContent).toContain('2 High Agency updates — now in Activity')
    expect(host.textContent).not.toContain('Your job finished — card #37')
    button('Show', folded)!.click()
    await settle()
    expect(host.textContent).toContain('Your job finished — card #37')
    expect(host.textContent).toContain('Your job finished — card #38')
    button('Open Activity', folded)!.click()
    await settle()
    expect(location).toBe('/chat/cto?view=activity')
  })

  it('a decision post: Approve sends an approval to the card through the existing message route', async () => {
    await mount('/chat/cto')
    const post = host.querySelector('[data-testid="needs-you-message"][data-reason="decision"]')!
    expect(post.textContent).toContain('Needs you · Needs a decision')
    button('Approve', post)!.click()
    await settle()
    const sent = calls.find(c => c.method === 'POST' && c.url === '/api/objectives/41/message')!
    expect(sent.body).toEqual({ message: 'Approved: go ahead with what you proposed on card #41.' })
    expect(post.textContent).toContain('Approval sent to card #41.')
  })

  it('Reply sends the typed text to the card', async () => {
    await mount('/chat/cto')
    const post = host.querySelector('[data-testid="needs-you-message"][data-reason="decision"]')!
    button('Reply', post)!.click()
    await settle()
    const box = post.querySelector('textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(box, 'Go with vendor B')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    button('Send reply', post)!.click()
    await settle()
    const sent = calls.find(c => c.method === 'POST' && c.url === '/api/objectives/41/message')!
    expect(sent.body).toEqual({ message: 'Go with vendor B' })
  })

  it('an over-ceiling post: Approve raises the ceiling through the existing spend route', async () => {
    await mount('/chat/cto')
    const post = host.querySelector('[data-testid="needs-you-message"][data-reason="over_ceiling"]')!
    button('Approve', post)!.click()
    await settle()
    const input = post.querySelector('input[type="number"]') as HTMLInputElement
    expect(input.value).toBe('20')
    button('Raise ceiling', post)!.click()
    await settle()
    const put = calls.find(c => c.method === 'PUT' && c.url === '/api/objectives/40/spend')!
    expect(put.body).toEqual({ cost_usd: 20 })
    expect(calls.some(c => c.method === 'POST' && c.url === '/api/objectives/40/message')).toBe(false)
  })
})
