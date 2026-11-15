// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { checkPattern } from '@ui-sdk/core/testing'
import { RadioGroup, type RadioOption } from './RadioGroup'
import { byRole, cleanup, click, press, render, withoutFormProxies } from '../../test/render'

const OPTIONS: RadioOption[] = [
  { value: 'smtp', label: 'SMTP', description: 'Any mail server.' },
  { value: 'resend', label: 'Resend', description: 'API key.', aside: <span>key saved</span> },
  { value: 'postmark', label: 'Postmark', description: 'Server token.' },
]

function Harness({ onChange, initial = 'smtp', ...p }: { onChange?: (v: string) => void; initial?: string | null; variant?: 'card' | 'segment'; options?: RadioOption[] }) {
  const [v, setV] = useState<string | null>(initial)
  return (
    <RadioGroup
      options={p.options ?? OPTIONS}
      value={v}
      onChange={(next) => { setV(next); onChange?.(next) }}
      label="Email provider"
      variant={p.variant}
    />
  )
}

afterEach(cleanup)

describe('ui/RadioGroup on UI SDK Radio (obj 900819)', () => {
  it('passes the WAI-ARIA radio-group pattern check', async () => {
    const { container } = await render(<Harness />)
    const group = byRole(container, 'radiogroup')[0]
    // The SDK's form proxies are aria-hidden and unfocusable; see withoutFormProxies.
    const proxies = group.querySelectorAll('input[type="radio"]')
    expect(proxies).toHaveLength(3)
    proxies.forEach((p) => {
      expect(p.getAttribute('aria-hidden')).toBe('true')
      expect(p.getAttribute('tabindex')).toBe('-1')
    })
    await withoutFormProxies(group, () => checkPattern(group, 'radio-group'))
  })

  it('is a named group of radios, each named by its label and described by its description', async () => {
    const { container } = await render(<Harness />)
    const group = byRole(container, 'radiogroup')[0]
    expect(group.getAttribute('aria-label')).toBe('Email provider')
    const radios = byRole(group, 'radio')
    expect(radios).toHaveLength(3)
    const nameOf = (el: Element) => document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent
    const descOf = (el: Element) => document.getElementById(el.getAttribute('aria-describedby')!)?.textContent
    expect(radios.map(nameOf)).toEqual(['SMTP', 'Resend', 'Postmark'])
    expect(descOf(radios[1])).toBe('API key.')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(radios.filter((r) => r.tabIndex === 0)).toEqual([radios[0]])
  })

  it('arrow keys move focus and check, wrapping at the ends; click checks', async () => {
    const onChange = vi.fn()
    const { container } = await render(<Harness onChange={onChange} />)
    const radios = byRole(container, 'radio')
    radios[0].focus()
    await press('ArrowDown')
    expect(document.activeElement).toBe(radios[1])
    expect(onChange).toHaveBeenLastCalledWith('resend')
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    await press('ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('postmark')
    await press('ArrowRight')
    expect(document.activeElement).toBe(radios[0])
    expect(onChange).toHaveBeenLastCalledWith('smtp')
    await press('ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith('postmark')
    await click(radios[1])
    expect(onChange).toHaveBeenLastCalledWith('resend')
    expect(radios.filter((r) => r.tabIndex === 0)).toEqual([radios[1]])
  })

  it('with nothing chosen, Tab enters on the first option; a disabled option is skipped', async () => {
    const onChange = vi.fn()
    const options = OPTIONS.map((o) => (o.value === 'resend' ? { ...o, disabled: true } : o))
    const { container } = await render(<Harness onChange={onChange} initial={null} options={options} />)
    const radios = byRole(container, 'radio')
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(radios[0].tabIndex).toBe(0)
    radios[0].focus()
    await press('ArrowDown')
    expect(document.activeElement).toBe(radios[2])
    expect(onChange).toHaveBeenLastCalledWith('postmark')
  })

  it('a disabled fieldset disables the whole group', async () => {
    const onChange = vi.fn()
    const { container } = await render(
      <fieldset disabled>
        <Harness onChange={onChange} variant="segment" />
      </fieldset>,
    )
    await click(byRole(container, 'radio')[2])
    expect(onChange).not.toHaveBeenCalled()
  })
})
