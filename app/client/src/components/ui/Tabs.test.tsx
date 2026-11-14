// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { checkPattern } from '@ui-sdk/core/testing'
import { Tabs } from './Tabs'
import { SegmentedControl } from './SegmentedControl'
import { byRole, cleanup, click, press, render } from '../../test/render'

const ITEMS = [
  { key: 'models', label: 'Models' },
  { key: 'secrets', label: 'Secrets', count: 3 },
  { key: 'email', label: 'Email' },
]

function Harness({ onChange }: { onChange?: (k: string) => void }) {
  const [v, setV] = useState('models')
  return (
    <Tabs items={ITEMS} value={v} onChange={(k) => { setV(k); onChange?.(k) }} label="Settings sections">
      <p>Panel for {v}</p>
    </Tabs>
  )
}

afterEach(cleanup)

describe('ui/Tabs on UI SDK (obj 900819)', () => {
  it('passes the WAI-ARIA tabs pattern check', async () => {
    const { container } = await render(<Harness />)
    await checkPattern(byRole(container, 'tablist')[0].parentElement!, 'tabs')
  })

  it('has one tab stop, names the list, and links the panel to its tab', async () => {
    const { container } = await render(<Harness />)
    expect(byRole(container, 'tablist')[0].getAttribute('aria-label')).toBe('Settings sections')
    const tabs = byRole(container, 'tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Models', 'Secrets3', 'Email'])
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1)
    const panel = byRole(container, 'tabpanel')[0]
    expect(panel.textContent).toBe('Panel for models')
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id)
  })

  it('ArrowRight / End / Home move and select; onChange fires with the key', async () => {
    const onChange = vi.fn()
    const { container } = await render(<Harness onChange={onChange} />)
    const tabs = byRole(container, 'tab')
    tabs[0].focus()
    await press('ArrowRight')
    expect(document.activeElement).toBe(tabs[1])
    expect(onChange).toHaveBeenLastCalledWith('secrets')
    expect(byRole(container, 'tabpanel').find((p) => !p.hidden)?.textContent).toBe('Panel for secrets')
    await press('End')
    expect(onChange).toHaveBeenLastCalledWith('email')
    await press('Home')
    expect(onChange).toHaveBeenLastCalledWith('models')
  })

  it('manual activation waits for Enter', async () => {
    const onChange = vi.fn()
    const { container } = await render(<Tabs items={ITEMS} value="models" onChange={onChange} activation="manual" label="Sections" />)
    const tabs = byRole(container, 'tab')
    tabs[0].focus()
    await press('ArrowRight')
    expect(document.activeElement).toBe(tabs[1])
    expect(onChange).not.toHaveBeenCalled()
    await press('Enter')
    expect(onChange).toHaveBeenCalledWith('secrets')
  })

  it('click selects', async () => {
    const onChange = vi.fn()
    const { container } = await render(<Tabs items={ITEMS} value="models" onChange={onChange} label="Sections" />)
    await click(byRole(container, 'tab')[2])
    expect(onChange).toHaveBeenCalledWith('email')
  })
})

describe('ui/SegmentedControl on UI SDK (obj 900819)', () => {
  function Seg({ onChange }: { onChange?: (k: string) => void }) {
    const [v, setV] = useState('models')
    return <SegmentedControl items={ITEMS} value={v} onChange={(k) => { setV(k); onChange?.(k) }} label="Date range" />
  }

  it('is a named radio group with one tab stop and arrow keys', async () => {
    const onChange = vi.fn()
    const { container } = await render(<Seg onChange={onChange} />)
    const group = byRole(container, 'radiogroup')[0]
    expect(group.getAttribute('aria-label')).toBe('Date range')
    const radios = byRole(container, 'radio')
    expect(radios).toHaveLength(3)
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1)
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    radios[0].focus()
    await press('ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('secrets')
    expect(byRole(container, 'radio')[1].getAttribute('aria-checked')).toBe('true')
    await click(byRole(container, 'radio')[2])
    expect(onChange).toHaveBeenLastCalledWith('email')
  })
})
