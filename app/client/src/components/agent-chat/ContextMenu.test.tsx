// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkPattern } from '@ui-sdk/core/testing'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { byRole, cleanup, click, press, render } from '../../test/render'

/* The Bots sidebar menu on UI SDK Menu (obj 900819): roles, keyboard,
   typeahead, the radio "current choice", submenus and how it closes. The
   per-action wiring (which request each item sends) is in BotSidebar.test. */

afterEach(cleanup)

function items(spy: (k: string) => void): MenuItem[] {
  return [
    { key: 'pin', label: 'Pin to top', onSelect: () => spy('pin') },
    {
      key: 'move',
      label: 'Move to section',
      submenu: [
        { key: 'to-1', label: 'Development', checked: true, onSelect: () => spy('to-1') },
        { key: 'to-2', label: 'Marketing', checked: false, onSelect: () => spy('to-2') },
        { key: 'to-new', label: 'New section…', separator: true, onSelect: () => spy('to-new') },
      ],
    },
    { key: 'copy', label: 'Copy ID', detail: 'dev-bot', onSelect: () => spy('copy') },
    { key: 'delete', label: 'Delete', danger: true, disabled: true, hint: 'Built-in: hide it instead', separator: true },
  ]
}

async function open(spy = vi.fn(), onClose = vi.fn()) {
  // Opened from a focused "⋯" button, the way the sidebar opens it.
  const trigger = document.createElement("button")
  trigger.textContent = "⋯"
  document.body.append(trigger)
  trigger.focus()
  await render(<ContextMenu label="Actions for Dev Bot" items={items(spy)} anchor={{ x: 20, y: 20 }} onClose={onClose} />)
  const menu = byRole(document.body, 'menu')[0]
  return { menu, spy, onClose, trigger }
}

const active = () => (document.activeElement?.textContent ?? '').trim()

describe('ContextMenu on UI SDK Menu', () => {
  it('passes the WAI-ARIA menu pattern check', async () => {
    const { menu } = await open()
    await checkPattern(menu, 'menu')
  })

  it('is a named menu and focuses the first item on open', async () => {
    const { menu } = await open()
    expect(menu.getAttribute('aria-label')).toBe('Actions for Dev Bot')
    expect(active()).toBe('Pin to top')
  })

  it('arrows move, Home/End jump, and focus wraps', async () => {
    await open()
    await press('ArrowDown')
    expect(active()).toMatch(/^Move to section/)
    await press('End')
    expect(active()).toMatch(/^Delete/)
    await press('ArrowDown')
    expect(active()).toBe('Pin to top')
    await press('ArrowUp')
    expect(active()).toMatch(/^Delete/)
    await press('Home')
    expect(active()).toBe('Pin to top')
  })

  it('typing a letter jumps to the matching item', async () => {
    await open()
    await press('c')
    expect(active()).toMatch(/^Copy ID/)
  })

  it('Enter runs the item and closes with focus restored', async () => {
    const { spy, onClose } = await open()
    await press('c')
    await press('Enter')
    expect(spy).toHaveBeenCalledWith('copy')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
  })

  it('a disabled item is announced as disabled and does nothing', async () => {
    const { menu, spy } = await open()
    const del = byRole(menu, 'menuitem').find((m) => m.textContent?.startsWith('Delete'))!
    expect(del.getAttribute('aria-disabled')).toBe('true')
    expect(del.textContent).toContain('hide it instead')
    await click(del)
    expect(spy).not.toHaveBeenCalled()
  })

  it('ArrowRight opens the submenu; the current section is a checked radio item', async () => {
    const { spy } = await open()
    await press('ArrowDown')
    const trigger = document.activeElement as HTMLElement
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    await press('ArrowRight')
    const radios = byRole(document.body, 'menuitemradio')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    // "New section…" is an action, not a choice.
    expect(byRole(document.body, 'menuitem').some((m) => m.textContent?.startsWith('New section'))).toBe(true)
    await vi.waitFor(() => expect(active()).toBe('Development'))
    await press('ArrowDown')
    await press('Enter')
    expect(spy).toHaveBeenCalledWith('to-2')
  })

  it('ArrowLeft closes the submenu and returns to its trigger', async () => {
    await open()
    await press('ArrowDown')
    await press('ArrowRight')
    await vi.waitFor(() => expect(active()).toBe('Development'))
    await press('ArrowLeft')
    await vi.waitFor(() => expect(active()).toMatch(/^Move to section/))
  })

  it('Escape closes and focus goes back to what opened it', async () => {
    const { onClose, trigger } = await open()
    await press('Escape')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
    expect(document.activeElement).toBe(trigger)
  })

  it('an outside click closes without stealing focus back', async () => {
    const { onClose } = await open()
    const outside = document.createElement('button')
    document.body.append(outside)
    await click(outside)
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(false))
  })
})
