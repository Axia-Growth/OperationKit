import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, GitPullRequest, LayoutGrid } from 'lucide-react'
import {
  NEEDS_YOU_LABELS,
  REVIEW_STAGE_LABELS,
  WORK_GROUPS,
  WORK_GROUP_LABELS,
  type BotWorkCard,
  type BotWorkView,
  type WorkGroup,
} from '@operationkit/shared'
import { api } from '../../lib/api'
import { Alert, Badge, ProgressBar, Skeleton, cn } from '../ui'
import { BotStatusDot, ago, usd } from './BotLiveStatus'
import type { ChatAgentInfo } from './types'

/* The bot's Work tab (obj 900947): every card the bot owns, grouped Running /
   In review / Queued / Recently done. Each card shows spend against its
   ceiling (PR 794's per-effort default or an explicit one) and its PR.
   Read-only; it only links out to the card and the board. */

const EMPTY_TEXT: Record<WorkGroup, string> = {
  running: 'Nothing running right now.',
  review: 'Nothing waiting for review.',
  queued: 'Nothing queued.',
  done: 'Nothing finished in the last 7 days.',
}

function ceilingSource(c: Pick<BotWorkCard, 'ceiling_source' | 'ceiling_is_default'>): string {
  const s = c.ceiling_source ?? ''
  if (c.ceiling_is_default) return `default for ${s.replace(/^default:/, '') || 'normal'} effort`
  if (s === 'objective') return 'set on this card'
  if (s.startsWith('workspace:')) return 'workspace limit'
  return 'board limit'
}

/** Spend against the card's ceiling: a bar plus "$3.20 of $10.00". */
export function SpendMeter({ spent, ceiling, source }: { spent: number; ceiling: number | null; source?: string }) {
  if (ceiling == null || ceiling <= 0) {
    return <span className="text-xs tabular-nums text-fg-2">{usd(spent)} spent · no ceiling</span>
  }
  const pct = (spent / ceiling) * 100
  const tone = pct >= 100 ? 'alarm' : pct >= 80 ? 'amber' : 'accent'
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="spend-meter" data-over={pct >= 100 ? '1' : '0'}>
      <ProgressBar pct={pct} tone={tone} label={`Spend ${usd(spent)} of ${usd(ceiling)} ceiling`} className="h-1.5 w-20 shrink-0" />
      <span className={cn('truncate text-xs tabular-nums', pct >= 100 ? 'font-medium text-danger' : 'text-fg-2')}>
        {usd(spent)} of {usd(ceiling)}
        {source && <span className="text-fg-3"> · {source}</span>}
      </span>
    </span>
  )
}

function WorkCardRow({ c }: { c: BotWorkCard }) {
  return (
    <li
      data-testid="work-card"
      data-card={c.id}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border bg-surface-1 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3',
        c.needs_you.length > 0 ? 'border-status-human/40' : 'border-line',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={`/o/${c.id}`}
            className="min-w-0 truncate text-sm font-medium text-fg-0 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <span className="font-mono text-fg-2">#{c.id}</span> {c.title}
          </Link>
          {c.is_wake && <Badge tone="neutral">Wake</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <SpendMeter spent={c.spent_usd} ceiling={c.ceiling_usd} source={ceilingSource(c)} />
          <span className="text-xs text-fg-3">{c.workspace} · {ago(c.updated_at)}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {c.needs_you.map(r => (
          <Badge key={r} tone="accent" className="border-status-human/40 bg-status-human/10 text-status-human">
            {NEEDS_YOU_LABELS[r]}
          </Badge>
        ))}
        {c.group === 'review' && c.needs_you.length === 0 && c.review_stage && c.review_stage !== 'not_review' && (
          <span data-testid="work-card-review-stage">
            <Badge tone="neutral">{REVIEW_STAGE_LABELS[c.review_stage]}</Badge>
          </span>
        )}
        {c.pr_url && (
          <a
            href={c.pr_url}
            target="_blank"
            rel="noreferrer"
            data-testid="work-card-pr"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
            PR #{c.pr_url.match(/\/pull\/(\d+)/)?.[1] ?? ''}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </div>
    </li>
  )
}

export function BotWorkTab({ agent }: { agent: Pick<ChatAgentInfo, 'slug' | 'name'> }) {
  const [view, setView] = useState<BotWorkView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      setView(await api.get<BotWorkView>(`/agent-chat/agents/${encodeURIComponent(agent.slug)}/work`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this bot\'s work')
    }
  }, [agent.slug])
  useEffect(() => {
    void load()
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load()
    }, 30_000)
    return () => clearInterval(t)
  }, [load])

  if (error && !view) return <div className="p-4"><Alert tone="alarm">{error}</Alert></div>
  if (!view) {
    return (
      <div className="mx-auto max-w-[860px] space-y-3 p-4" aria-busy="true" aria-label="Loading work">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[860px] space-y-5 px-3 py-4 sm:px-6" data-testid="bot-work-tab">
      <div className="flex flex-wrap items-center gap-2">
        <BotStatusDot state={view.state} />
        <p className="min-w-0 flex-1 truncate text-sm text-fg-1">{view.line}</p>
        <Link
          to={`/?owner=${encodeURIComponent(view.owner_token)}`}
          data-testid="work-open-board"
          className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-fg-1 transition-colors duration-fast hover:bg-surface-3 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <LayoutGrid className="h-4 w-4" aria-hidden="true" />
          Open on board
        </Link>
      </div>
      {view.workspaces.length === 0 && (
        <Alert tone="info">{agent.name} has no workspace you can see, so there is no work to show.</Alert>
      )}
      {WORK_GROUPS.map(g => {
        const cards = view.groups[g]
        return (
          <section key={g} aria-labelledby={`work-${g}`} data-testid={`work-group-${g}`}>
            <h3 id={`work-${g}`} className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-eyebrow text-fg-2">
              {WORK_GROUP_LABELS[g]}
              <span className="font-mono text-fg-3">{cards.length}</span>
            </h3>
            {cards.length > 0 ? (
              <ul className="space-y-1.5">
                {cards.map(c => <WorkCardRow key={c.id} c={c} />)}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-sm text-fg-3">{EMPTY_TEXT[g]}</p>
            )}
          </section>
        )
      })}
    </div>
  )
}
