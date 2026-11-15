import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { NewWorkflowDialog, parseAsserts } from './NewWorkflowDialog'

/**
 * obj 900642 (card B6) — "New workflow" posts a GOAL (not JSON) to POST /api/flows
 * and shows the builder card it filed. The server builds the brief and enforces
 * the workspace; this checks the dialog sends the right request and keeps what
 * the user typed while the board re-renders.
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

const q = <T extends Element>(sel: string) => document.body.querySelector(sel) as T | null

/** React tracks the value through its own setter; set it the way a keystroke would. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function render(props: Partial<Parameters<typeof NewWorkflowDialog>[0]> = {}) {
  act(() => {
    root.render(
      <NewWorkflowDialog open onClose={() => {}} workspaces={['acme', 'beta']} defaultWorkspace="beta" {...props} />,
    )
  })
}

describe('NewWorkflowDialog', () => {
  it('parses one end-condition assert per non-empty line', () => {
    expect(parseAsserts('  \n')).toBeUndefined()
    expect(parseAsserts('a == 1\n\n  len(b) > 0 ')).toEqual({ assert: [{ expr: 'a == 1' }, { expr: 'len(b) > 0' }] })
  })

  it('posts the goal, name, workspace, end condition and builder budget, then shows the builder card', async () => {
    fetchMock.mockResolvedValue({
      status: 201,
      json: async () => ({
        flow_id: 9, slug: 'triage', workspace: 'beta', objective_id: 321,
        builder: { objective_id: 321, status: 'queue', max_iterations: 4, queue_hold: null },
      }),
    })
    const onCreated = vi.fn()
    render({ onCreated })
    const submit = q<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true) // no goal yet
    expect(q<HTMLElement>('button[role="combobox"]')!.textContent).toContain('beta')

    act(() => {
      type(q<HTMLTextAreaElement>('textarea')!, 'Triage yesterday\'s bookings into the CRM')
      type(q<HTMLInputElement>('input[maxlength="120"]')!, 'Booking triage')
      type(document.body.querySelectorAll('textarea')[1] as HTMLTextAreaElement, 'steps.check.output.ok == true')
      type(q<HTMLInputElement>('input[type="number"]')!, '4')
    })
    await act(async () => { q<HTMLButtonElement>('button[type="submit"]')!.click() })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/flows')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      workspace: 'beta',
      goal: "Triage yesterday's bookings into the CRM",
      name: 'Booking triage',
      end_condition: { assert: [{ expr: 'steps.check.output.ok == true' }] },
      builder: { max_iterations: 4 },
    })
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ flow_id: 9, objective_id: 321 }))
    expect(q('[data-testid="new-workflow-created"]')?.textContent).toContain('triage')
    expect(document.body.textContent).toContain('Open builder card #321')
  })

  it('shows the server error and stays on the form', async () => {
    fetchMock.mockResolvedValue({ status: 403, json: async () => ({ error: "No access to workspace 'beta'" }) })
    render()
    act(() => type(q<HTMLTextAreaElement>('textarea')!, 'goal'))
    await act(async () => { q<HTMLButtonElement>('button[type="submit"]')!.click() })
    expect(document.body.textContent).toContain("No access to workspace 'beta'")
    expect(q('[data-testid="new-workflow-created"]')).toBeNull()
  })

  it('keeps what the user typed when the parent re-renders with a fresh workspaces array', () => {
    render()
    act(() => type(q<HTMLTextAreaElement>('textarea')!, 'half-written goal'))
    render({ workspaces: ['acme', 'beta'] }) // new array identity, as the live board does every few seconds
    expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('half-written goal')
  })

  it("obj 900868: sends optional Notes and Tools (typed tools become a clean list)", async () => {
    fetchMock.mockResolvedValue({
      status: 201,
      json: async () => ({ flow_id: 9, slug: "t", workspace: "beta", objective_id: 1, builder: { objective_id: 1, status: "queue", max_iterations: 6, queue_hold: null } }),
    })
    render()
    const toolsInput = q<HTMLInputElement>("[data-testid=\"flow-tools-input\"] input")!
    act(() => {
      type(q<HTMLTextAreaElement>("textarea")!, "Sync bookings")
      type(document.body.querySelectorAll("textarea")[2] as HTMLTextAreaElement, "Skip test bookings.")
      type(toolsInput, "HubSpot, Slack,")
    })
    act(() => { type(toolsInput, "Google Sheets") })
    act(() => { toolsInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    // Chips, each removable by name.
    expect(q("[aria-label=\"Remove Slack\"]")).not.toBeNull()
    await act(async () => { q<HTMLButtonElement>("button[type=\"submit\"]")!.click() })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.notes).toBe("Skip test bookings.")
    expect(body.tools).toEqual(["HubSpot", "Slack", "Google Sheets"])
  })

  it("obj 900868: leaves notes and tools out when empty", async () => {
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({ flow_id: 9, slug: "t", workspace: "beta", objective_id: 1, builder: { objective_id: 1, status: "queue", max_iterations: 6, queue_hold: null } }) })
    render()
    act(() => type(q<HTMLTextAreaElement>("textarea")!, "Sync bookings"))
    await act(async () => { q<HTMLButtonElement>("button[type=\"submit\"]")!.click() })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).not.toHaveProperty("notes")
    expect(body).not.toHaveProperty("tools")
  })
})
