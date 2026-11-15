/**
 * Onboarding / setup checklist (obj 900497): 1) Branding → 2) Transactional
 * email → 3) One coding subscription account. Each step links to its settings
 * panel and ticks itself from GET /api/admin/setup-status.
 * 4) Set up your knowledge base (obj 900556) → /knowledge/setup; ticks once any
 * workspace the user can see has a finished setup run (GET /api/kb-setup/status).
 *
 * Links are a prop (override-able) so a caller can repoint them without
 * editing this file. The defaults below point at the settings sidebar now
 * that Sprint 4b (settings reorg) and Sprint 3 (branding panel) are merged.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Circle, ArrowRight } from 'lucide-react'
import { Alert, Badge, Button, Card, CardHeader, Skeleton, cn } from '../ui'
import { emailAgentPrompt, emailApi, type SetupStatus, type SetupStepId } from '../../lib/email'
import { AgentPromptBox } from '../email/AgentPromptBox'
import { KB_SETUP_STEP } from '../kb-setup/KbSetupStep'
import { createKbSetupApi } from '../../lib/kbSetup'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { useAuth } from '../../context/AuthContext'

/** True once any visible workspace has a finished knowledge-base setup run. */
function useKbSetupDone(): boolean {
  const { slugs } = useWorkspaces()
  const [done, setDone] = useState(false)
  const key = slugs.filter(s => s !== 'all').join(',')
  useEffect(() => {
    if (!key) return
    let live = true
    Promise.all(key.split(',').map(ws => createKbSetupApi(ws).status().then(s => !!s.step_done).catch(() => false)))
      .then(r => { if (live) setDone(r.some(Boolean)) })
    return () => { live = false }
  }, [key])
  return done
}

/* A step's action is a router Link, so it cannot be ui/Button; these mirror
   Button's primary / secondary / ghost looks (sm size) for a link. */
const LINK_BASE =
  'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm font-medium transition-colors duration-fast ease-out ' +
  'outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-0'
const LINK_VARIANT = {
  primary: 'border-transparent bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-press',
  secondary: 'border-line bg-surface-2 text-fg-0 hover:border-line-strong hover:bg-surface-3',
  ghost: 'border-transparent text-fg-2 hover:bg-surface-3 hover:text-fg-0',
} as const

export type SetupLinks = Partial<Record<SetupStepId, string>>

/** Defaults: the three settings panels each step owns, now that they're all mounted. */
export const DEFAULT_SETUP_LINKS: SetupLinks = {
  branding: '/settings/branding',
  email: '/settings/email',
  models: '/settings/models',
}

const COPY: Record<SetupStepId, { title: string; body: string }> = {
  branding: {
    title: 'Branding',
    body: 'Your name and logo on the sign-in page, in the app and in every email.',
  },
  email: {
    title: 'Transactional email',
    body: 'Sign-in links, invites and password resets come from your own address.',
  },
  models: {
    title: 'Add one coding subscription account',
    body: 'Connect a Claude, Codex or Grok subscription so agents can start working.',
  },
}

export interface SetupChecklistProps {
  links?: SetupLinks
  /** Bump to force a refresh (e.g. after the Email panel saves). */
  refreshKey?: number
  className?: string
}

export function SetupChecklist({ links = DEFAULT_SETUP_LINKS, refreshKey = 0, className }: SetupChecklistProps) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acking, setAcking] = useState(false)
  const kbDone = useKbSetupDone()
  // Branding, email and models are admin-only settings; a member sees the step
  // and its state but is told to ask an admin rather than offered a dead link.
  const isAdmin = useAuth().user?.role === 'admin'

  const load = useCallback(() => {
    emailApi.setupStatus().then(setStatus).catch(e => setError(e instanceof Error ? e.message : 'Could not load setup status'))
  }, [])
  useEffect(() => { load() }, [load, refreshKey])

  async function keepDefaultBranding(done: boolean) {
    setAcking(true)
    try { setStatus(await emailApi.ackBranding(done)) } finally { setAcking(false) }
  }

  if (error) return <Alert tone="alarm" title="Setup checklist">{error}</Alert>
  if (!status) {
    return (
      <Card className={cn('space-y-3', className)}>
        <Skeleton className="h-5 w-48" />
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
      </Card>
    )
  }

  const doneCount = status.steps.filter(s => s.done).length + (kbDone ? 1 : 0)
  const stepCount = status.steps.length + 1
  const allDone = status.complete && kbDone
  const site = typeof window !== 'undefined' ? window.location.origin : ''

  const extra: Partial<Record<SetupStepId, ReactNode>> = {
    branding: !links.branding ? (
      <div className="space-y-2">
        <p className="text-xs text-fg-3">
          Set <code className="font-mono">OK_BRAND_NAME</code> and drop a <code className="font-mono">logo.svg</code> / <code className="font-mono">logo.png</code> into
          the data folder&apos;s <code className="font-mono">branding/</code> directory (the installer asks for both), or keep the default look.
        </p>
      </div>
    ) : null,
  }

  // One primary action on the page (polish F5): only the NEXT incomplete step
  // gets the accent button; the others are secondary (to do) or ghost (done).
  const nextId: string | null = status.steps.find(s => !s.done)?.id ?? (kbDone ? null : KB_SETUP_STEP.id)
  const linkCls = (stepId: string, done: boolean) =>
    cn(LINK_BASE, done ? LINK_VARIANT.ghost : stepId === nextId ? LINK_VARIANT.primary : LINK_VARIANT.secondary)

  return (
    <Card inset className={className} data-testid="setup-checklist">
      <CardHeader
        title="Set up your workspace"
        actions={<Badge tone={allDone ? 'verify' : 'neutral'}>{doneCount} of {stepCount} done</Badge>}
      />
      <ol className="divide-y divide-line border-t border-line">
        {status.steps.map((step, i) => {
          const copy = COPY[step.id]
          const href = links[step.id]
          return (
            <li key={step.id} className="flex gap-3 px-4 py-3" data-step={step.id} data-done={step.done ? '1' : '0'}>
              <span className="mt-0.5 shrink-0" aria-hidden="true">
                {step.done
                  ? <CheckCircle2 className="h-5 w-5 text-success" />
                  : <Circle className="h-5 w-5 text-fg-3" />}
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-eyebrow text-fg-3">Step {i + 1}</span>
                  <span className={cn('text-base font-medium', step.done ? 'text-fg-2' : 'text-fg-0')}>{copy.title}</span>
                  <span className="sr-only">{step.done ? '(done)' : '(to do)'}</span>
                  {step.id === 'email' && !step.done && step.configured && <Badge tone="amber">send a test</Badge>}
                </div>
                <p className="text-sm text-fg-2">{copy.body}</p>
                {isAdmin && extra[step.id]}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-start">
                {!isAdmin ? (
                  !step.done && <span className="py-1.5 text-sm text-fg-3" data-testid="ask-admin">Ask an admin</span>
                ) : (
                  <>
                    {step.id === 'branding' && !step.done && (
                      <Button size="sm" variant="ghost" loading={acking} onClick={() => keepDefaultBranding(true)}>Keep default</Button>
                    )}
                    {href && (
                      <Link to={href} className={linkCls(step.id, step.done)}>
                        {step.done ? 'Review' : 'Set up'} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    )}
                  </>
                )}
              </div>
            </li>
          )
        })}
        <li className="flex gap-3 px-4 py-3" data-step={KB_SETUP_STEP.id} data-done={kbDone ? '1' : '0'}>
          <span className="mt-0.5 shrink-0" aria-hidden="true">
            {kbDone
              ? <CheckCircle2 className="h-5 w-5 text-success" />
              : <Circle className="h-5 w-5 text-fg-3" />}
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-eyebrow text-fg-3">Step {status.steps.length + 1}</span>
              <span className={cn('text-base font-medium', kbDone ? 'text-fg-2' : 'text-fg-0')}>{KB_SETUP_STEP.title}</span>
              <span className="sr-only">{kbDone ? '(done)' : '(to do)'}</span>
            </div>
            <p className="text-sm text-fg-2">{KB_SETUP_STEP.body}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-start">
            <Link to={KB_SETUP_STEP.href} className={linkCls(KB_SETUP_STEP.id, kbDone)}>
              {kbDone ? 'Add more files' : 'Set up'} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </li>
      </ol>
      {isAdmin && (
        <div className="border-t border-line p-4">
          <AgentPromptBox title="Have your coding agent set up email" prompt={emailAgentPrompt(site)} />
        </div>
      )}
    </Card>
  )
}

export default SetupChecklist
