// @vitest-environment jsdom
//
// Jobs → Merged, waiting for deploy (obj 901389). Read-only list of merged PRs
// that are not live yet, with the migration flag and who merged them. Fake data only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { DeployWaitingPanel, type ChatDeployView, type DeployStatusView } from './DeployWaitingPanel'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

const { store, apiMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message)
    }
  }
  const store: { state: unknown; chat: unknown } = { state: null, chat: null }
  const apiMock = {
    get: vi.fn((p: string) => Promise.resolve(structuredClone(p === '/admin/chat-deploy' ? store.chat : store.state))),
    put: vi.fn((_p: string, body: { enabled: boolean }) => Promise.resolve({ ...(structuredClone(store.chat) as object), enabled: body.enabled })),
    post: vi.fn(),
  }
  return { store, apiMock, ApiErrorMock }
})
vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  apiMock.get.mockClear()
  apiMock.put.mockClear()
  apiMock.post.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  flushSync(() => root.unmount())
  host.remove()
})

const WAITING: DeployStatusView = {
  ok: true,
  live: false,
  checkout_at_origin_main: false,
  server_started_after_last_merge: false,
  server_started_at: '2026-11-18T10:00:00Z',
  last_merge_at: '2026-11-18T12:00:00Z',
  migrations_waiting: 1,
  summary: '2 merged pull requests are waiting for a deploy (1 with a database migration).',
  note: 'Read-only. Nothing here deploys or restarts anything; the owner deploys.',
  waiting: [
    { sha: 'c'.repeat(40), short_sha: 'cccccccc', committed_at: '2026-11-18T12:00:00Z', pr_number: 102, pr_url: 'https://github.com/acme/app/pull/102', title: 'Add things table', card_id: 777, card_title: 'Things', merged_by: { kind: 'bot_grant' }, merged_by_label: 'Operation Kit Dev (bot) under grant #4', migration: true, migration_paths: ['app/server/src/db/schema/things.ts'] },
    { sha: 'd'.repeat(40), short_sha: 'dddddddd', committed_at: '2026-11-18T11:00:00Z', pr_number: 101, pr_url: 'https://github.com/acme/app/pull/101', title: 'Show the thing', card_id: null, card_title: null, merged_by: { kind: 'person' }, merged_by_label: 'operator', migration: false, migration_paths: [] },
  ],
}

const CHAT_OFF: ChatDeployView = { enabled: false, can_manage: true, bots: ['operation-kit-dev'], last: null }

async function render(state: unknown, chat: ChatDeployView = CHAT_OFF) {
  store.state = state
  store.chat = chat
  flushSync(() => root.render(<DeployWaitingPanel />))
  await flush()
}

describe('DeployWaitingPanel', () => {
  it('lists each waiting PR with its card, who merged it and the migration flag', async () => {
    await render(WAITING)
    expect(apiMock.get).toHaveBeenCalledWith('/admin/deploy-status')
    const text = host.textContent ?? ''
    expect(text).toContain('Merged, waiting for deploy')
    expect(text).toContain('2 merged pull requests are waiting for a deploy (1 with a database migration).')
    const rows = host.querySelectorAll('[aria-label="Merged pull requests waiting for a deploy"] > li')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('PR #102')
    expect(rows[0].textContent).toContain('Add things table')
    expect(rows[0].textContent).toContain('Database migration')
    expect(rows[0].textContent).toContain('Card #777')
    expect(rows[0].textContent).toContain('Merged by Operation Kit Dev (bot) under grant #4')
    expect(rows[0].textContent).toContain('app/server/src/db/schema/things.ts')
    expect(rows[1].textContent).toContain('PR #101')
    expect(rows[1].textContent).not.toContain('Database migration')
    expect(rows[1].textContent).toContain('Merged by operator')
    expect((rows[0].querySelector('a[href="/o/777"]'))).not.toBeNull()
  })

  it('is read-only: no deploy or restart control, and no write calls', async () => {
    await render(WAITING)
    // The one switch is the "deploy on your word" SETTING (obj 901393), not a deploy button.
    const buttons = Array.from(host.querySelectorAll('button:not([role="switch"])')).map(b => b.textContent?.trim())
    expect(buttons).toEqual(['Refresh'])
    expect(buttons.some(b => /deploy|restart/i.test(b ?? ''))).toBe(false)
    expect(apiMock.put).not.toHaveBeenCalled()
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('says when nothing is waiting and main is live', async () => {
    await render({ ...WAITING, waiting: [], live: true, migrations_waiting: 0, checkout_at_origin_main: true, server_started_after_last_merge: true, summary: 'Everything merged to main is live: the checkout is at origin/main and the server started after the last merge.' })
    const text = host.textContent ?? ''
    expect(text).toContain('Everything merged to main is live')
    expect(text).toContain('Nothing is waiting')
    expect(host.querySelector('[aria-label="Merged pull requests waiting for a deploy"]')).toBeNull()
  })

  it('shows the reason when the checkout cannot be read', async () => {
    await render({ ok: false, disabled: true, error: 'This install runs from an image (DRIFT_GUARD=off): there is no live checkout to compare with main.', waiting: [] })
    expect(host.textContent).toContain('there is no live checkout')
  })

  it('deploy on your word: off by default, the owner switches it on, nothing deploys', async () => {
    await render(WAITING)
    expect(apiMock.get).toHaveBeenCalledWith('/admin/chat-deploy')
    expect(host.textContent).toContain('Deploy on your word')
    const sw = host.querySelector('[role="switch"]') as HTMLButtonElement
    expect(sw).not.toBeNull()
    expect(sw.getAttribute('aria-checked')).toBe('false')
    flushSync(() => sw.click())
    await flush()
    expect(apiMock.put).toHaveBeenCalledWith('/admin/chat-deploy', { enabled: true })
    expect(apiMock.post).not.toHaveBeenCalled()
    expect((host.querySelector('[role="switch"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
  })

  it('deploy on your word: a non-owner sees it disabled', async () => {
    await render(WAITING, { ...CHAT_OFF, can_manage: false })
    const sw = host.querySelector('[role="switch"]') as HTMLButtonElement
    expect(sw.disabled || sw.getAttribute('aria-disabled') === 'true' || sw.hasAttribute('data-disabled')).toBe(true)
    expect(host.textContent).toContain('Only the owner')
  })

  it('shows the last chat deploy and its outcome', async () => {
    await render(WAITING, {
      ...CHAT_OFF,
      enabled: true,
      last: {
        id: 7, username: 'operator', agent_slug: 'operation-kit-dev', bot_name: 'Operation Kit Dev', mode: 'backend',
        outcome: 'rolled_back', reason: null, detail: 'The server did not come back healthy, so it was rolled back to aaaaaaaa.',
        prs: [{ pr_number: 101, title: 'Show the thing', card_id: 777, short_sha: 'dddddddd' }],
        created_at: '2026-11-18T12:30:00Z', finished_at: '2026-11-18T12:32:00Z',
      },
    })
    const last = host.querySelector('[aria-label="Last chat deploy"]')
    expect(last?.textContent).toContain('Last chat deploy #7')
    expect(last?.textContent).toContain('Rolled back')
    expect(last?.textContent).toContain("Operation Kit Dev on operator's word")
    expect(last?.textContent).toContain('PR #101')
    expect(last?.textContent).toContain('rolled back to aaaaaaaa')
  })
})
