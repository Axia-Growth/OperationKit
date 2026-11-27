import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Target, X } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { Badge, Button, INPUT_CLS, cn } from '../ui'
import { CardNumber } from '../CardNumber'
import {
  MAX_CHILDREN,
  MAX_CRITERIA,
  normalizeProposal,
  type OutcomeCardDraft,
  type OutcomeCriterion,
  type OutcomeProposal as Proposal,
  type OutcomeRule,
  type ProposalStatus,
} from '../../../../shared/outcome-intake'

/* Outcome-first intake (obj 901764). A bot proposed how the board will deliver
   an outcome the person stated (propose_outcome). This panel shows that
   breakdown IN the chat: the outcome card, its "done when", its acceptance
   criteria, any child cards and the standing rules that will apply. Every line
   is editable. Nothing is filed until the person presses "Approve and start";
   the server then files the cards through the bot's own create path and starts
   the outcome card. The person never picks skills, tools or folders here. */

export interface OutcomeProposalView {
  id: number
  status: ProposalStatus
  workspace: string
  agent_slug: string
  proposal: Proposal
  card_id: number | null
  child_ids: number[]
  start_note: string | null
  cards: { id: number; title: string; status: string }[]
  rules: OutcomeRule[]
  can_edit: boolean
}

const STATUS: Record<ProposalStatus, { label: string; tone: 'amber' | 'verify' | 'neutral' | 'info' }> = {
  pending: { label: 'Waiting for your approval', tone: 'amber' },
  approving: { label: 'Filing…', tone: 'info' },
  approved: { label: 'Approved', tone: 'verify' },
  discarded: { label: 'Discarded', tone: 'neutral' },
}

/** A fresh row. The id only keys the React row; the server re-derives criterion ids. */
const blankCriterion = (): OutcomeCriterion => ({ id: `new-${Math.random().toString(36).slice(2, 10)}`, criterion: '', type: 'functional', method: 'doc' })
const countCriteria = (list: OutcomeCriterion[]): string => {
  const n = list.filter(x => x.criterion.trim()).length
  return `${n} ${n === 1 ? 'criterion' : 'criteria'}`
}
const blankCard = (): OutcomeCardDraft => ({ title: '', brief: '', done_when: '', criteria: [blankCriterion()], stop_conditions: [] })

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : 'Something went wrong'
}

/** Loads one proposal by id. */
export function useOutcomeProposal(id: number) {
  const [view, setView] = useState<OutcomeProposalView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      setView(await api.get<OutcomeProposalView>(`/agent-chat/outcome-proposals/${id}`))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [id])
  useEffect(() => { void load() }, [load])
  return { view, setView, error }
}

/** A proposal rendered inside the bot chat: loads it by id. */
export function ChatOutcomeProposal({ id }: { id: number }) {
  const { view, setView, error } = useOutcomeProposal(id)
  if (error) return <p role="alert" className="text-sm text-danger">Could not load the proposed work: {error}</p>
  if (!view) return <p className="text-sm text-fg-3">Loading the proposed work…</p>
  return <OutcomeProposalPanel view={view} onChange={setView} />
}

function CriteriaEditor({
  criteria,
  onChange,
  editable,
  label,
}: {
  criteria: OutcomeCriterion[]
  onChange: (c: OutcomeCriterion[]) => void
  editable: boolean
  label: string
}) {
  if (!editable) {
    return (
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg-1">
        {criteria.map(c => <li key={c.id}>{c.criterion}</li>)}
      </ul>
    )
  }
  return (
    <div className="space-y-1.5">
      {criteria.map((c, i) => (
        <div key={c.id} className="flex items-center gap-1.5">
          <input
            aria-label={`${label} criterion ${i + 1}`}
            className={cn(INPUT_CLS, 'h-8')}
            value={c.criterion}
            placeholder="One thing a reviewer can check"
            onChange={e => onChange(criteria.map((x, j) => (j === i ? { ...x, criterion: e.target.value } : x)))}
          />
          <button
            type="button"
            aria-label={`Remove ${label} criterion ${i + 1}`}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-3 hover:text-fg-0"
            onClick={() => onChange(criteria.filter((_, j) => j !== i))}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {criteria.length < MAX_CRITERIA && (
        <Button variant="ghost" size="xs" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => onChange([...criteria, blankCriterion()])}>
          Add a criterion
        </Button>
      )}
    </div>
  )
}

function CardEditor({
  card,
  onChange,
  editable,
  label,
}: {
  card: OutcomeCardDraft
  onChange: (c: OutcomeCardDraft) => void
  editable: boolean
  /** "Outcome card" or "Child card 2": used for accessible names. */
  label: string
}) {
  const set = <K extends keyof OutcomeCardDraft>(k: K, v: OutcomeCardDraft[K]) => onChange({ ...card, [k]: v })
  return (
    <div className="space-y-2">
      {editable ? (
        <input aria-label={`${label} title`} className={cn(INPUT_CLS, 'h-9 font-medium')} value={card.title} placeholder="What the result is" onChange={e => set('title', e.target.value)} />
      ) : (
        <p className="font-medium text-fg-0">{card.title}</p>
      )}
      {editable ? (
        <textarea aria-label={`${label} brief`} rows={3} className={cn(INPUT_CLS, 'min-h-[72px] resize-y py-2 leading-relaxed')} value={card.brief} placeholder="What to do, where, and why" onChange={e => set('brief', e.target.value)} />
      ) : (
        <p className="whitespace-pre-wrap text-sm text-fg-1">{card.brief}</p>
      )}
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-fg-2">Done when</p>
        {editable ? (
          <input aria-label={`${label} done when`} className={cn(INPUT_CLS, 'h-8')} value={card.done_when} placeholder="One checkable statement" onChange={e => set('done_when', e.target.value)} />
        ) : (
          <p className="text-sm text-fg-0">{card.done_when}</p>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-fg-2">Acceptance criteria (an independent reviewer checks these)</p>
        <CriteriaEditor criteria={card.criteria} onChange={c => set('criteria', c)} editable={editable} label={label} />
      </div>
      {(editable || card.stop_conditions.length > 0) && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-fg-2">Stop and report if</p>
          {editable ? (
            <textarea
              aria-label={`${label} stop conditions`}
              rows={2}
              className={cn(INPUT_CLS, 'resize-y py-2')}
              value={card.stop_conditions.join('\n')}
              placeholder="One per line (optional)"
              onChange={e => set('stop_conditions', e.target.value.split('\n'))}
            />
          ) : (
            <ul className="list-disc pl-5 text-sm text-fg-1">{card.stop_conditions.map(s => <li key={s}>{s}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The breakdown, editable while it waits for the person. `onChange` receives
 * the server's view after every save / approve / discard.
 */
export function OutcomeProposalPanel({ view, onChange }: { view: OutcomeProposalView; onChange: (v: OutcomeProposalView) => void }) {
  const [draft, setDraft] = useState<Proposal>(view.proposal)
  const [busy, setBusy] = useState<'approve' | 'save' | 'discard' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<{ id: number; title: string } | null>(null)
  useEffect(() => { setDraft(view.proposal) }, [view.proposal])
  // Parts start folded to one line each so a long split stays readable in the chat; a new part opens to be filled in.
  const [openParts, setOpenParts] = useState<Set<number>>(new Set())
  const togglePart = (i: number) => setOpenParts(prev => {
    const next = new Set(prev)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    return next
  })

  const editable = view.status === 'pending' && view.can_edit
  // The same checks the server runs, so the gaps show before the click.
  const check = useMemo(() => normalizeProposal(draft), [draft])
  const gaps = check.ok ? [] : check.errors
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.proposal)
  const st = STATUS[view.status]
  const skip = new Set(draft.skip_rule_ids)

  const run = async (kind: 'approve' | 'save' | 'discard', fileAnyway = false) => {
    setBusy(kind)
    setError(null)
    if (kind !== 'approve' || !fileAnyway) setDuplicate(null)
    try {
      const path = `/agent-chat/outcome-proposals/${view.id}`
      const next = kind === 'save'
        ? await api.put<OutcomeProposalView>(path, { proposal: check.proposal })
        : kind === 'discard'
          ? await api.post<OutcomeProposalView>(`${path}/discard`)
          : await api.post<OutcomeProposalView>(`${path}/approve`, { proposal: check.proposal, ...(fileAnyway ? { file_anyway: true } : {}) }, { timeoutMs: 120_000 })
      setDuplicate(null)
      onChange(next)
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string; duplicate?: { id: number; title: string } } | undefined) : undefined
      if (body?.code === 'duplicate' && body.duplicate) setDuplicate(body.duplicate)
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      aria-label="Proposed work"
      data-testid="outcome-proposal"
      data-status={view.status}
      className={cn('max-w-[640px] rounded-lg border bg-surface-2', view.status === 'pending' ? 'border-line-strong' : 'border-line-soft')}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line-soft px-3.5 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-eyebrow text-fg-1">
          <Target aria-hidden="true" className="h-3.5 w-3.5" />
          Proposed work
        </span>
        <Badge tone={st.tone}>{st.label}</Badge>
      </header>

      <div className="space-y-4 px-3.5 py-3 text-base">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-fg-2">Your outcome</p>
          <blockquote className="border-l-2 border-line-strong pl-3 text-sm italic text-fg-1">{draft.outcome}</blockquote>
        </div>

        <CardEditor card={draft.card} editable={editable} label="Outcome card" onChange={card => setDraft({ ...draft, card })} />

        {(draft.children.length > 0 || editable) && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-eyebrow text-fg-2">
              {draft.children.length > 1 ? `Split into ${draft.children.length} parts that run in parallel` : draft.children.length === 1 ? 'One part under the outcome card' : 'One card, no split'}
            </p>
            {draft.children.map((c, i) => {
              const open = openParts.has(i)
              return (
                <div key={i} className="rounded-md border border-line-soft bg-surface-1 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-fg-2">Part {i + 1}</p>
                      {!open && (
                        <>
                          <p className="truncate text-sm font-medium text-fg-0">{c.title || 'Untitled part'}</p>
                          <p className="text-xs text-fg-2">
                            Done when: {c.done_when || '—'} · {countCriteria(c.criteria)}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="xs" aria-expanded={open} onClick={() => togglePart(i)}>
                        {open ? `Hide part ${i + 1}` : editable ? `Edit part ${i + 1}` : `Show part ${i + 1}`}
                      </Button>
                      {editable && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => {
                            setDraft({ ...draft, children: draft.children.filter((_, j) => j !== i) })
                            setOpenParts(new Set())
                          }}
                        >
                          Remove part {i + 1}
                        </Button>
                      )}
                    </div>
                  </div>
                  {open && (
                    <div className="mt-2">
                      <CardEditor
                        card={c}
                        editable={editable}
                        label={`Part ${i + 1}`}
                        onChange={card => setDraft({ ...draft, children: draft.children.map((x, j) => (j === i ? card : x)) })}
                      />
                    </div>
                  )}
                </div>
              )
            })}
            {editable && draft.children.length < MAX_CHILDREN && (
              <Button variant="ghost" size="xs" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => {
                setOpenParts(prev => new Set(prev).add(draft.children.length))
                setDraft({ ...draft, children: [...draft.children, blankCard()] })
              }}>
                Add a part
              </Button>
            )}
          </div>
        )}

        {/* Suggestions are a choice made at approval; once approved, the saved ones are listed above as rules. */}
        {(view.rules.length > 0 || (view.status === 'pending' && draft.suggested_rules.length > 0)) && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-eyebrow text-fg-2">Standing rules for {view.workspace}</p>
            {view.rules.map(r => (
              <label key={r.id} className="flex items-start gap-2 text-sm text-fg-1">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={!editable}
                  checked={!skip.has(r.id)}
                  onChange={e => setDraft({ ...draft, skip_rule_ids: e.target.checked ? draft.skip_rule_ids.filter(x => x !== r.id) : [...draft.skip_rule_ids, r.id] })}
                />
                <span>
                  {r.text} <span className="text-xs text-fg-3">({r.applies_to === 'pr' ? 'every pull request' : 'every card'}) — apply to these cards</span>
                </span>
              </label>
            ))}
            {view.status === 'pending' && draft.suggested_rules.map((r, i) => (
              <label key={r.text} className="flex items-start gap-2 text-sm text-fg-1">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={!editable}
                  checked={r.save}
                  onChange={e => setDraft({ ...draft, suggested_rules: draft.suggested_rules.map((x, j) => (j === i ? { ...x, save: e.target.checked } : x)) })}
                />
                <span>
                  {r.text} <span className="text-xs text-fg-3">— save as a standing rule for {r.applies_to === 'pr' ? 'every pull request' : 'every card'} in {view.workspace}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {view.status === 'approved' && (
          <div className="space-y-1.5" data-testid="outcome-proposal-filed">
            {view.cards.map(c => (
              <a key={c.id} href={`/o/${c.id}`} className="flex items-baseline gap-1.5 text-sm text-fg-0 hover:text-accent-hover">
                <CardNumber id={c.id} className="text-fg-2" />
                <span className="min-w-0 truncate">{c.title}</span>
                <span className="text-xs text-fg-3">{c.status}</span>
              </a>
            ))}
            {view.start_note && <p className="text-xs text-fg-2">{view.start_note}</p>}
          </div>
        )}

        {editable && gaps.length > 0 && (
          <ul aria-label="Needs fixing before approval" className="list-disc space-y-0.5 pl-5 text-xs text-warning">
            {gaps.map(g => <li key={g}>{g}</li>)}
          </ul>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>

      {editable && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3.5 py-2.5">
          <Button variant="primary" loading={busy === 'approve'} disabled={!check.ok || (!!busy && busy !== 'approve')} onClick={() => run('approve', !!duplicate)}>
            {duplicate ? 'File anyway and start' : 'Approve and start'}
          </Button>
          {dirty && (
            <Button variant="secondary" loading={busy === 'save'} disabled={!check.ok || (!!busy && busy !== 'save')} onClick={() => run('save')}>
              Save changes
            </Button>
          )}
          <Button variant="ghost" loading={busy === 'discard'} disabled={!!busy && busy !== 'discard'} onClick={() => run('discard')}>
            Discard
          </Button>
          <span className="text-xs text-fg-3">Nothing is filed until you approve.</span>
        </footer>
      )}
    </section>
  )
}
