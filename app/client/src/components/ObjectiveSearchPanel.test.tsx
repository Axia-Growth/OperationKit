// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, click, press, render } from '../test/render'

/* Board "/" search on Modal + UI SDK Command (obj 900819): a dialog, server
   results with no client re-filter, arrows + Enter to open, AI mode on Enter. */

const searchObjectives = vi.fn()
const searchObjectivesAi = vi.fn()
vi.mock('../lib/api', () => ({
  searchObjectives: (...a: unknown[]) => searchObjectives(...a),
  searchObjectivesAi: (...a: unknown[]) => searchObjectivesAi(...a),
  ApiError: class extends Error { status = 0 },
}))
vi.mock('../hooks/useWorkspaces', () => ({ useWorkspaces: () => ({ labelOf: (w: string) => w.toUpperCase() }) }))

const { ObjectiveSearchPanel } = await import('./ObjectiveSearchPanel')

const hit = (id: number, title: string) => ({ id, title, status: 'done', workspace: 'acme', snippet: `${title} snippet`, agent_context: null })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  searchObjectives.mockResolvedValue({ results: [hit(7, 'Fix login'), hit(9, 'Login copy')] })
  searchObjectivesAi.mockResolvedValue({ results: [{ id: 11, title: 'Auth rewrite', status: 'review', workspace: 'acme', reason: 'about auth' }] })
})
afterEach(async () => { await cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

const input = () => document.querySelector('[role="combobox"]') as HTMLInputElement
const options = () => [...document.querySelectorAll('[role="option"]')] as HTMLElement[]

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
}

describe('ObjectiveSearchPanel on UI SDK Command + Dialog', () => {
  it('is a named modal dialog with focus in the search field', async () => {
    await render(<ObjectiveSearchPanel open workspace={'acme' as never} onClose={vi.fn()} onSelect={vi.fn()} />)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Search cards')
    await vi.waitFor(() => expect(document.activeElement).toBe(input()))
  })

  it('shows server results in server order; arrows + Enter open one and close', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    await render(<ObjectiveSearchPanel open workspace={'acme' as never} onClose={onClose} onSelect={onSelect} />)
    await type('login')
    expect(searchObjectives).toHaveBeenCalledWith('login', 'acme', 30)
    await vi.waitFor(() => expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining('Fix login'),
      expect.stringContaining('Login copy'),
    ]))
    // The top hit is highlighted as results land, so Enter alone opens it.
    await press('ArrowDown', input())
    await press('Enter', input())
    expect(onSelect.mock.calls).toEqual([[9]])
    expect(onClose).toHaveBeenCalled()
  })

  it('the mode switch is a radio group; AI mode searches on Enter', async () => {
    const onSelect = vi.fn()
    await render(<ObjectiveSearchPanel open workspace={'acme' as never} onClose={vi.fn()} onSelect={onSelect} />)
    const group = document.querySelector('[role="radiogroup"][aria-label="Search mode"]')!
    const ai = [...group.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'AI') as HTMLElement
    await click(ai)
    expect(ai.getAttribute('aria-checked')).toBe('true')
    input().focus()
    await type('auth work')
    expect(searchObjectivesAi).not.toHaveBeenCalled()
    await press('Enter', input())
    expect(searchObjectivesAi).toHaveBeenCalledWith('auth work', 'acme')
    await vi.waitFor(() => expect(options()).toHaveLength(1))
  })

  it('says when nothing matches', async () => {
    searchObjectives.mockResolvedValue({ results: [] })
    await render(<ObjectiveSearchPanel open workspace={'acme' as never} onClose={vi.fn()} onSelect={vi.fn()} />)
    await type('zzz')
    await vi.waitFor(() => expect(document.body.textContent).toContain('No matches'))
  })

  it('Escape closes', async () => {
    const onClose = vi.fn()
    await render(<ObjectiveSearchPanel open workspace={'acme' as never} onClose={onClose} onSelect={vi.fn()} />)
    await vi.waitFor(() => expect(document.activeElement).toBe(input()))
    await press('Escape', input())
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
