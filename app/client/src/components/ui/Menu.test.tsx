// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { checkPattern } from '@ui-sdk/core/testing'
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from './Menu'
import { byRole, cleanup, click, press, render } from '../../test/render'

/* ui/Menu on UI SDK Menu (obj 900819), in the account-menu shape: link rows
   that stay real <a href> (so Cmd/middle-click opens a tab) and an action. */

afterEach(cleanup)

function Harness({ navigate, logout }: { navigate: (h: string) => void; logout: () => void }) {
  const [open, setOpen] = useState(false)
  const rows = [
    { href: '/settings', label: 'Settings' },
    { href: '/system', label: 'System' },
  ]
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger aria-label="Account menu">M</MenuTrigger>
      <MenuContent aria-label="Account">
        <MenuGroup>
          <MenuGroupLabel>operator</MenuGroupLabel>
          {rows.map((r) => (
            <MenuItem
              key={r.href}
              value={r.href}
              label={r.label}
              current={r.href === '/settings'}
              onSelect={() => navigate(r.href)}
              render={<a href={r.href} onClick={(e) => { if (e.button === 0 && !e.metaKey) e.preventDefault() }} />}
            >
              {r.label}
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem value="logout" label="Log out" onSelect={logout}>Log out</MenuItem>
      </MenuContent>
    </Menu>
  )
}

const trigger = () => document.querySelector('[aria-label="Account menu"]') as HTMLElement
const active = () => (document.activeElement?.textContent ?? '').trim()

describe('ui/Menu on UI SDK Menu', () => {
  it('passes the WAI-ARIA menu pattern check', async () => {
    await render(<Harness navigate={vi.fn()} logout={vi.fn()} />)
    trigger().focus()
    await press('ArrowDown')
    await vi.waitFor(() => expect(active()).toBe('Settings'))
    await checkPattern(trigger(), 'menu')
  })

  it('the trigger says it opens a menu and whether it is open', async () => {
    await render(<Harness navigate={vi.fn()} logout={vi.fn()} />)
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('opens from the keyboard with focus on the first item; rows stay links', async () => {
    await render(<Harness navigate={vi.fn()} logout={vi.fn()} />)
    trigger().focus()
    await press('ArrowDown')
    await vi.waitFor(() => expect(active()).toBe('Settings'))
    const links = [...document.querySelectorAll('[role="menu"] a[role="menuitem"]')].map((a) => a.getAttribute('href'))
    expect(links).toEqual(['/settings', '/system'])
    expect(document.querySelector('a[href="/settings"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('arrows and typeahead move; Enter navigates in-app and closes', async () => {
    const navigate = vi.fn()
    await render(<Harness navigate={navigate} logout={vi.fn()} />)
    trigger().focus()
    await press('ArrowDown')
    await press('ArrowDown')
    expect(active()).toBe('System')
    await press('l')
    expect(active()).toBe('Log out')
    await press('Home')
    await press('ArrowDown')
    await press('Enter')
    expect(navigate).toHaveBeenCalledWith('/system')
    await vi.waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(trigger())
  })

  it('a pointer click on an action runs it once', async () => {
    const logout = vi.fn()
    await render(<Harness navigate={vi.fn()} logout={logout} />)
    await click(trigger())
    await click(byRole(document.body, 'menuitem').find((m) => m.textContent === 'Log out')!)
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('Escape closes and returns focus to the trigger', async () => {
    await render(<Harness navigate={vi.fn()} logout={vi.fn()} />)
    trigger().focus()
    await press('ArrowDown')
    await press('Escape')
    await vi.waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(trigger())
  })
})
