import { useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type Ref } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { ExternalLink, GitPullRequest, Link2, MessageSquareText, SquareArrowOutUpRight } from 'lucide-react'
import { DECISION_LIMITS, decisionLinks, linkSegments, type DecisionView } from '@operationkit/shared'
import { Button, cn } from '../ui'

/* Links and the own-answer box for decisions (obj 901139).

   Operator approved a "merge these PRs" decision and then had no way back to the
   PRs or the card: a decided item showed only "Decided". Now every piece of
   decision text renders its links as links (http(s) URLs open in a new tab,
   "card #N" opens that card's thread), a decided item lists every link it
   mentioned, and every decision takes a free-text answer as the decision. */

const LINK_CLASS = 'break-all text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent'

function CardRef({ id, children }: { id: number; children: string }) {
  // The decision views render inside the router everywhere today; a plain
  // anchor keeps this safe if one ever renders outside it.
  const inRouter = useInRouterContext()
  return inRouter
    ? <Link to={`/o/${id}`} className={LINK_CLASS} data-testid="linked-card">{children}</Link>
    : <a href={`/o/${id}`} className={LINK_CLASS} data-testid="linked-card">{children}</a>
}

/** Text with its URLs and card references clickable. Only http(s) URLs become links. */
export function LinkedText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null
  const segs = linkSegments(text)
  return (
    <span className={className}>
      {segs.map((s, i) =>
        s.kind === 'url' ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS} data-testid="linked-url">
            {s.text}
          </a>
        ) : s.kind === 'card' ? (
          <CardRef key={i} id={s.id}>{s.text}</CardRef>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  )
}

/** "Open card thread" — every decision, open or decided, leads back to its card. */
export function CardThreadLink({ objectiveId, title, className }: { objectiveId: number; title?: string | null; className?: string }) {
  const inRouter = useInRouterContext()
  const body = (
    <>
      <SquareArrowOutUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">Open card thread <span className="font-mono">#{objectiveId}</span>{title ? ` ${title}` : ''}</span>
    </>
  )
  const cls = cn('inline-flex min-w-0 items-center gap-1 text-sm text-accent hover:underline', className)
  return inRouter
    ? <Link to={`/o/${objectiveId}`} className={cls} data-testid="decision-card-link">{body}</Link>
    : <a href={`/o/${objectiveId}`} className={cls} data-testid="decision-card-link">{body}</a>
}

/** Every link a decision mentioned (PRs first). Renders nothing when there are none. */
export function DecisionLinkList({ decision, className }: { decision: DecisionView; className?: string }) {
  const links = decisionLinks(decision)
  if (!links.length) return null
  return (
    <section className={cn('mt-3', className)} aria-label="Links in this decision" data-testid="decision-links">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-eyebrow text-fg-3">
        <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> Links in this decision
      </h4>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {links.map(l => (
          <li key={l.href} className="min-w-0 max-w-full">
            {l.kind === 'card' ? (
              <CardRef id={Number(l.href.slice(3))}>{l.label}</CardRef>
            ) : (
              <a
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="decision-link"
                data-kind={l.kind}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-fg-1 hover:border-accent hover:text-accent"
              >
                {l.kind === 'pr' ? <GitPullRequest className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                <span className="truncate">{l.label}</span>
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The free-text answer: the person's own words ARE the decision. Logged as
 * their choice, posted into the card thread as their message, the worker is
 * resumed with it and the ask clears. Separate from the Q&A thread (that one is
 * for questions before deciding). Cmd/Ctrl+Enter sends.
 */
export function OwnAnswerForm({
  decisionId,
  onSubmit,
  busy,
  disabled,
  inputRef,
  who = 'the bot',
  className,
}: {
  decisionId: number
  onSubmit: (answer: string) => Promise<boolean | void> | boolean | void
  busy?: boolean
  disabled?: boolean
  inputRef?: Ref<HTMLTextAreaElement>
  who?: string
  className?: string
}) {
  const [text, setText] = useState('')
  const id = `own-answer-${decisionId}`
  const send = async () => {
    const v = text.trim()
    if (!v || busy || disabled) return
    const ok = await onSubmit(v)
    if (ok !== false) setText('')
  }
  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault()
    void send()
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
    }
  }
  return (
    <form onSubmit={onFormSubmit} className={cn('space-y-1.5', className)} data-testid="own-answer-form">
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-eyebrow text-fg-3">
        <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" /> Or answer in your own words
      </label>
      <textarea
        id={id}
        ref={inputRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        maxLength={DECISION_LIMITS.ownAnswerMax}
        disabled={disabled}
        placeholder={`Your decision, e.g. "You merge the PRs, not me." It goes to ${who} as your answer.`}
        className="block w-full resize-y rounded-md border border-line bg-surface-field px-2.5 py-1.5 text-base text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60 sm:text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={disabled || !text.trim()}>
          Send as my decision
        </Button>
        <span className="hidden text-xs text-fg-3 sm:inline">Logged as your choice, posted in the card thread, and the work resumes with it.</span>
      </div>
    </form>
  )
}
