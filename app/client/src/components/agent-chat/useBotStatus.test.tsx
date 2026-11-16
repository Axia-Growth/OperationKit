// @vitest-environment jsdom
/*
 * obj 901025: the sidebar row and chat header read their Working/Idle state
 * from useBotStatus(). The server now pushes an `agent_chat_unread` ping the
 * instant a chat turn starts and the instant it ends (engine.ts runTurn), on
 * top of the existing 30s poll. This proves the hook re-reads bot-status on
 * that push — during a turn, after a stop, and after an error — rather than
 * waiting out the full poll interval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { useBotStatus } from './useBotStatus'
import { dispatchServerMessage } from '../../hooks/useWebSocket'

async function flush() {
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  flushSync(() => {})
  await Promise.resolve()
}

let host: HTMLElement | null = null
let root: Root | null = null

// Each test's Probe must be unmounted before the next, or its effect cleanup
// (clearInterval + the subscribeServerMessages `off()`) never runs and it
// keeps consuming `responses` meant for the next test's component.
function mount(node: ReactNode): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  flushSync(() => root!.render(node))
  return host
}

const idleStatus = {
  bots: { quiet: { slug: 'quiet', state: 'idle', line: 'Idle', focus_id: null, counts: { running: 0, review: 0, queued: 0, done: 0, needs_you: 0 } } },
  needs_you_total: 0,
}
const workingStatus = {
  bots: { quiet: { slug: 'quiet', state: 'running', line: 'Working', focus_id: null, counts: { running: 0, review: 0, queued: 0, done: 0, needs_you: 0 } } },
  needs_you_total: 0,
}

let responses: Array<typeof idleStatus>
let latest: ReturnType<typeof useBotStatus>['status'] = null

function Probe() {
  const { status } = useBotStatus()
  latest = status
  return <span data-testid="state">{status?.bots.quiet?.state ?? ''}</span>
}

beforeEach(() => {
  latest = null
  responses = [idleStatus]
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/agent-chat/bot-status') {
      const body = responses.shift() ?? responses[responses.length - 1] ?? idleStatus
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => {
  flushSync(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

describe('useBotStatus: live push around a chat turn (obj 901025)', () => {
  it('reads Idle on first load, then Working the instant the turn-start push lands', async () => {
    mount(<Probe />)
    await flush()
    expect(latest?.bots.quiet.state).toBe('idle')

    responses = [workingStatus]
    dispatchServerMessage({ type: 'agent_chat_unread', payload: { user_id: 1, agent_slug: 'quiet' } })
    await flush()
    expect(latest?.bots.quiet.state).toBe('running')
    expect(latest?.bots.quiet.line).toBe('Working')
  })

  it('goes back to Idle on the push that follows a Stop', async () => {
    mount(<Probe />)
    await flush()
    responses = [workingStatus]
    dispatchServerMessage({ type: 'agent_chat_unread', payload: { user_id: 1, agent_slug: 'quiet' } })
    await flush()
    expect(latest?.bots.quiet.state).toBe('running')

    // Stop lands: the turn's `finally` block pushes the same event once the
    // lane is idle again.
    responses = [idleStatus]
    dispatchServerMessage({ type: 'agent_chat_unread', payload: { user_id: 1, agent_slug: 'quiet' } })
    await flush()
    expect(latest?.bots.quiet.state).toBe('idle')
  })

  it('goes back to Idle on the push that follows a failed turn, never sticks on Working', async () => {
    mount(<Probe />)
    await flush()
    responses = [workingStatus]
    dispatchServerMessage({ type: 'agent_chat_unread', payload: { user_id: 1, agent_slug: 'quiet' } })
    await flush()
    expect(latest?.bots.quiet.state).toBe('running')

    responses = [idleStatus]
    dispatchServerMessage({ type: 'agent_chat_unread', payload: { user_id: 1, agent_slug: 'quiet' } })
    await flush()
    expect(latest?.bots.quiet.state).toBe('idle')
  })
})
