import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, GitPullRequest } from 'lucide-react'
import {
  NEEDS_YOU_LABELS,
  type BotActivityCardRef,
  type BotActivityEntry,
  type BotActivityResponse,
  type BotActivityRun,
} from '@operationkit/shared'
import { api } from '../../lib/api'
import { Alert, Badge, EmptyState, Skeleton, SkeletonText, cn } from '../ui'
import { SpendMeter } from './BotWorkTab'
import { ago, clock, usd } from './BotLiveStatus'
import type { ChatAgentInfo } from './types'

/* High Agency Activity (obj 900947). Each wake is one entry — when it ran, the
   card it picked, what it did, the PR and what it cost — and expands into the
   full run. A daily summary sits on top: what shipped, spend, what's next.
   This is where wake activity lives now; the main chat only hears from a bot
   when it needs the person. */

function PrLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
      PR #{url.match(/\/pull\/(\d+)/)?.[1] ?? ''}
    </a>
  )
}

function CardRef({ c }: { c: BotActivityCardRef }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Link to={`/o/${c.id}`} className="min-w-0 truncate text-sm text-fg-0 hover:text-accent hover:underline">
        <span className="font-mono text-fg-2">#{c.id}</span> {c.title}
      </Link>
      <span className="shrink-0 text-xs text-fg-3">{c.status}</span>
    </span>
  )
}

function DailySummary({ data, agentName }: { data: BotActivityResponse; agentName: string }) {
  const s = data.summary
  return (
    <section
      aria-labelledby="activity-summary"
      data-testid="activity-summary"
      className="rounded-lg border border-line bg-surface-1 p-4"
    >
      <h3 id="activity-summary" className="text-xs font-medium uppercase tracking-eyebrow text-fg-2">Last 24 hours</h3>
      <dl className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)]">
        <div>
          <dt className="text-xs text-fg-2">Shipped</dt>
          <dd className="mt-1 space-y-1" data-testid="summary-shipped">
            {s.shipped.length === 0 ? (
              <span className="text-sm text-fg-3">Nothing finished.</span>
            ) : (
              s.shipped.slice(0, 4).map(c => (
                <div key={c.id} className="flex min-w-0 items-center gap-2">
                  <CardRef c={c} />
                  {c.pr_url && <PrLink url={c.pr_url} />}
                </div>
              ))
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-2">Spend</dt>
          <dd className="mt-1 font-display text-2xl font-semibold tabular-nums text-fg-0" data-testid="summary-spend">{usd(s.spent_usd)}</dd>
          <dd className="text-xs text-fg-3">{s.wakes} wake{s.wakes === 1 ? '' : 's'}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-2">Next</dt>
          <dd className="mt-1 space-y-1 text-sm text-fg-1" data-testid="summary-next">
            {s.next.needs_you > 0 && (
              <div className="font-medium text-status-human">{s.next.needs_you} card{s.next.needs_you === 1 ? '' : 's'} need{s.next.needs_you === 1 ? 's' : ''} you</div>
            )}
            {s.next.next_wake_at ? (
              <div>Next wake {clock(s.next.next_wake_at)}</div>
            ) : (
              <div className="text-fg-3">{data.high_agency ? 'No wake scheduled' : `High Agency is off for ${agentName}`}</div>
            )}
            {s.next.queued.map(q => (
              <div key={q.id} className="truncate">
                <span className="text-fg-3">Queued </span>
                <Link to={`/o/${q.id}`} className="hover:text-accent hover:underline"><span className="font-mono text-fg-2">#{q.id}</span> {q.title}</Link>
              </div>
            ))}
          </dd>
        </div>
      </dl>
    </section>
  )
}

function RunDetail({ slug, wakeId }: { slug: string; wakeId: number }) {
  const [run, setRun] = useState<BotActivityRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api
      .get<{ run: BotActivityRun }>(`/agent-chat/agents/${encodeURIComponent(slug)}/activity/${wakeId}`)
      .then(r => live && setRun(r.run))
      .catch(e => live && setError(e instanceof Error ? e.message : 'Could not load this run'))
    return () => { live = false }
  }, [slug, wakeId])
  if (error) return <Alert tone="alarm">{error}</Alert>
  if (!run) return <SkeletonText lines={3} />
  return (
    <div className="space-y-3" data-testid="activity-run">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2">
        <Link to={`/o/${run.wake_id}`} className="font-medium text-accent hover:underline">Open wake card #{run.wake_id}</Link>
        <span>{run.workspace}</span>
        {run.disposition && <span>Disposition: {run.disposition}</span>}
        <SpendMeter spent={run.wake_spent_usd} ceiling={run.ceiling_usd} />
      </div>
      {run.review_note && (
        <div>
          <h4 className="text-xs font-medium text-fg-2">Report</h4>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-fg-1">{run.review_note}</p>
        </div>
      )}
      {run.summary && (
        <div>
          <h4 className="text-xs font-medium text-fg-2">Full run summary</h4>
          <p className="mt-0.5 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md border border-line-soft bg-surface-0 p-2.5 text-sm text-fg-1">{run.summary}</p>
        </div>
      )}
      <div>
        <h4 className="text-xs font-medium text-fg-2">Cards this wake filed</h4>
        {run.children.length === 0 ? (
          <p className="mt-0.5 text-sm text-fg-3">None.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {run.children.map(c => (
              <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                <CardRef c={c} />
                <span className="text-xs tabular-nums text-fg-2">{usd(c.spent_usd)}</span>
                {c.pr_url && <PrLink url={c.pr_url} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function ActivityEntryRow({ e, slug, open, onToggle }: { e: BotActivityEntry; slug: string; open: boolean; onToggle: () => void }) {
  const panelId = `wake-${e.wake_id}-run`
  return (
    <li data-testid="activity-entry" data-wake={e.wake_id} className={cn('rounded-lg border bg-surface-1', e.needs_you.length > 0 ? 'border-status-human/40' : 'border-line')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-fg-2" aria-hidden="true" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-fg-2" aria-hidden="true" />}
        <span className="w-16 shrink-0 text-xs tabular-nums text-fg-2">
          <span className="block text-fg-1">{clock(e.at)}</span>
          {ago(e.at)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg-0">{e.did}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-2">
            {e.picked ? (
              <span className="truncate">Picked <span className="font-mono">#{e.picked.id}</span> {e.picked.title}</span>
            ) : (
              <span className="text-fg-3">No card picked</span>
            )}
            {e.pr_url && <span className="inline-flex items-center gap-1 text-accent"><GitPullRequest className="h-3 w-3" aria-hidden="true" />PR</span>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-xs font-medium tabular-nums text-fg-1">{usd(e.cost_usd)}</span>
          {e.needs_you.map(r => (
            <Badge key={r} className="border-status-human/40 bg-status-human/10 text-status-human">{NEEDS_YOU_LABELS[r]}</Badge>
          ))}
        </span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-line-soft px-3 py-3 sm:pl-[6.5rem]">
          <RunDetail slug={slug} wakeId={e.wake_id} />
        </div>
      )}
    </li>
  )
}

export function BotActivityFeed({ agent }: { agent: Pick<ChatAgentInfo, 'slug' | 'name'> }) {
  const [data, setData] = useState<BotActivityResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const load = useCallback(async () => {
    try {
      setData(await api.get<BotActivityResponse>(`/agent-chat/agents/${encodeURIComponent(agent.slug)}/activity`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load activity')
    }
  }, [agent.slug])
  useEffect(() => {
    void load()
  }, [load])
  const toggle = (id: number) =>
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (error && !data) return <div className="p-4"><Alert tone="alarm">{error}</Alert></div>
  if (!data) {
    return (
      <div className="mx-auto max-w-[860px] space-y-3 p-4" aria-busy="true" aria-label="Loading activity">
        <Skeleton className="h-28 w-full rounded-lg" />
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-[860px] space-y-4 px-3 py-4 sm:px-6" data-testid="bot-activity-feed">
      <DailySummary data={data} agentName={agent.name} />
      {data.entries.length === 0 ? (
        <EmptyState
          compact
          title="No wakes yet"
          description={
            data.high_agency
              ? `${agent.name}'s High Agency wakes will show here, one entry per wake.`
              : `High Agency is off for ${agent.name}. An admin can turn it on in this bot's Settings; each wake then shows here instead of in the chat.`
          }
        />
      ) : (
        <ol className="space-y-1.5" aria-label={`${agent.name} High Agency wakes`}>
          {data.entries.map(e => (
            <ActivityEntryRow key={e.wake_id} e={e} slug={agent.slug} open={open.has(e.wake_id)} onToggle={() => toggle(e.wake_id)} />
          ))}
        </ol>
      )}
    </div>
  )
}
