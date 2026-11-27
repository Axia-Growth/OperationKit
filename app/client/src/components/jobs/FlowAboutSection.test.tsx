import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { FlowAboutSection } from './FlowAboutSection'

/** obj 900868 — Notes + Tools are shown on a workflow and edited in place (PATCH /api/flows/:id). */

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

const q = <T extends Element>(sel: string) => host.querySelector(sel) as T | null
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === label) as HTMLButtonElement

describe('FlowAboutSection', () => {
  it('shows the goal, notes and tools', () => {
    act(() => root.render(<FlowAboutSection flow={{ id: 4, name: 'Triage', notes: 'Skip tests.', tools: ['HubSpot', 'Slack'] }} goal="Every booking is in the CRM" />))
    expect(host.textContent).toContain('Every booking is in the CRM')
    expect(q('[data-testid="flow-about-notes"]')?.textContent).toBe('Skip tests.')
    expect(Array.from(host.querySelectorAll('ul[aria-label="Tools"] li')).map(li => li.textContent)).toEqual(['HubSpot', 'Slack'])
  })

  it('says so plainly when there are none', () => {
    act(() => root.render(<FlowAboutSection flow={{ id: 4, name: 'Triage', notes: null, tools: [] }} goal={null} />))
    expect(host.textContent).toContain('No notes yet.')
    expect(host.textContent).toContain('No tools listed.')
  })

  it('edits and saves through PATCH /api/flows/:id, then shows what the server stored', async () => {
    const saved = vi.fn()
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ ok: true, flow: { id: 4, name: 'Triage', notes: 'Run after 8am.', tools: ['Slack', 'Notion'] } }),
    })
    act(() => root.render(<FlowAboutSection flow={{ id: 4, name: 'Triage', notes: null, tools: ['Slack'] }} goal={null} onSaved={saved} />))
    act(() => q<HTMLButtonElement>('[data-testid="flow-about-edit"]')!.click())
    const tools = q<HTMLInputElement>('[data-testid="flow-tools-input"] input')!
    act(() => {
      type(q<HTMLTextAreaElement>('textarea')!, 'Run after 8am.')
      type(tools, 'Notion')
    })
    act(() => { tools.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await act(async () => { button('Save').click() })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/flows/4')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ notes: 'Run after 8am.', tools: ['Slack', 'Notion'] })
    expect(saved).toHaveBeenCalled()
    expect(q('[data-testid="flow-about-form"]')).toBeNull()
    expect(q('[data-testid="flow-about-notes"]')?.textContent).toBe('Run after 8am.')
  })

  it('removing a tool chip drops it from the list sent', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, flow: { id: 4, name: 'T', notes: null, tools: ['HubSpot'] } }) })
    act(() => root.render(<FlowAboutSection flow={{ id: 4, name: 'T', notes: null, tools: ['HubSpot', 'Slack'] }} goal={null} />))
    act(() => q<HTMLButtonElement>('[data-testid="flow-about-edit"]')!.click())
    act(() => q<HTMLButtonElement>('[aria-label="Remove Slack"]')!.click())
    await act(async () => { button('Save').click() })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools).toEqual(['HubSpot'])
  })

  it('shows the server error and keeps the form open', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "No access to workspace 'beta'" }) })
    act(() => root.render(<FlowAboutSection flow={{ id: 4, name: 'T', notes: null, tools: [] }} goal={null} />))
    act(() => q<HTMLButtonElement>('[data-testid="flow-about-edit"]')!.click())
    await act(async () => { button('Save').click() })
    expect(host.textContent).toContain("No access to workspace 'beta'")
    expect(q('[data-testid="flow-about-form"]')).not.toBeNull()
  })

  it('obj 901766: shows "Done when" in the person\'s words when the workflow has one', () => {
    act(() => root.render(<FlowAboutSection flow={{ id: 4, name: 'Triage', notes: null, tools: [] }} goal="Triage bookings" doneWhen="Every booking has a category." />))
    expect(q('[data-testid="flow-about-done-when"]')?.textContent).toContain('Every booking has a category.')
    act(() => root.render(<FlowAboutSection flow={{ id: 4, name: 'Triage', notes: null, tools: [] }} goal="Triage bookings" />))
    expect(q('[data-testid="flow-about-done-when"]')).toBeNull()
  })
})
