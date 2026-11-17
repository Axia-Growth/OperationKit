/**
 * Objective Brief panel — extracted from SessionViewer.tsx (behavior frozen).
 */
import { GitPullRequest, GitMerge, GitPullRequestClosed } from 'lucide-react'
import type { ClosedOverReview, Objective, ObjectiveReview, ObjectivePR } from '@operationkit/shared'
import { renderMarkdown } from '../../lib/markdown'
import { AcceptanceCriteriaResults } from '../AcceptanceCriteriaResults'
import { Card, Badge, cn } from '../ui'
import { formatCost, formatDateTime, humanize } from '../../lib/format'
import { SpendPanel } from './SpendPanel'

/** Who closed it, in plain words, from the audit actor. */
function closedBy(by: string | null): string {
  if (!by) return 'unknown'
  if (by === 'user') return 'a person'
  if (by === 'state-poller' || by === 'machine') return 'the system'
  return by.startsWith('bot:') ? by.slice(4) || 'a bot' : by
}

export function closedOverReviewLine(c: ClosedOverReview): string {
  const reason = c.reason?.trim()
  return `Closed without a passing review by ${closedBy(c.by)}${reason ? `: ${reason}` : '.'}`
}

export function BriefPanel({
  objective,
  reviews,
  prs,
}: {
  objective: Objective
  reviews: ObjectiveReview[]
  prs: ObjectivePR[]
}) {
  return (
    <div className="border-b border-line bg-surface-2/40">
      <div className="mx-auto max-w-4xl space-y-3 px-4 py-3">
        {/* Metadata row */}
        <div className="flex flex-wrap items-center gap-1.5">
          {objective.agent_context && (
            <Badge tone="accent" className="uppercase">{objective.agent_context.toUpperCase()}</Badge>
          )}
          {objective.category && <Badge tone="neutral">{objective.category}</Badge>}
          {objective.workspace && <Badge tone="neutral">{objective.workspace}</Badge>}
          {objective.project && <Badge tone="info">{objective.project}</Badge>}
          {objective.pr_url && (
            <a href={objective.pr_url} target="_blank" rel="noopener noreferrer" className="inline-flex">
              <Badge tone="verify" mono className="transition-colors hover:bg-success/20">
                <GitPullRequest className="h-2.5 w-2.5" />
                #{objective.pr_number || ''}
              </Badge>
            </a>
          )}
          {objective.branch_name && !objective.pr_url && (
            <Badge tone="neutral" mono>{objective.branch_name}</Badge>
          )}
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
          {Number(objective.session_count) > 0 && (
            <span>{objective.session_count} session{objective.session_count !== 1 ? 's' : ''}</span>
          )}
          {Number(objective.total_cost_usd) > 0 && (
            <span>{formatCost(objective.total_cost_usd)} cost</span>
          )}
          {Number(objective.total_tokens) > 0 && (
            <span>{(Number(objective.total_tokens) / 1000).toFixed(0)}k tokens</span>
          )}
        </div>

        {/* Spend: ceiling, spent so far, projection (obj 900909) */}
        <SpendPanel objectiveId={objective.id} status={objective.status} />

        {/* Last session summary */}
        {objective.last_session_summary && (
          <Card inset className="px-3 py-2">
            <div className="mb-1 text-xs uppercase text-fg-3 font-semibold tracking-eyebrow">Last session summary</div>
            <div className="text-xs leading-relaxed text-fg-1">{objective.last_session_summary}</div>
          </Card>
        )}

        {/* Approved plan from the planning stage */}
        {objective.approved_plan && (
          <Card inset className="border-status-planning/30 bg-status-planning/[0.06] px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-xs uppercase text-status-planning font-semibold tracking-eyebrow">
              <span>Approved plan</span>
              {objective.plan_approved_at && (
                <span className="font-normal text-fg-3" title={formatDateTime(objective.plan_approved_at).title}>approved {formatDateTime(objective.plan_approved_at).label}</span>
              )}
            </div>
            <div
              className="max-h-64 overflow-y-auto rounded bg-surface-0/50 px-2 py-1.5 text-xs leading-relaxed text-fg-1"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(objective.approved_plan) }}
            />
          </Card>
        )}

        {/* AI Review findings */}
        {objective.ai_review_findings && (() => {
          const verdict = objective.ai_review_verdict
          const tone = verdict === 'pass' ? 'verify' : verdict === 'fail' ? 'alarm' : 'amber'
          const ring = verdict === 'pass' ? 'border-success/30 bg-success/[0.07]'
            : verdict === 'fail' ? 'border-danger/30 bg-danger/[0.07]'
            : 'border-warning/30 bg-warning/[0.07]'
          return (
            <Card inset className={cn('px-3 py-2', ring)}>
              <div className="mb-1 flex items-center gap-2 text-xs uppercase text-fg-2 font-semibold tracking-eyebrow">
                <span>AI review findings</span>
                <Badge tone={tone} className="uppercase">{verdict ? humanize(verdict) : '—'}</Badge>
              </div>
              <div
                className="max-h-64 overflow-y-auto rounded bg-surface-0/50 px-2 py-1.5 text-xs leading-relaxed text-fg-1"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(objective.ai_review_findings) }}
              />
            </Card>
          )
        })()}

        {/* obj 900959: the reviewer session failed, so there is no verdict. */}
        {!objective.ai_review_verdict && objective.review_runner_failure && (
          <Card inset className="px-3 py-2" data-testid="review-not-run">
            <div className="mb-1 flex items-center gap-2 text-xs uppercase text-fg-2 font-semibold tracking-eyebrow">
              <span>AI review</span>
              <Badge tone="neutral" className="uppercase">Not reviewed</Badge>
            </div>
            <div className="text-xs leading-relaxed text-fg-1">{objective.review_runner_failure.reason}</div>
          </Card>
        )}

        {/* obj 900959: one plain line when the card was closed over a non-pass review. */}
        {objective.closed_over_review && (
          <p className="text-xs text-fg-2" data-testid="closed-over-review">
            {closedOverReviewLine(objective.closed_over_review)}
          </p>
        )}

        {/* AI Review — per-criterion results (latest iteration) */}
        {reviews.length > 0 && (
          <AcceptanceCriteriaResults review={reviews[reviews.length - 1]} />
        )}

        {/* Pull Requests — full per-objective PR log (obj 2300). Every PR opened
            from this objective, newest-first, each a link with a live state badge.
            Hidden entirely when there are none. */}
        {prs.length > 0 && (
          <Card inset className="px-3 py-2">
            <div className="mb-1.5 flex items-center gap-2 text-xs uppercase text-fg-3 font-semibold tracking-eyebrow">
              <GitPullRequest className="h-3 w-3" />
              <span>Pull requests</span>
              <span className="text-fg-3">{prs.length}</span>
            </div>
            <ul className="space-y-1">
              {prs.map(pr => {
                const tone = pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'alarm' : 'info'
                const StateIcon = pr.state === 'merged' ? GitMerge : pr.state === 'closed' ? GitPullRequestClosed : GitPullRequest
                return (
                  <li key={pr.id}>
                    <a
                      href={pr.pr_url || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-surface-3/60"
                    >
                      <StateIcon className="h-3.5 w-3.5 shrink-0 text-fg-3" />
                      <span className="shrink-0 font-mono text-xs text-fg-2 group-hover:text-fg-0">#{pr.pr_number}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-fg-1 group-hover:text-fg-0">
                        {pr.title || pr.branch_name || pr.repo || 'Pull request'}
                      </span>
                      <Badge tone={tone} className="shrink-0 uppercase">{humanize(pr.state)}</Badge>
                    </a>
                  </li>
                )
              })}
            </ul>
          </Card>
        )}

        {/* Description */}
        {objective.description ? (
          <div>
            <div className="mb-1 text-xs uppercase text-fg-3 font-semibold tracking-eyebrow">Description</div>
            <div
              className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-0/50 px-3 py-2 font-mono text-base leading-relaxed text-fg-1"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(objective.description) }}
            />
          </div>
        ) : (
          <p className="text-base italic text-fg-3">No description</p>
        )}
      </div>
    </div>
  )
}
