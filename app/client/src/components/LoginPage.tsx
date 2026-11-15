import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBranding } from '../hooks/useBranding'
import { Button, Field, Input } from './ui'
import { AuthCard, AuthLink } from './login/AuthCard'
import { EmailLinkRedeem, EmailLinkRequest, readLinkToken } from './login/EmailSignInLink'

export function LoginPage() {
  const { login } = useAuth()
  const branding = useBranding()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // obj 900497: "Email me a sign-in link" — only when this site has its own email set up.
  const [linkToken] = useState(readLinkToken)
  const [emailLinkAvailable, setEmailLinkAvailable] = useState(false)
  const [mode, setMode] = useState<'password' | 'email'>('password')
  useEffect(() => {
    let alive = true
    fetch('/api/auth/email-link', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : { available: false }))
      .then((b: { available?: boolean }) => { if (alive) setEmailLinkAvailable(!!b.available) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      await login(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const poweredBy = branding.powered_by ? (
    <p className="text-xs text-fg-3">Powered by {branding.default_name}</p>
  ) : null

  if (linkToken) return <EmailLinkRedeem token={linkToken} brandName={branding.name} footer={poweredBy} />
  if (mode === 'email') return <EmailLinkRequest brandName={branding.name} onBack={() => setMode('password')} footer={poweredBy} />

  return (
    <AuthCard
      title={`Sign in to ${branding.name}`}
      error={error || undefined}
      footer={
        (emailLinkAvailable || poweredBy) && (
          <>
            {emailLinkAvailable && <AuthLink onClick={() => setMode('email')}>Email me a sign-in link instead</AuthLink>}
            {poweredBy}
          </>
        )
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Username" id="username">
          <Input
            autoComplete="username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
            required
          />
        </Field>

        <Field label="Password" id="password">
          <Input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </Field>

        <Button type="submit" variant="primary" loading={loading} className="w-full">
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  )
}
