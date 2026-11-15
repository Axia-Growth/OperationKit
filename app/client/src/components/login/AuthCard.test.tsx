// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { byRole, cleanup, render } from '../../test/render'

/* One AuthCard shell for every signed-out screen (polish F5, obj 900806):
   a real "Sign in to {name}" heading, labelled fields (no placeholder names),
   and errors announced with role=alert. */

const auth = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  showPasswordLogin: vi.fn(),
  user: { id: 7, username: 'casey', role: 'member' } as unknown,
  accessDenied: null as null | { code: string; email: string; logoutUrl: string },
}))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../../hooks/useBranding', async (orig) => {
  const real = await orig<typeof import('../../hooks/useBranding')>()
  return { ...real, useBranding: () => ({ name: 'Northwind Ops', default_name: 'Operation Kit', powered_by: false }) }
})
vi.mock('../BrandLogo', () => ({ BrandLogo: () => <span data-testid="logo" /> }))

import { LoginPage } from '../LoginPage'
import { ChangePasswordPage } from '../ChangePasswordPage'
import { NoAccountPage } from '../NoAccountPage'
import { EmailLinkRequest } from './EmailSignInLink'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true }), { status: 200 })))
})
afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
  auth.login.mockReset()
  auth.accessDenied = null
})

const labelText = (input: Element) => document.querySelector(`label[for="${input.id}"]`)?.textContent

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('LoginPage on AuthCard', () => {
  it('says "Sign in to {install name}" in an h1 and labels both fields', async () => {
    const { container } = await render(<LoginPage />)
    expect(container.querySelector('h1')?.textContent).toBe('Sign in to Northwind Ops')
    const user = container.querySelector('#username') as HTMLInputElement
    const pass = container.querySelector('#password') as HTMLInputElement
    expect(labelText(user)).toBe('Username')
    expect(labelText(pass)).toBe('Password')
    expect(user.placeholder).toBe('')
    expect(user.autocomplete).toBe('username')
    expect(pass.autocomplete).toBe('current-password')
    expect(byRole(container, 'alert')).toHaveLength(0)
  })

  it('a failed sign-in shows the error as role=alert', async () => {
    auth.login.mockRejectedValueOnce(new Error('Invalid credentials'))
    const { container } = await render(<LoginPage />)
    await submit(container.querySelector('form')!)
    await vi.waitFor(() => expect(byRole(container, 'alert').map((a) => a.textContent)).toEqual(['Invalid credentials']))
  })

  it('offers the email link as a quiet footer link when this site can send mail', async () => {
    const { container } = await render(<LoginPage />)
    await vi.waitFor(() => expect(container.textContent).toContain('Email me a sign-in link instead'))
  })
})

describe('the other signed-out screens share the shell', () => {
  it('Change password: heading, labelled fields, role=alert error', async () => {
    auth.changePassword.mockRejectedValueOnce(new Error('Wrong setup password'))
    const { container } = await render(<ChangePasswordPage />)
    expect(container.querySelector('h1')?.textContent).toBe('Choose a new password')
    for (const [id, label] of [['current-password', 'Setup password'], ['new-password', 'New password'], ['confirm-password', 'Type it again']]) {
      expect(labelText(container.querySelector(`#${id}`)!)).toBe(label)
    }
    const set = (id: string, v: string) => {
      const el = container.querySelector(`#${id}`) as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => {
      set('current-password', 'setup-pass-1234')
      set('new-password', 'a-brand-new-pass')
      set('confirm-password', 'a-brand-new-pass')
    })
    await submit(container.querySelector('form')!)
    await vi.waitFor(() => expect(byRole(container, 'alert').map((a) => a.textContent)).toEqual(['Wrong setup password']))
  })

  it('Email sign-in link: same heading, labelled email field', async () => {
    const { container } = await render(<EmailLinkRequest brandName="Northwind Ops" onBack={() => {}} />)
    expect(container.querySelector('h1')?.textContent).toBe('Sign in to Northwind Ops')
    const email = container.querySelector('#link-email') as HTMLInputElement
    expect(labelText(email)).toBe('Email')
    expect(email.type).toBe('email')
  })

  it('No account: a heading inside the same card, message is role=alert', async () => {
    auth.accessDenied = { code: 'no_account', email: 'pat@example.com', logoutUrl: '/logout' }
    const { container } = await render(<NoAccountPage />)
    expect(container.querySelector('h1')?.textContent).toBe('No account for this email')
    expect(byRole(container, 'alert')[0]?.textContent).toContain('pat@example.com')
    expect(container.querySelector('[data-testid="logo"]')).not.toBeNull()
  })
})
