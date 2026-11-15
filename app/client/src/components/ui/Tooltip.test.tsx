// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { Tooltip } from './Tooltip'
import { IconButton } from './Button'
import { cleanup, press, render } from '../../test/render'

/* ui/Tooltip + IconButton on UI SDK Tooltip (obj 900819). */

afterEach(async () => { await cleanup(); vi.useRealTimers() })

const tip = () => document.querySelector('[role="tooltip"]') as HTMLElement
const shown = () => tip().hasAttribute('data-open')

describe('ui/Tooltip on UI SDK Tooltip', () => {
  // First: tooltips group, so one that closed a moment ago makes the next open at once.
  it('opens after the pointer rests', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await render(<Tooltip content="Archive" delay={300}><button type="button">A</button></Tooltip>)
    const btn = document.querySelector('button')!
    await act(async () => {
      btn.dispatchEvent(new (globalThis.PointerEvent ?? MouseEvent)('pointerenter', { pointerType: 'mouse' } as PointerEventInit))
      btn.dispatchEvent(new (globalThis.PointerEvent ?? MouseEvent)('pointermove', { bubbles: true, pointerType: 'mouse' } as PointerEventInit))
      btn.dispatchEvent(new MouseEvent('mouseenter'))
      btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    })
    expect(shown()).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await vi.waitFor(() => expect(shown()).toBe(true))
  })

  it('is in the page from the start, hidden, and names an icon-only trigger', async () => {
    await render(<Tooltip content="Archive"><button type="button"><svg aria-hidden="true" /></button></Tooltip>)
    const btn = document.querySelector('button')!
    expect(tip()).not.toBeNull()
    expect(shown()).toBe(false)
    expect(btn.getAttribute('aria-labelledby')).toBe(tip().id)
  })

  it('describes a trigger that already has a name', async () => {
    await render(<Tooltip content="Moves it out of the board"><button type="button">Archive</button></Tooltip>)
    expect(document.querySelector('button')!.getAttribute('aria-describedby')).toBe(tip().id)
  })

  it('opens at once on keyboard focus; Escape hides it and focus stays', async () => {
    await render(<Tooltip content="Archive"><button type="button">A</button></Tooltip>)
    const btn = document.querySelector('button')!
    await act(async () => {
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      btn.focus()
    })
    await vi.waitFor(() => expect(shown()).toBe(true))
    await press('Escape', btn)
    await vi.waitFor(() => expect(shown()).toBe(false))
    expect(document.activeElement).toBe(btn)
  })

  it('IconButton: the label is the name and the tip; no native title', async () => {
    await render(<IconButton label="Copy path" onClick={() => {}}><svg aria-hidden="true" /></IconButton>)
    const btn = document.querySelector('button')!
    expect(btn.getAttribute('aria-label')).toBe('Copy path')
    expect(btn.hasAttribute('title')).toBe(false)
    expect(btn.getAttribute('type')).toBe('button')
    expect(tip().textContent).toBe('Copy path')
  })
})
