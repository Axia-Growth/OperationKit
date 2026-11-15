/**
 * "Sign in with Claude" for a Claude seat (obj 720330) — the browser version of
 * `claude setup-token`. The server starts an OAuth + PKCE login and keeps the
 * verifier; we show the link, the operator signs in on claude.ai, copies the
 * "Authentication code" Claude shows (`code#state`) and pastes it here. The
 * server exchanges it, saves the seat and runs its CLAUDE-OK test turn.
 *
 * Used for a new seat (no seatId) and to reconnect an existing one (seatId):
 * the server binds the link to that seat and replaces its credential in place.
 *
 * Reliability (obj 720330): one submit at a time (a double-click or a double
 * Enter sends ONE request), and if the reply is lost (timeout / network) the
 * operator can press "Try again" — the server replays the first result for this
 * link instead of exchanging the single-use code twice or adding a second seat.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError } from '../../lib/api'
import { ExternalLink } from 'lucide-react'
import { Alert, Button, Field, Input, Skeleton, cn } from '../../components/ui'

export type ClaudeSignInOutcome = 'healthy' | 'unparked' | 'parked' | 'rate_limited' | 'inconclusive' | 'skipped'

interface StartResponse { ok: boolean; loginId: string; url: string; expiresAt: string }
interface FinishResponse<S> { ok: boolean; outcome: ClaudeSignInOutcome; seat: S }

/** Errors after which this link is dead and only a new link helps. */
const DEAD_LINK = new Set(['expired', 'unknown_login', 'too_many_attempts', 'not_subscription', 'wrong_seat', 'seat_not_found'])

/** The request may have reached the server: a timeout, a dropped connection or a gateway error. */
function replyLost(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true
  return err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504
}

// One primary per view (polish F5): the sign-in link is the primary until it has
// been opened; then "Connect seat" (the next step) takes the accent.
const LINK_BASE =
  'inline-flex min-h-[44px] select-none items-center justify-center gap-2 rounded-md border px-4 ' +
  'text-sm font-medium tracking-tight transition-colors duration-fast ease-out ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[36px]'
const LINK_PRIMARY = LINK_BASE + ' border-transparent bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-press'
const LINK_SECONDARY = LINK_BASE + ' border-line bg-surface-2 text-fg-0 hover:border-line-strong hover:bg-surface-3'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}


export function SeatClaudeSignIn<S>({
  seatId,
  label,
  onSuccess,
  onCancel,
}: {
  seatId?: string
  /** Label for a new seat (ignored when reconnecting). */
  label?: string
  onSuccess: (seat: S, outcome: ClaudeSignInOutcome) => void
  onCancel: () => void
}) {
  const [phase, setPhase] = useState<'starting' | 'ready' | 'start_error'>('starting')
  const [link, setLink] = useState<StartResponse | null>(null)
  const [code, setCode] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState<{ text: string; dead: boolean; retry?: boolean } | null>(null)
  const [opened, setOpened] = useState(false)
  const alive = useRef(true)
  const generation = useRef(0)
  const onSuccessRef = useRef(onSuccess)
  onSuccessRef.current = onSuccess
  // One request at a time, decided synchronously (state updates are too late for a double Enter).
  const submitting = useRef(false)
  // Held ONLY so "Try again" can resend after a lost reply; never rendered, cleared on any outcome.
  const lastPaste = useRef('')

  const start = useCallback(async () => {
    const mine = ++generation.current
    setPhase('starting')
    setError(null)
    setOpened(false)
    setCode('')
    lastPaste.current = ''
    try {
      const r = await api.post<StartResponse>('/admin/seats/claude-oauth/start', seatId ? { seatId } : {})
      if (!alive.current || mine !== generation.current) return
      setLink(r)
      setPhase('ready')
    } catch (err) {
      if (!alive.current || mine !== generation.current) return
      setError({ text: err instanceof ApiError ? (err.body as { error?: string } | null)?.error || err.message : 'Could not start the sign-in.', dead: true })
      setPhase('start_error')
    }
  }, [seatId])

  useEffect(() => {
    alive.current = true
    void start()
    return () => { alive.current = false; lastPaste.current = '' }
  }, [start])

  const finish = async (e: FormEvent) => {
    e.preventDefault()
    const pasted = code.trim()
    if (!link || submitting.current) return
    if (!pasted) {
      setError({ text: 'Paste the authentication code Claude showed you.', dead: false })
      return
    }
    // The code is single-use; drop it from state before the request goes out.
    setCode('')
    await send(pasted)
  }

  const send = async (pasted: string) => {
    if (!link || submitting.current) return
    submitting.current = true
    lastPaste.current = pasted
    setFinishing(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { loginId: link.loginId, code: pasted }
      if (seatId) body.seatId = seatId
      else if (label?.trim()) body.label = label.trim()
      // The server also runs the seat's test turn, which can take up to ~45s.
      const r = await api.post<FinishResponse<S>>('/admin/seats/claude-oauth/finish', body, { timeoutMs: 90_000 })
      lastPaste.current = ''
      if (!alive.current) return
      onSuccessRef.current(r.seat, r.outcome)
    } catch (err) {
      if (!alive.current) return
      const b = err instanceof ApiError ? (err.body as { error?: string; code?: string } | null) : null
      const lost = replyLost(err) && b?.code !== 'exchange_failed'
      if (!lost) lastPaste.current = ''
      setError({
        text: lost
          ? 'We did not hear back from the server. Press Try again: it picks up the same sign-in, so it will not add a second seat.'
          : b?.error || (err instanceof Error ? err.message : 'Signing in failed.'),
        dead: !lost && DEAD_LINK.has(b?.code || ''),
        retry: lost,
      })
    } finally {
      submitting.current = false
      if (alive.current) setFinishing(false)
    }
  }

  const cancel = () => {
    alive.current = false
    lastPaste.current = ''
    if (link) void api.post('/admin/seats/claude-oauth/cancel', { loginId: link.loginId }).catch(() => {})
    onCancel()
  }

  if (phase === 'starting') {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Preparing the sign-in link">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-11 w-44 sm:h-9" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-11 w-full sm:h-9" />
      </div>
    )
  }

  if (phase === 'start_error') {
    return (
      <div className="space-y-3">
        <Alert tone="alarm" title="The sign-in did not start">{error?.text}</Alert>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void start()}>Try again</Button>
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
        </div>
      </div>
    )
  }

  const codeId = `claude-code-${seatId || 'new'}`
  return (
    <form onSubmit={finish} className="space-y-4" aria-label={seatId ? 'Reconnect with Claude' : 'Sign in with Claude'}>
      <ol className="space-y-4 text-sm text-fg-2">
        <li className="space-y-2">
          <p className="text-fg-1">
            <span className="font-mono text-fg-3">1.</span> Open Claude and sign in with the subscription account (Pro, Max or Team).
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a href={link?.url} target="_blank" rel="noopener noreferrer" className={opened ? LINK_SECONDARY : LINK_PRIMARY} onClick={() => setOpened(true)}>
              Sign in with Claude <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            </a>
            {link && <span className="text-xs text-fg-3">Link works until {fmtTime(link.expiresAt)}</span>}
          </div>
        </li>
        <li>
          <Field
            id={codeId}
            labelClassName="font-normal"
            label={<><span className="font-mono text-fg-3">2.</span> Claude shows an <span className="text-fg-0">Authentication code</span>. Copy it and paste it here.</>}
            hint="The code works once. We swap it for a one-year subscription token, store it encrypted and never show it again."
          >
            <Input
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={cn('font-mono', opened && !code && 'border-line-strong')}
              value={code}
              onChange={e => setCode(e.target.value)}
              disabled={finishing}
            />
          </Field>
        </li>
      </ol>

      {finishing && (
        <p className="text-xs text-fg-3" aria-live="polite">Signing in and running a small test turn. This can take up to a minute.</p>
      )}
      {error && (
        <Alert tone="alarm" title={error.text} />
      )}
      <div className="flex flex-wrap gap-2">
        {error?.dead ? (
          <Button type="button" variant="primary" onClick={() => void start()}>Get a new link</Button>
        ) : error?.retry ? (
          <Button type="button" variant="primary" loading={finishing} onClick={() => void send(lastPaste.current)}>Try again</Button>
        ) : (
          <Button type="submit" variant={opened ? 'primary' : 'secondary'} loading={finishing}>{finishing ? 'Connecting…' : seatId ? 'Reconnect seat' : 'Connect seat'}</Button>
        )}
        <Button type="button" variant="ghost" onClick={cancel} disabled={finishing}>Cancel</Button>
      </div>
    </form>
  )
}
