// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { SecretRequestScope } from '@operationkit/shared'
import { SecretScopePicker } from './SecretFields'
import { byRole, cleanup, click, press, render } from '../../test/render'

/* obj 900819 — the "Save to" scope picker is ui/RadioGroup on the UI SDK
   radio: named by its legend, described by the hint, arrow keys pick. */
afterEach(cleanup)

function Harness({ onChange, disabled }: { onChange?: (v: SecretRequestScope) => void; disabled?: boolean }) {
  const [v, setV] = useState<SecretRequestScope>('workspace')
  return <SecretScopePicker id="sr" value={v} onChange={(n) => { setV(n); onChange?.(n) }} workspace="example" disabled={disabled} />
}

describe('SecretScopePicker', () => {
  it('is a radio group named by its legend and described by the hint; arrows pick and the hint follows', async () => {
    const onChange = vi.fn()
    const { container } = await render(<Harness onChange={onChange} />)
    const group = byRole(container, 'radiogroup')[0]
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Save to')
    const hint = () => document.getElementById(group.getAttribute('aria-describedby')!)?.textContent
    expect(hint()).toContain('Only the example workspace')
    const radios = byRole(group, 'radio')
    expect(radios.map(r => r.textContent)).toEqual(['Workspace', 'Everywhere', 'Workspace + me'])
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    radios[0].focus()
    await press('ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('global')
    expect(document.activeElement).toBe(radios[1])
    await press('ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('workspace_user')
    expect(hint()).toContain('Only you, only inside example')
  })

  it('a disabled picker ignores presses', async () => {
    const onChange = vi.fn()
    const { container } = await render(<Harness onChange={onChange} disabled />)
    await click(byRole(container, 'radio')[1])
    expect(onChange).not.toHaveBeenCalled()
  })
})
