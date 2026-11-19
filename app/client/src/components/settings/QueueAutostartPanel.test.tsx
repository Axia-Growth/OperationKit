// @vitest-environment jsdom
//
// Jobs → Queue auto-start (was Settings → Platform) (obj 900625): one switch per workspace,
// PUT on toggle, env-set workspaces locked, missing-ceiling warning. Fake data only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { QueueAutostartPanel, type QueueAutostartState } from './QueueAutostartPanel'

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
  const store: { state: unknown } = { state: null }
  const apiMock = {
    get: vi.fn(() => Promise.resolve(structuredClone(store.state))),
    put: vi.fn(),
  }
  return { store, apiMock, ApiErrorMock }
})

vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }))
vi.mock('../../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ slugs: ['all', 'operationkit', 'client-a', 'env-ws'], labelOf: (s: string) => s.toUpperCase() }),
}))

function stateWith(
  workspaces: QueueAutostartState['workspaces'],
  time_limits: QueueAutostartState['time_limits'] = {},
): QueueAutostartState {
  return { workspaces, max_concurrent: 4, max_concurrent_source: 'default', in_flight: 1, grace_minutes: 1, time_limits }
}

const ON = (workspace: string, over: Partial<QueueAutostartState['workspaces'][number]> = {}) => ({
  workspace,
  enabled: true,
  source: 'setting' as const,
  enabled_at: '2026-11-12 05:00:00',
  ceiling_policy: 'enforce' as const,
  ceiling_policy_source: 'default:queue_autostart',
  ceiling_configured: true,
  ceiling_source: `workspace:${workspace}`,
  ...over,
})

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  apiMock.get.mockClear()
  apiMock.put.mockReset()
})

afterEach(() => {
  root.unmount()
  host.remove()
})

function switches() {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="switch"]'))
}

function timeLimitInput(label: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(`input[aria-label="Job time limit in minutes for ${label}"]`)
  if (!el) throw new Error(`no time limit input for ${label}`)
  return el
}

function timeLimitSaveButton(label: string): HTMLButtonElement {
  const row = timeLimitInput(label).closest('li')
  const btn = row?.querySelector<HTMLButtonElement>('button:not([role="switch"])')
  if (!btn) throw new Error(`no save button for ${label}`)
  return btn
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('QueueAutostartPanel', () => {
  it('lists every workspace (not "all") with its state', async () => {
    store.state = stateWith([ON('operationkit'), ON('env-ws', { source: 'env' })])
    flushSync(() => root.render(<QueueAutostartPanel />))
    await flush()
    expect(apiMock.get).toHaveBeenCalledWith('/admin/queue-autostart')
    const s = switches()
    expect(s.map(b => b.getAttribute('aria-label'))).toEqual([
      'Queue auto-start for OPERATIONKIT',
      'Queue auto-start for CLIENT-A',
      'Queue auto-start for ENV-WS',
    ])
    expect(s.map(b => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true'])
    // An env-enabled workspace cannot be switched off from the UI.
    expect(s[2].disabled).toBe(true)
    expect(host.textContent).toContain('Set by server env')
    expect(host.textContent).toContain('At most 4 auto-started cards run at once (1 running now)')
  })

  it('PUTs the toggle and renders the returned state', async () => {
    store.state = stateWith([])
    apiMock.put.mockResolvedValue(stateWith([ON('client-a', { ceiling_configured: false, ceiling_source: 'none' })]))
    flushSync(() => root.render(<QueueAutostartPanel />))
    await flush()
    switches()[1].click()
    await flush()
    expect(apiMock.put).toHaveBeenCalledWith('/admin/queue-autostart/client-a', { enabled: true })
    expect(switches()[1].getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('No job ceiling — cards will not start')
  })

  it('shows the error when the save fails', async () => {
    store.state = stateWith([])
    apiMock.put.mockRejectedValue(new ApiErrorMock(500, null, 'boom'))
    flushSync(() => root.render(<QueueAutostartPanel />))
    await flush()
    switches()[0].click()
    await flush()
    expect(host.textContent).toContain('boom')
  })

  describe('job time limit', () => {
    it('shows the current value, or "No limit set" when empty', async () => {
      store.state = stateWith([ON('operationkit')], {
        operationkit: { minutes: 30, source: 'workspace' },
        'client-a': { minutes: null, source: 'none' },
      })
      flushSync(() => root.render(<QueueAutostartPanel />))
      await flush()
      expect(timeLimitInput('OPERATIONKIT').value).toBe('30')
      expect(timeLimitInput('CLIENT-A').value).toBe('')
      expect(host.textContent).toContain('No limit set')
    })

    it('saves a new value and disables Save until the field is dirty again', async () => {
      store.state = stateWith([ON('operationkit')], { operationkit: { minutes: null, source: 'none' } })
      apiMock.put.mockResolvedValue(
        stateWith([ON('operationkit')], { operationkit: { minutes: 30, source: 'workspace' } }),
      )
      flushSync(() => root.render(<QueueAutostartPanel />))
      await flush()
      const input = timeLimitInput('OPERATIONKIT')
      const save = timeLimitSaveButton('OPERATIONKIT')
      expect(save.disabled).toBe(true)
      setInput(input, '30')
      await flush()
      expect(save.disabled).toBe(false)
      save.click()
      await flush()
      expect(apiMock.put).toHaveBeenCalledWith('/admin/queue-autostart/operationkit/time-limit', { minutes: 30 })
      expect(timeLimitInput('OPERATIONKIT').value).toBe('30')
      expect(timeLimitSaveButton('OPERATIONKIT').disabled).toBe(true)
    })

    it('clearing the field saves null', async () => {
      store.state = stateWith([ON('operationkit')], { operationkit: { minutes: 30, source: 'workspace' } })
      apiMock.put.mockResolvedValue(
        stateWith([ON('operationkit')], { operationkit: { minutes: null, source: 'none' } }),
      )
      flushSync(() => root.render(<QueueAutostartPanel />))
      await flush()
      setInput(timeLimitInput('OPERATIONKIT'), '')
      await flush()
      timeLimitSaveButton('OPERATIONKIT').click()
      await flush()
      expect(apiMock.put).toHaveBeenCalledWith('/admin/queue-autostart/operationkit/time-limit', { minutes: null })
      expect(host.textContent).toContain('No limit set')
    })

    it('rejects a non-integer without calling the API', async () => {
      store.state = stateWith([ON('operationkit')], { operationkit: { minutes: null, source: 'none' } })
      flushSync(() => root.render(<QueueAutostartPanel />))
      await flush()
      setInput(timeLimitInput('OPERATIONKIT'), '2.5')
      await flush()
      timeLimitSaveButton('OPERATIONKIT').click()
      await flush()
      expect(apiMock.put).not.toHaveBeenCalled()
      expect(host.textContent).toContain('whole number of minutes')
    })
  })
})
