import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBranding } from '../hooks/useBranding'
import { Button, Field, Input } from './ui'
import { AuthCard, AuthLink } from './login/AuthCard'

// Mirrors MIN_PASSWORD_LENGTH in server/src/routes/auth.ts — the server is the authority.
const MIN_LENGTH = 12

/**
 * Shown instead of the app while the signed-in user still holds a one-time setup
 * password (obj 719935). The server refuses every other route until this is done.
 */
export function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth()
  const branding = useBranding()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const tooShort = next.length > 0 && next.length < MIN_LENGTH
  const mismatch = confirm.length > 0 && confirm !== next
  const canSubmit = current.length > 0 && next.length >= MIN_LENGTH && confirm === next && !saving

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    setSaving(true)
    try {
      await changePassword(current, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthCard
      title="Choose a new password"
      subtitle={`Finish setting up your ${branding.name} account`}
      error={error || undefined}
      footer={<AuthLink onClick={() => { void logout() }}>Sign out</AuthLink>}
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <p className="text-sm leading-relaxed text-fg-1">
          Signed in as <span className="font-medium text-fg-0">{user?.username}</span> with a one-time setup password.
          Pick a new one of at least {MIN_LENGTH} characters. You will use it from now on.
        </p>

        <Field label="Setup password" id="current-password">
          <Input type="password" autoComplete="current-password" value={current}
            onChange={e => setCurrent(e.target.value)} autoFocus required />
        </Field>

        <Field
          label="New password"
          id="new-password"
          hint={tooShort
            ? <span className="text-warning">{MIN_LENGTH - next.length} more character{MIN_LENGTH - next.length === 1 ? '' : 's'} needed</span>
            : `At least ${MIN_LENGTH} characters`}
        >
          <Input type="password" autoComplete="new-password" value={next}
            onChange={e => setNext(e.target.value)} invalid={tooShort} required />
        </Field>

        <Field
          label="Type it again"
          id="confirm-password"
          hint={mismatch ? <span className="text-warning">The two passwords do not match yet</span> : undefined}
        >
          <Input type="password" autoComplete="new-password" value={confirm}
            onChange={e => setConfirm(e.target.value)} invalid={mismatch} required />
        </Field>

        <Button type="submit" variant="primary" disabled={!canSubmit} loading={saving} className="w-full">
          {saving ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </AuthCard>
  )
}
