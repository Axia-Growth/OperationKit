import type { ReactNode } from 'react'
import { BrandLogo } from '../BrandLogo'
import { Alert, cn } from '../ui'

/* ─────────────────────────────────────────────────────────
   AuthCard (polish F5, obj 900806) — the ONE shell for every signed-out
   screen: Login, Change password, the email sign-in link (request and
   redeem) and No account. Same width, same card, same type:

     logo
     <h1> "Sign in to {name}"   ← a real heading, not a logo-as-h1
     optional subtitle
     ┌ card ─────────────────┐
     │ error (role=alert)    │
     │ children              │
     └───────────────────────┘
     footer (secondary links, "Powered by …")
   ───────────────────────────────────────────────────────── */
export function AuthCard({
  title,
  subtitle,
  error,
  footer,
  children,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  /** Shown at the top of the card as a role=alert Alert. */
  error?: ReactNode
  footer?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className="flex min-h-full items-center justify-center bg-surface px-4 py-10">
      <div className={cn('w-full max-w-sm', className)}>
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandLogo size="lg" />
          <h1 className="mt-6 text-xl font-semibold leading-snug text-fg-0">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm leading-relaxed text-fg-2">{subtitle}</p>}
        </div>
        <div className="space-y-4 rounded-xl border border-line bg-surface-1 p-6">
          {error && <Alert tone="alarm" role="alert" title={error} />}
          {children}
        </div>
        {footer && <div className="mt-4 flex flex-col items-center gap-3 text-center text-sm text-fg-2">{footer}</div>}
      </div>
    </div>
  )
}

/** Quiet text link for the AuthCard footer ("Email me a sign-in link instead"). */
export function AuthLink({ onClick, href, children }: { onClick?: () => void; href?: string; children: ReactNode }) {
  const cls =
    'rounded text-sm text-fg-2 underline-offset-4 outline-none transition-colors duration-fast hover:text-fg-0 hover:underline focus-visible:ring-2 focus-visible:ring-accent/50'
  return href ? (
    <a href={href} className={cls}>
      {children}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  )
}
