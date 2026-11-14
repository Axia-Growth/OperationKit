// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { useConfirm } from './ConfirmDialog'
import { cleanup, click, press, render } from '../../test/render'

let ask: ((danger?: boolean) => Promise<boolean>) | null = null

function Page() {
  const { confirm, confirmDialog } = useConfirm()
  ask = (danger) => confirm({ title: 'Delete card?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger })
  return (
    <>
      <button>Delete…</button>
      {confirmDialog}
    </>
  )
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const button = (name: string) => Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === name)!

async function open(danger?: boolean) {
  const trigger = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Delete…')!
  trigger.focus()
  let answer!: Promise<boolean>
  await click(trigger)
  const { act } = await import('react')
  await act(async () => {
    answer = ask!(danger)
  })
  return { trigger, answer }
}

afterEach(cleanup)

describe('useConfirm on the UI SDK alert dialog (obj 900819)', () => {
  it('is a named, described alertdialog with focus on Cancel', async () => {
    await render(<Page />)
    await open()
    const d = dialog()!
    expect(d).toBeTruthy()
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('Delete card?')
    expect(document.getElementById(d.getAttribute('aria-describedby')!)?.textContent).toBe('This cannot be undone.')
    expect(document.activeElement).toBe(button('Cancel'))
  })

  it('Delete resolves true and focus returns to the trigger', async () => {
    await render(<Page />)
    const { trigger, answer } = await open(true)
    await click(button('Delete'))
    await expect(answer).resolves.toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('Cancel resolves false', async () => {
    await render(<Page />)
    const { answer } = await open()
    await click(button('Cancel'))
    await expect(answer).resolves.toBe(false)
  })

  it('Escape resolves false', async () => {
    await render(<Page />)
    const { answer } = await open()
    await press('Escape')
    await expect(answer).resolves.toBe(false)
  })
})
