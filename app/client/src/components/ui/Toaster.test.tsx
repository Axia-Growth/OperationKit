// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createToaster } from '@ui-sdk/react/toast'
import { Toaster } from './Toaster'
import { cleanup, click, press, render } from '../../test/render'

/* ui/Toaster on the UI SDK toast (obj 900819): toasts are announced through a
   live region (polite; errors assertive), the stack is a named region reached
   with F6, and Escape / Dismiss close a toast. */

let t = createToaster()
afterEach(async () => {
  await act(async () => { t.dismiss() })
  await cleanup()
  t = createToaster()
})

const region = () => document.querySelector('[data-slot="toast-region"]') as HTMLElement
const toasts = () => Array.from(region().querySelectorAll<HTMLElement>('[data-slot="toast"]')).filter(el => !el.hasAttribute('data-ending-style'))
const announcer = (kind: 'polite' | 'assertive') =>
  document.querySelector<HTMLElement>(kind === 'polite' ? '[data-ui-sdk-announcer=""]' : '[data-ui-sdk-announcer="assertive"]')!
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 50)) })

describe('ui/Toaster on UI SDK toast', () => {
  it('announces a toast politely through a live region and shows it in a named region', async () => {
    await render(<Toaster toaster={t} />)
    expect(announcer('polite').getAttribute('aria-live')).toBe('polite')
    expect(announcer('assertive').getAttribute('aria-live')).toBe('assertive')
    await act(async () => { t.success('Nightly digest started') })
    await settle()
    expect(region().getAttribute('role')).toBe('region')
    expect(region().getAttribute('aria-label')).toBe('Status messages')
    expect(toasts().map(el => el.textContent)).toEqual(['Nightly digest started×'])
    expect(toasts()[0].getAttribute('data-type')).toBe('success')
    // The visible stack is NOT itself live (no double reading)...
    expect(region().getAttribute('aria-live')).toBeNull()
    // ...the shared announcer carries the text.
    await act(async () => { await new Promise(r => setTimeout(r, 1200)) })
    expect(announcer('polite').textContent).toContain('Nightly digest started')
  })

  it('an error is assertive and carries its description', async () => {
    await render(<Toaster toaster={t} />)
    await act(async () => { t.error('Disk check blocked', { description: 'queue depth guard' }) })
    await act(async () => { await new Promise(r => setTimeout(r, 1200)) })
    expect(announcer('assertive').textContent).toContain('Disk check blocked')
    const el = toasts()[0]
    expect(el.getAttribute('data-type')).toBe('error')
    expect(document.getElementById(el.getAttribute('aria-describedby')!)?.textContent).toBe('queue depth guard')
  })

  it('F6 moves focus to the newest toast, Escape dismisses it and focus goes back', async () => {
    await render(<><button type="button">Run now</button><Toaster toaster={t} /></>)
    const origin = document.querySelector('button')!
    origin.focus()
    await act(async () => { t('Started') })
    await settle()
    await press('F6', origin)
    expect(document.activeElement).toBe(toasts()[0])
    await press('Escape')
    await settle()
    expect(toasts()).toHaveLength(0)
    expect(document.activeElement).toBe(origin)
  })

  it('the Dismiss button closes a toast', async () => {
    await render(<Toaster toaster={t} />)
    await act(async () => { t('Queued') })
    await settle()
    await click(toasts()[0].querySelector('[aria-label="Dismiss"]'))
    await settle()
    expect(toasts()).toHaveLength(0)
  })
})
