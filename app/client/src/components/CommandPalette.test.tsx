// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { CommandPalette } from './CommandPalette'
import { cleanup, click, press, render } from '../test/render'

/* ⌘K palette on UI SDK Command inside the Modal dialog (obj 900819). */

afterEach(cleanup)

function Harness({ go }: { go: (href: string) => void }) {
  const [open, setOpen] = useState(false)
  const items = ['Board', 'Bots', 'Settings', 'Secrets'].map((label) => ({
    label,
    hint: `/${label.toLowerCase()}`,
    onSelect: () => go(`/${label.toLowerCase()}`),
  }))
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open palette</button>
      <CommandPalette open={open} onClose={() => setOpen(false)} items={items} />
    </>
  )
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null
const input = () => document.querySelector('[role="combobox"]') as HTMLInputElement
const options = () => [...document.querySelectorAll('[role="option"]')] as HTMLElement[]
const highlighted = () => document.getElementById(input().getAttribute('aria-activedescendant') ?? '')?.textContent ?? ''

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const { act } = await import('react')
  await act(async () => {
    setter.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function openPalette() {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open palette')!
  btn.focus()
  await click(btn)
  return btn
}

describe('CommandPalette on UI SDK Command + Dialog', () => {
  it('opens as a named modal dialog with focus in the search field', async () => {
    await render(<Harness go={vi.fn()} />)
    await openPalette()
    expect(dialog()).not.toBeNull()
    expect(dialog()!.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog()!.getAttribute('aria-labelledby')!)?.textContent).toBe('Jump to a page')
    await vi.waitFor(() => expect(document.activeElement).toBe(input()))
    expect(input().getAttribute('aria-label')).toBe('Jump to a page')
    expect(options()).toHaveLength(4)
  })

  it('arrows move the highlight while focus stays in the field', async () => {
    await render(<Harness go={vi.fn()} />)
    await openPalette()
    await vi.waitFor(() => expect(document.activeElement).toBe(input()))
    await press('ArrowDown')
    const first = highlighted()
    await press('ArrowDown')
    expect(highlighted()).not.toBe(first)
    expect(document.activeElement).toBe(input())
  })

  it('typing filters; Enter runs the highlighted page and closes', async () => {
    const go = vi.fn()
    await render(<Harness go={go} />)
    await openPalette()
    await type('secr')
    await vi.waitFor(() => expect(options().filter((o) => !o.hidden).map((o) => o.textContent)).toEqual(['Secrets/secrets']))
    await press('ArrowDown', input())
    await press('Enter', input())
    expect(go).toHaveBeenCalledWith('/secrets')
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it('no match says so', async () => {
    await render(<Harness go={vi.fn()} />)
    await openPalette()
    await type('zzzz')
    await vi.waitFor(() => expect(document.body.textContent).toContain('No matches'))
  })

  it('clicking a row runs it', async () => {
    const go = vi.fn()
    await render(<Harness go={go} />)
    await openPalette()
    await click(options().find((o) => o.textContent?.startsWith('Bots'))!)
    expect(go).toHaveBeenCalledWith('/bots')
  })

  it('Escape closes and focus goes back to what opened it', async () => {
    await render(<Harness go={vi.fn()} />)
    const btn = await openPalette()
    await vi.waitFor(() => expect(document.activeElement).toBe(input()))
    await press('Escape', input())
    if (dialog()) await press('Escape', input()) // first Escape may clear the field
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(btn))
  })
})
