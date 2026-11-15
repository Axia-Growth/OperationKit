/**
 * Email sign-in link UI for the login page (obj 900497).
 *
 * Request: enter your email → the server emails a one-time link (same answer
 * whether or not the address has an account). Redeem: the link opens
 * /login?link=…; the person clicks "Sign in" and we POST the token. Requiring
 * the click means an inbox link-scanner that pre-fetches URLs cannot use or
 * burn the link.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button, Field, Input } from '../ui'
import { AuthCard, AuthLink } from './AuthCard'

/** Token from ?link=… (read once; removed from the address bar). */
export function readLinkToken(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const token = url.searchParams.get('link')
  if (!token) return null
  url.searchParams.delete('link')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  return token
}

export function EmailLinkRequest({ brandName, onBack, footer }: { brandName: string; onBack: () => void; footer?: ReactNode }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const r = await fetch('/api/auth/email-link', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error((b as { error?: string }).error || 'Could not send the link')
      }
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthCard
      title={sent ? 'Check your email' : `Sign in to ${brandName}`}
      subtitle={sent ? undefined : 'We will email you a link that signs you in.'}
      error={error || undefined}
      footer={
        <>
          <AuthLink onClick={onBack}>Sign in with a password instead</AuthLink>
          {footer}
        </>
      }
    >
      {sent ? (
        <p role="status" className="text-sm leading-relaxed text-fg-1">
          If <span className="font-medium text-fg-0">{email.trim()}</span> has an account here, a sign-in link is on its way. It works once and expires in 15 minutes.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email" id="link-email" hint="For example, you@company.com">
            <Input type="email" autoComplete="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={loading} className="w-full">
            {loading ? 'Sending…' : 'Email me a sign-in link'}
          </Button>
        </form>
      )}
    </AuthCard>
  )
}

export function EmailLinkRedeem({ token, brandName, footer }: { token: string; brandName: string; footer?: ReactNode }) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function redeem() {
    setError('')
    setLoading(true)
    try {
      const r = await fetch('/api/auth/email-link/redeem', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error((b as { error?: string }).error || 'This sign-in link did not work')
      }
      window.location.replace('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This sign-in link did not work')
      setLoading(false)
    }
  }

  return (
    <AuthCard
      title={`Sign in to ${brandName}`}
      error={error || undefined}
      footer={
        <>
          {error && <AuthLink href="/login">Back to sign in</AuthLink>}
          {footer}
        </>
      }
    >
      {!error && (
        <>
          <p className="text-sm text-fg-1">You opened a sign-in link for {brandName}.</p>
          <Button variant="primary" onClick={redeem} loading={loading} className="w-full">
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </>
      )}
      {error && <p className="text-sm text-fg-2">Sign-in links work once and expire after 15 minutes. Ask for a new one from the sign-in page.</p>}
    </AuthCard>
  )
}
