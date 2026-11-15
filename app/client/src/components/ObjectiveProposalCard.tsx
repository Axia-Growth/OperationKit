import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { friendlyError, humanize } from '../lib/format'
import { Button, RowButton } from './ui'

interface ObjectiveProposal {
  title: string
  description: string
  workspace: string
  project?: string | null
  priority?: 'high' | 'medium' | 'low'
}

const PRIORITY_CLASSES: Record<string, string> = {
  high: 'bg-danger/10 border-danger/30 text-danger',
  medium: 'bg-warning/10 border-warning/30 text-warning',
  low: 'bg-surface-3 border-line text-fg-2',
}

const DESC_LIMIT = 120

export function ObjectiveProposalCard({ raw }: { raw: string }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<{ message: string; detail: string } | null>(null)
  const [expanded, setExpanded] = useState(false)

  let proposal: ObjectiveProposal | null = null
  let parseError: string | null = null
  let parsedFields: [string, string][] = []

  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsedFields = Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
        humanize(k),
        typeof v === 'string' ? v : v == null ? '—' : JSON.stringify(v),
      ])
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).title !== 'string'
    ) {
      throw new Error('This suggestion has no title.')
    }
    proposal = parsed as ObjectiveProposal
  } catch (e) {
    parseError = e instanceof SyntaxError ? 'This suggestion could not be read.' : e instanceof Error ? e.message : 'This suggestion could not be read.'
  }

  if (parseError || !proposal) {
    return (
      <div className="my-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-base">
        <div className="font-medium text-danger mb-1">This card suggestion is incomplete</div>
        <div className="text-xs text-fg-2">{parseError}</div>
        {parsedFields.length > 0 && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {parsedFields.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-fg-3">{label}</dt>
                <dd className="min-w-0 break-words text-fg-1">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <details className="mt-2 text-xs text-fg-3">
          <summary className="cursor-pointer">Details</summary>
          <pre className="mt-1 font-mono text-xs text-fg-3 overflow-x-auto whitespace-pre-wrap break-words">{raw}</pre>
        </details>
      </div>
    )
  }

  const { title, description, workspace, project, priority = 'medium' } = proposal
  const priorityCls = PRIORITY_CLASSES[priority] ?? PRIORITY_CLASSES.medium
  const isLong = description.length > DESC_LIMIT
  const visibleDesc =
    expanded || !isLong ? description : description.slice(0, DESC_LIMIT).trimEnd() + '…'

  const handleCreate = async () => {
    setStatus('loading')
    setErrorMsg(null)
    try {
      const descWithPriority = `[Priority: ${priority}]\n\n${description}`
      const res = await fetch('/api/objectives', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: descWithPriority,
          workspace,
          project: project ?? null,
          agent_context: 'general',
          category: 'general',
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ? `HTTP ${res.status}: ${body.error}` : `HTTP ${res.status}`)
      }
      setStatus('success')
    } catch (e) {
      setErrorMsg(friendlyError(e))
      setStatus('error')
    }
  }

  return (
    <div
      className="my-2 rounded-lg border border-[color:var(--accent-line)] bg-surface-2 p-4 shadow-[inset_3px_0_0_var(--accent-text)]"
      style={{ maxWidth: 'min(85%, 700px)' }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="font-display text-base font-semibold text-fg-0 leading-tight">{title}</div>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs shrink-0 ${priorityCls}`}
        >
          {humanize(priority)}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <span className="inline-flex items-center rounded-full border border-[color:var(--accent-line)] bg-[var(--accent-tint)] px-2 py-0.5 text-xs font-medium text-accent-hover">
          {workspace}
        </span>
        {project && (
          <span className="inline-flex items-center rounded-full border border-line bg-surface-3 px-2 py-0.5 font-mono text-xs text-fg-2">
            {project}
          </span>
        )}
      </div>

      <div className="text-xs text-fg-2 leading-relaxed">
        {visibleDesc}
        {isLong && (
          <RowButton
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
            className="ml-1 rounded-sm text-xs text-accent-hover hover:underline"
          >
            {expanded ? 'show less' : 'show more'}
          </RowButton>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        {status === 'success' ? (
          <a
            href="/"
            className="inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-medium text-success transition-colors hover:bg-success/20"
          >
            View on board
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={handleCreate}
            loading={status === 'loading'}
          >
            {status === 'loading' ? 'Creating…' : 'Create card'}
          </Button>
        )}
        {status === 'error' && errorMsg && (
          <div className="text-xs text-danger">
            Could not create the card. {errorMsg.message}
            {errorMsg.detail && (
              <details className="mt-1 text-xs text-fg-3">
                <summary className="cursor-pointer">Details</summary>
                {errorMsg.detail}
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
