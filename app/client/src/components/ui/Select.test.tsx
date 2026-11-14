// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { Select } from './Select'
import { byRole, cleanup, click, press, render } from '../../test/render'

/* ui/Select on UI SDK Select (obj 900819). The SDK select is the APG
   select-only combobox with focus moved into the list, which checkPattern
   models as neither an editable combobox nor a standalone listbox, so its
   keyboard contract is asserted directly below instead. */

afterEach(cleanup)

function Harness({ onChange, initial = 'all' }: { onChange?: (v: string) => void; initial?: string }) {
  const [v, setV] = useState(initial)
  return (
    <>
      <label htmlFor="scope">Scope</label>
      <Select id="scope" value={v} onChange={(n) => { setV(n); onChange?.(n) }} name="scope">
        <option value="all">All scopes</option>
        <option value="">Unscoped</option>
        <option value="global">Global</option>
        <option value="workspace" disabled>Workspace</option>
        <option value="user">Personal</option>
      </Select>
    </>
  )
}

const trigger = () => document.getElementById('scope') as HTMLElement
const options = () => byRole(document.body, 'option')
const active = () => {
  const lb = byRole(document.body, 'listbox')[0]
  const id = lb?.getAttribute('aria-activedescendant')
  return (id ? document.getElementById(id) : document.activeElement)?.textContent?.trim()
}

describe('ui/Select on UI SDK Select', () => {
  it('the trigger is a named combobox showing the current label', async () => {
    await render(<Harness />)
    expect(trigger().getAttribute('role')).toBe('combobox')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().textContent).toContain('All scopes')
    // Named by the <label htmlFor>.
    expect(document.querySelector('label')!.htmlFor).toBe(trigger().id)
  })

  it('opens with the keyboard on the selected option; arrows skip disabled; Enter picks', async () => {
    const onChange = vi.fn()
    await render(<Harness onChange={onChange} initial="global" />)
    trigger().focus()
    await press('ArrowDown')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    await vi.waitFor(() => expect(active()).toBe('Global'))
    expect(options().find((o) => o.textContent === 'Workspace')!.getAttribute('aria-disabled')).toBe('true')
    await press('ArrowDown')
    expect(active()).toBe('Personal')
    await press('Enter')
    expect(onChange).toHaveBeenCalledWith('user')
    await vi.waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'))
    expect(trigger().textContent).toContain('Personal')
    expect(document.activeElement).toBe(trigger())
  })

  it('an option whose value is "" can be chosen and reports ""', async () => {
    const onChange = vi.fn()
    await render(<Harness onChange={onChange} />)
    await click(trigger())
    await click(options().find((o) => o.textContent === 'Unscoped')!)
    expect(onChange).toHaveBeenCalledWith('')
    expect(trigger().textContent).toContain('Unscoped')
  })

  it('typeahead jumps to a matching option', async () => {
    await render(<Harness />)
    trigger().focus()
    await press('ArrowDown')
    await press('p')
    await vi.waitFor(() => expect(active()).toBe('Personal'))
  })

  it('Escape closes without changing the value', async () => {
    const onChange = vi.fn()
    await render(<Harness onChange={onChange} />)
    trigger().focus()
    await press('ArrowDown')
    await press('ArrowDown')
    await press('Escape')
    await vi.waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'))
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger())
  })

  it('submits through a hidden native input when named', async () => {
    await render(<Harness initial="global" />)
    const input = document.querySelector('input[name="scope"]') as HTMLInputElement | null
    expect(input?.value).toBe('global')
  })
})

describe('ui/Select list naming (obj 900819 screen-reader pass)', () => {
  it('the open list is named like its field (from <label htmlFor> or aria-label)', async () => {
    await render(<Harness />)
    trigger().focus()
    await press('ArrowDown')
    await vi.waitFor(() => expect(byRole(document.body, 'listbox')[0]?.getAttribute('aria-label')).toBe('Scope'))
    await cleanup()
    await render(<Select value="a" onChange={() => {}} aria-label="Run kind"><option value="a">A</option></Select>)
    ;(document.querySelector('[role="combobox"]') as HTMLElement).focus()
    await press('ArrowDown')
    await vi.waitFor(() => expect(byRole(document.body, 'listbox')[0]?.getAttribute('aria-label')).toBe('Run kind'))
  })
})
