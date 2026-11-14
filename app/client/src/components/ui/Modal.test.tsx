// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, press, render } from '../../test/render'
import { Modal } from './Modal'


/* obj 700071 regression — Modal focus stability.

   The board re-renders every ~3s for any live session (the state-poller emits
   objective_updated broadcasts), and its consumers pass an INLINE onClose
   closure, so onClose's identity changes on every one of those re-renders. The
   old focus/scroll-lock effect depended on [open, onClose], so an
   identity-only change tore the effect down — the cleanup ran
   restoreRef.current?.focus?.() and yanked focus to the trigger behind the
   modal, breaking the field/dropdown the user was in. The fix uses a latest-ref
   for onClose and depends on [open] only, so an onClose-identity-only re-render
   is a no-op for the effect and focus stays put.

   This test re-renders the Modal with a DIFFERENT onClose reference while open
   is unchanged and asserts the effect did NOT tear down/re-run (focus-restore
   never fires; focus stays inside the panel). It FAILS against the old
   [open, onClose] deps and PASSES with [open]. */

describe('Modal — focus is stable across onClose identity changes', () => {
  afterEach(async () => {
    await cleanup()
  })

  it('does not move focus when only onClose identity changes', async () => {
    // A trigger button standing in for the "New" button behind the modal — this
    // is what a torn-down focus effect would restore focus to.
    const trigger = document.createElement('button')
    trigger.textContent = 'New'
    document.body.appendChild(trigger)
    trigger.focus()

    const onClose1 = () => {}
    const view = await render(
      <Modal open onClose={onClose1}>
        <input data-autofocus placeholder="field" />
        <button>Save</button>
      </Modal>,
    )
    // The dialog element itself is the panel since the UI SDK migration (obj 900819).
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(panel).toBeTruthy()
    expect(document.activeElement).toBe(panel!.querySelector('input'))

    const restoreSpy = vi.spyOn(trigger, 'focus')
    const onClose2 = () => {}
    await view.rerender(
      <Modal open onClose={onClose2}>
        <input data-autofocus placeholder="field" />
        <button>Save</button>
      </Modal>,
    )
    expect(restoreSpy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(panel!.querySelector('input'))
    trigger.remove()
  })

  it('is a modal dialog: named, Escape closes via onClose, focus returns to the trigger', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const onClose = vi.fn()
    const view = await render(
      <Modal open onClose={onClose} labelledBy="m-title">
        <h2 id="m-title">Edit card</h2>
        <button>Save</button>
      </Modal>,
    )
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('m-title')
    await press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    await view.rerender(
      <Modal open={false} onClose={onClose} labelledBy="m-title">
        <h2 id="m-title">Edit card</h2>
      </Modal>,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('returns focus when the parent unmounts it while open', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const view = await render(
      <Modal open onClose={() => {}}>
        <button>Save</button>
      </Modal>,
    )
    expect(document.activeElement?.textContent).toBe('Save')
    await view.unmount()
    await new Promise((r) => setTimeout(r, 0))
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
