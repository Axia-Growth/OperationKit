import { useAuth } from '../context/AuthContext'
import { useBranding } from '../hooks/useBranding'
import { Button } from './ui'
import { AuthCard } from './login/AuthCard'

/**
 * Cloudflare Access verified this person's email, but no Operation Kit user has
 * it (obj 720332). Never an auto-created account: say so plainly, and offer the
 * two ways out — sign out of Cloudflare to use another email, or the password
 * form (break-glass for an admin whose email is not linked yet).
 */
export function NoAccountPage() {
  const { accessDenied, showPasswordLogin } = useAuth()
  const branding = useBranding()
  if (!accessDenied) return null
  const ambiguous = accessDenied.code === 'ambiguous_account'

  return (
    <AuthCard
      title={ambiguous ? 'This email is on more than one account' : 'No account for this email'}
      subtitle={`You cannot sign in to ${branding.name} with this email yet.`}
    >
      <div role="alert" className="space-y-3">
        <p className="text-sm leading-relaxed text-fg-1">
          You signed in to Cloudflare as{' '}
          <span className="break-words font-medium text-fg-0">{accessDenied.email}</span>
          {ambiguous
            ? ', but more than one account uses that email, so we cannot tell which one is yours.'
            : ', but nobody here has an account with that email.'}
        </p>
        <p className="text-sm leading-relaxed text-fg-2">
          Ask your admin to {ambiguous ? 'fix the email on those accounts' : 'add you, or link this email to your account'} in
          Settings → Workspaces → Users.
        </p>
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <Button variant="primary" className="w-full" onClick={() => window.location.assign(accessDenied.logoutUrl)}>
          Sign out and use another email
        </Button>
        <Button variant="ghost" className="w-full" onClick={showPasswordLogin}>
          Sign in with a username and password
        </Button>
      </div>
    </AuthCard>
  )
}
