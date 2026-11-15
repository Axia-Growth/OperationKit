import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { FlowToolsInput } from './FlowToolsInput'

/**
 * obj 900911 — the Tools field can list the Tools a workflow step can call in
 * this workspace (GET /api/flows/tools), add one, and (owner) switch it on.
 * Nothing is fetched until the builder opens the list.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
const fetchMock = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const TOOLS = (enabled: boolean, canManage: boolean) => ({
  workspace: 'acme',
  flows_enabled: true,
  can_manage: canManage,
  tools: [
    { slug: 'post-note', effect: 'send', idempotent: false, description: 'Posts a note to the team channel.', source: 'okit', runner: 'http', enabled },
    { slug: 'rows-count', effect: 'read', idempotent: true, description: null, source: 'okit', runner: 'script', enabled: true },
  ],
})

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

function render(value: string[], onChange = vi.fn()) {
  act(() => { root.render(<FlowToolsInput id="t" value={value} onChange={onChange} workspace="acme" />) })
  return onChange
}

function openList() {
  const btn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Tools a step can call'))!
  act(() => { btn.click() })
}

describe('FlowToolsInput — Tools a step can call', () => {
  it('fetches nothing until opened, then lists each Tool in plain words with its workspace state', async () => {
    const onChange = render([])
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(ok(TOOLS(false, false)))
    openList()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/flows/tools?workspace=acme')
    const note = host.querySelector('[data-testid="flow-tool-post-note"]')!
    expect(note.textContent).toContain('Sends messages')
    expect(note.textContent).toContain('Off for this workspace')
    expect(note.textContent).toContain('Posts a note to the team channel.')
    expect(host.querySelector('[data-testid="flow-tool-rows-count"]')!.textContent).toContain('Reads data, safe to retry')
    // a member sees no switch
    expect(host.querySelector('[role="switch"]')).toBeNull()
    act(() => { (note.querySelector('button[aria-label="Add post-note"]') as HTMLButtonElement).click() })
    expect(onChange).toHaveBeenCalledWith(['post-note'])
  })

  it('an owner can switch a Tool on for the workspace', async () => {
    render(['post-note'])
    fetchMock.mockResolvedValueOnce(ok(TOOLS(false, true)))
    openList()
    await flush()
    expect(host.querySelector('button[aria-label="post-note added"]')).not.toBeNull()
    fetchMock.mockResolvedValueOnce(ok(TOOLS(true, true)))
    const sw = host.querySelector('[data-testid="flow-tool-post-note"] [role="switch"]') as HTMLElement
    act(() => { sw.click() })
    await flush()
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/flows/tools/post-note/enabled')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ workspace: 'acme', enabled: true })
    expect(host.querySelector('[data-testid="flow-tool-post-note"]')!.textContent).toContain('On for this workspace')
  })
})
