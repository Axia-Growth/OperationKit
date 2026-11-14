// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { DropdownOption, FilterDropdown } from './FilterDropdown'
import { cleanup, click, press, render } from '../test/render'

/* FilterDropdown on the UI SDK popover (obj 900819): how it opens, closes
   and where focus goes. The filters themselves are tested by their owners
   (OrgSwitcher, ProjectFilterBar). */

afterEach(cleanup)

function Harness({ onPick }: { onPick: (v: string) => void }) {
  const [v, setV] = useState('All')
  return (
    <>
      <FilterDropdown label="Project" value={v} ariaLabel={`Project: ${v}`}>
        {(close) => (
          <div role="group" aria-label="Projects">
            {['All', 'Infra', 'Site'].map((p) => (
              <DropdownOption key={p} selected={v === p} onClick={() => { setV(p); onPick(p); close() }}>{p}</DropdownOption>
            ))}
          </div>
        )}
      </FilterDropdown>
      <button type="button">elsewhere</button>
    </>
  )
}

const trigger = () => document.querySelector('[data-dropdown-trigger]') as HTMLElement
const panel = () => document.querySelector('[data-dropdown-panel]') as HTMLElement | null
const isOpen = () => trigger().getAttribute('aria-expanded') === 'true'

describe('FilterDropdown on UI SDK Popover', () => {
  it('the trigger is named and reports open/closed', async () => {
    await render(<Harness onPick={vi.fn()} />)
    expect(trigger().getAttribute('aria-label')).toBe('Project: All')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await click(trigger())
    expect(isOpen()).toBe(true)
    expect(trigger().getAttribute('aria-controls')).toBe(panel()!.id)
  })

  it('the panel is a named dialog and focus moves into it', async () => {
    await render(<Harness onPick={vi.fn()} />)
    trigger().focus()
    await press('Enter')
    expect(isOpen()).toBe(true)
    expect(panel()!.getAttribute('role')).toBe('dialog')
    expect(panel()!.getAttribute('aria-label')).toBe('Project: All')
    await vi.waitFor(() => expect(panel()!.contains(document.activeElement)).toBe(true))
  })

  it('picking an option runs it, closes, and returns focus to the trigger', async () => {
    const onPick = vi.fn()
    await render(<Harness onPick={onPick} />)
    trigger().focus()
    await press('Enter')
    const infra = [...panel()!.querySelectorAll('button')].find((b) => b.textContent === 'Infra')!
    await click(infra)
    expect(onPick).toHaveBeenCalledWith('Infra')
    await vi.waitFor(() => expect(isOpen()).toBe(false))
    expect(trigger().textContent).toContain('Infra')
    expect(document.activeElement).toBe(trigger())
  })

  it('Escape closes and returns focus to the trigger', async () => {
    await render(<Harness onPick={vi.fn()} />)
    trigger().focus()
    await press('Enter')
    await vi.waitFor(() => expect(panel()!.contains(document.activeElement)).toBe(true))
    await press('Escape')
    await vi.waitFor(() => expect(isOpen()).toBe(false))
    expect(document.activeElement).toBe(trigger())
  })

  it('an outside click closes it', async () => {
    await render(<Harness onPick={vi.fn()} />)
    await click(trigger())
    expect(isOpen()).toBe(true)
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'elsewhere')!)
    await vi.waitFor(() => expect(isOpen()).toBe(false))
  })

  it('options say which one is selected', async () => {
    await render(<Harness onPick={vi.fn()} />)
    await click(trigger())
    const pressed = [...panel()!.querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed'))
    expect(pressed).toEqual(['true', 'false', 'false'])
  })
})
