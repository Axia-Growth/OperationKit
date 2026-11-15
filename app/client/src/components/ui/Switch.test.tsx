// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { checkPattern } from '@ui-sdk/core/testing'
import { Switch } from './Switch'
import { byRole, cleanup, click, press, render } from '../../test/render'

afterEach(cleanup)

function Harness({ onChange, ...p }: { onChange?: (v: boolean) => void; disabled?: boolean; busy?: boolean }) {
  const [on, setOn] = useState(false)
  return <Switch checked={on} onChange={(v) => { setOn(v); onChange?.(v) }} label="Run on another engine" {...p} />
}

describe('ui/Switch on UI SDK Switch (obj 900819)', () => {
  it('passes the WAI-ARIA switch pattern check', async () => {
    const { container } = await render(<Harness />)
    await checkPattern(byRole(container, 'switch')[0], 'switch')
  })

  it('is a named switch reporting its state', async () => {
    const { container } = await render(<Harness />)
    const sw = byRole(container, 'switch')[0]
    expect(sw.textContent).toBe('Run on another engine')
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('click and Space toggle it', async () => {
    const onChange = vi.fn()
    const { container } = await render(<Harness onChange={onChange} />)
    const sw = byRole(container, 'switch')[0]
    await click(sw)
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    sw.focus()
    await press(' ')
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('disabled and busy block presses; busy is announced', async () => {
    const onChange = vi.fn()
    const { container, rerender } = await render(<Harness onChange={onChange} disabled />)
    await click(byRole(container, 'switch')[0])
    expect(onChange).not.toHaveBeenCalled()
    await rerender(<Harness onChange={onChange} busy />)
    const sw = byRole(container, 'switch')[0]
    expect(sw.getAttribute('aria-busy')).toBe('true')
    await click(sw)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('takes an aria-label when there is no visible label', async () => {
    const { container } = await render(<Switch checked onChange={() => {}} aria-label="Queue auto-start for Acme" />)
    const sw = byRole(container, 'switch')[0]
    expect(sw.getAttribute('aria-label')).toBe('Queue auto-start for Acme')
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })
})
