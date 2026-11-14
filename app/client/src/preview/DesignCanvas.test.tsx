// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { checkPattern } from '@ui-sdk/core/testing'
import { DesignCanvas } from './DesignCanvas'
import { byRole, cleanup, click, press, render, withoutFormProxies } from '../test/render'

/* obj 900819 — Desktop / Mobile is one choice: a ui/SegmentedControl radio
   group (UI SDK) instead of two aria-pressed buttons. */
afterEach(cleanup)

describe('DesignCanvas viewport switch', () => {
  it('passes the WAI-ARIA radio-group pattern check', async () => {
    const { container } = await render(<DesignCanvas url="" onUrl={() => {}} seedUrls={[]} />)
    const group = byRole(container, 'radiogroup')[0]
    await withoutFormProxies(group, () => checkPattern(group, 'radio-group'))
  })

  it('is a named radio group; arrows and clicks move the stage between desktop and mobile', async () => {
    const { container } = await render(<DesignCanvas url="https://preview.test" onUrl={() => {}} seedUrls={[]} />)
    const group = byRole(container, 'radiogroup')[0]
    expect(group.getAttribute('aria-label')).toBe('Preview viewport')
    const [desktop, mobile] = byRole(group, 'radio')
    const stage = () => container.querySelector('.cc-design-stage')!.className
    expect(desktop.getAttribute('aria-checked')).toBe('true')
    expect(stage()).toContain('desktop')
    desktop.focus()
    await press('ArrowRight')
    expect(mobile.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(mobile)
    expect(stage()).toContain('mobile')
    await click(desktop)
    expect(stage()).toContain('desktop')
  })
})
