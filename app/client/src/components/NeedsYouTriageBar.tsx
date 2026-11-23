import { useCallback, useEffect, useId, useState } from 'react'
import { Check, History, UserRoundCog, X } from 'lucide-react'
import type {
  Objective,
  TriageAction,
  TriageBatchPreview,
  TriageBatchRequest,
  TriageBatchResponse,
  TriageBatchSummary,
  TriageOwnerOptions,
} from '@operationkit/shared'
import { api } from '../lib/api'
import { previewTriage, runTriage, TRIAGE_VERB, type TriageRunResult } from '../lib/triage'
import { Button, Modal, Select, useConfirm } from './ui'

/**
 * Needs You bulk triage (obj 900869). Shown under the board header while
 * "Select" is on in the Needs You column. Every action:
 *  1. asks the server for a dry run (obj 901519) and shows it in the
 *     confirmation: exactly which cards would change and which would be
 *     skipped, and why. The dry run changes nothing;
 *  2. runs as audited batches (POST /api/board-triage/batches, ≤100 cards
 *     each), one audit row per card, viewable under History;
 *  3. reports what changed, and which cards were skipped or failed and why.
 * Nothing here runs without a click on the confirm button.
 */

const postBatch = (body: TriageBatchRequest) =>
  api.post<TriageBatchResponse>('/board-triage/batches', body, { timeoutMs: 120_000 })

const postPreview = (body: TriageBatchRequest) =>
  api.post<TriageBatchPreview>('/board-triage/batches', body, { timeoutMs: 60_000 })

function titleList(cards: Objective[], max = 5): string {
  const shown = cards.slice(0, max).map(c => `#${c.id} ${c.title}`)
  const more = cards.length - shown.length
  return shown.join('\n') + (more > 0 ? `\n…and ${more} more` : '')
}

export function NeedsYouTriageBar({
  selected,
  columnCount,
  onSelectAll,
  onClear,
  onExit,
  onFinished,
}: {
  /** The selected cards, in column order (already pruned to Needs You). */
  selected: Objective[]
  /** How many cards Needs You shows under the current filters. */
  columnCount: number
  onSelectAll: () => void
  onClear: () => void
  onExit: () => void
  /** A run finished — the parent clears the selection of cards that moved. */
  onFinished: (result: TriageRunResult) => void
}) {
  const { confirm, confirmDialog } = useConfirm()
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<{ result: TriageRunResult; error: string | null } | null>(null)
  const [reassignOpen, setReassignOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const n = selected.length

  const run = useCallback(async (req: Omit<TriageBatchRequest, 'objective_ids'>) => {
    const ids = selected.map(c => c.id)
    setBusy({ done: 0, total: ids.length })
    try {
      const out = await runTriage(postBatch, { ...req, objective_ids: ids }, (done, total) => setBusy({ done, total }))
      setResult(out)
      onFinished(out.result)
    } finally {
      setBusy(null)
    }
  }, [selected, onFinished])

  const confirmAndRun = useCallback(async (action: Exclude<TriageAction, 'reassign'>) => {
    const verb = TRIAGE_VERB[action]
    // Dry run first: the server says what it would touch. It changes nothing.
    let preview: TriageBatchPreview | null = null
    setBusy({ done: 0, total: n })
    try {
      preview = await previewTriage(postPreview, { action, objective_ids: selected.map(c => c.id) })
    } catch {
      preview = null // fall back to the plain list below; the real run still reports every skip
    } finally {
      setBusy(null)
    }
    const will = preview ? preview.items.filter(i => i.result === 'would_change') : []
    const wont = preview ? preview.items.filter(i => i.result !== 'would_change') : []
    const count = preview ? will.length : n
    const box = 'block max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-2 font-mono text-xs text-fg-2'
    const ok = await confirm({
      title: preview && count === 0
        ? `Nothing to ${verb.label.toLowerCase()}`
        : `${verb.label} ${count} card${count === 1 ? '' : 's'}?`,
      message: (
        // Rendered inside the dialog's description <p>, so phrasing content only.
        <span className="block space-y-2" data-testid="triage-preview">
          {preview ? (
            <>
              <span className="block">
                {count === 0
                  ? 'None of the selected cards would change.'
                  : `${count === 1 ? 'This card' : `These ${count} cards`} ${verb.effect.replace(/^moves/, count === 1 ? 'moves' : 'move')}. Every change is recorded in the triage history with your name.`}
              </span>
              {will.length > 0 && (
                <span className={box} data-testid="triage-preview-will">
                  {will.map(i => `#${i.objective_id} ${i.title ?? ''}`).join('\n')}
                </span>
              )}
              {wont.length > 0 && (
                <>
                  <span className="block">{wont.length} would be left alone:</span>
                  <span className={box} data-testid="triage-preview-wont">
                    {wont.map(i => `#${i.objective_id} ${i.title ?? ''}: ${i.error ?? i.result}`).join('\n')}
                  </span>
                </>
              )}
              <span className="block text-xs text-fg-2">Checked with the server just now; nothing has been changed yet.</span>
            </>
          ) : (
            <>
              <span className="block">Each card {verb.effect}. Every change is recorded in the triage history with your name.</span>
              <span className="block">A card that has left Needs You, or that you are not allowed to change, is skipped and listed afterwards.</span>
              <span className={box}>{titleList(selected)}</span>
            </>
          )}
        </span>
      ),
      confirmLabel: preview && count === 0 ? 'OK' : `${verb.label} ${count}`,
      danger: action === 'dismiss' && count > 0,
    })
    if (ok && count > 0) await run({ action })
  }, [confirm, n, run, selected])

  return (
    <div
      data-testid="triage-bar"
      role="toolbar"
      aria-label="Bulk triage for Needs You"
      className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2"
    >
      <span className="text-sm font-medium text-fg-0" data-testid="triage-count">
        {n} of {columnCount} selected
      </span>
      <Button size="xs" variant="ghost" onClick={onSelectAll} disabled={!!busy || n === columnCount}>
        Select all {columnCount}
      </Button>
      <Button size="xs" variant="ghost" onClick={onClear} disabled={!!busy || n === 0}>
        Clear
      </Button>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {busy && (
          <span className="text-xs text-fg-2" role="status" data-testid="triage-progress">
            Working… {busy.done}/{busy.total}
          </span>
        )}
        {/* Neutral until something is selected: the board's preview.css forces
            .bg-accent with !important, which would keep a disabled primary blue. */}
        <Button size="sm" variant={n === 0 ? 'secondary' : 'primary'} leftIcon={<Check className="h-3.5 w-3.5" />} disabled={!!busy || n === 0} onClick={() => void confirmAndRun('approve')} data-testid="triage-approve">
          Approve
        </Button>
        <Button size="sm" leftIcon={<UserRoundCog className="h-3.5 w-3.5" />} disabled={!!busy || n === 0} onClick={() => setReassignOpen(true)} data-testid="triage-reassign">
          Reassign
        </Button>
        <Button size="sm" variant="danger" disabled={!!busy || n === 0} onClick={() => void confirmAndRun('dismiss')} data-testid="triage-dismiss">
          Dismiss
        </Button>
        <Button size="sm" variant="ghost" leftIcon={<History className="h-3.5 w-3.5" />} onClick={() => setHistoryOpen(true)} data-testid="triage-history">
          History
        </Button>
        <Button size="sm" variant="ghost" leftIcon={<X className="h-3.5 w-3.5" />} onClick={onExit} disabled={!!busy}>
          Done selecting
        </Button>
      </div>

      {confirmDialog}
      {reassignOpen && (
        <ReassignDialog
          count={n}
          onClose={() => setReassignOpen(false)}
          onConfirm={async req => { setReassignOpen(false); await run(req) }}
        />
      )}
      {result && <ResultDialog run={result} onClose={() => setResult(null)} />}
      {historyOpen && <HistoryDialog onClose={() => setHistoryOpen(false)} />}
    </div>
  )
}

// ── Reassign ────────────────────────────────────────────────────────────────

const KEEP = '__keep__'
const CLEAR = '__clear__'

export function ReassignDialog({
  count,
  onClose,
  onConfirm,
}: {
  count: number
  onClose: () => void
  onConfirm: (req: Omit<TriageBatchRequest, 'objective_ids'>) => void | Promise<void>
}) {
  const titleId = useId()
  const [owners, setOwners] = useState<TriageOwnerOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [person, setPerson] = useState<string>(KEEP)
  const [bot, setBot] = useState<string>(KEEP)
  const [note, setNote] = useState('')

  useEffect(() => {
    api.get<TriageOwnerOptions>('/board-triage/owners')
      .then(setOwners)
      .catch(err => setLoadError((err as Error).message || 'Could not load owners'))
  }, [])

  const changes = person !== KEEP || bot !== KEEP
  const submit = () => {
    const req: Omit<TriageBatchRequest, 'objective_ids'> = { action: 'reassign' }
    if (person !== KEEP) req.assigned_user_ids = person === CLEAR ? [] : [Number(person)]
    if (bot !== KEEP) req.owner_bot = bot === CLEAR ? null : bot
    if (note.trim()) req.note = note.trim()
    void onConfirm(req)
  }

  return (
    <Modal open onClose={onClose} labelledBy={titleId} panelClassName="w-[min(28rem,calc(100vw-2rem))]">
      <div className="space-y-3 p-4" data-testid="reassign-dialog">
        <h2 id={titleId} className="text-base font-semibold text-fg-0">Reassign {count} card{count === 1 ? '' : 's'}</h2>
        <p className="text-sm text-fg-2">
          The person is who the card waits on in Needs You. The bot is who picks it up when it goes back to work.
          Cards stay in their column. Every change is recorded in the triage history.
        </p>
        {loadError && <p className="text-sm text-danger">{loadError}</p>}
        <label className="block space-y-1 text-sm text-fg-1">
          <span>Person</span>
          <Select
            value={person}
            onChange={setPerson}
            aria-label="Person"
            className="w-full"
            options={[
              { value: KEEP, label: 'Keep as is' },
              { value: CLEAR, label: 'Nobody (unassign)' },
              ...(owners?.humans ?? []).map(h => ({ value: String(h.id), label: h.username })),
            ]}
          />
        </label>
        <label className="block space-y-1 text-sm text-fg-1">
          <span>Bot</span>
          <Select
            value={bot}
            onChange={setBot}
            aria-label="Bot"
            className="w-full"
            options={[
              { value: KEEP, label: 'Keep as is' },
              { value: CLEAR, label: 'No bot' },
              ...(owners?.bots ?? []).map(b => ({ value: b.id, label: b.name })),
            ]}
          />
        </label>
        <label className="block space-y-1 text-sm text-fg-1">
          <span>Note (kept in the history)</span>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={500}
            className="h-9 w-full rounded-md border border-line bg-surface-2 px-2.5 text-sm text-fg-0 outline-none focus-visible:border-accent"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!changes} onClick={submit} data-testid="reassign-confirm">
            Reassign {count}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ── Result ──────────────────────────────────────────────────────────────────

export function ResultDialog({ run, onClose }: { run: { result: TriageRunResult; error: string | null }; onClose: () => void }) {
  const titleId = useId()
  const { result, error } = run
  const verb = TRIAGE_VERB[result.action]
  const problems = result.items.filter(i => i.result !== 'ok')
  return (
    <Modal open onClose={onClose} labelledBy={titleId} panelClassName="w-[min(32rem,calc(100vw-2rem))]">
      <div className="space-y-3 p-4" data-testid="triage-result">
        <h2 id={titleId} className="text-base font-semibold text-fg-0">
          {result.ok} {verb.past}
          {result.skipped > 0 && `, ${result.skipped} skipped`}
          {result.failed > 0 && `, ${result.failed} failed`}
        </h2>
        {result.batch_ids.length > 0 && (
          <p className="text-xs text-fg-2">
            Recorded as triage batch{result.batch_ids.length === 1 ? '' : 'es'} {result.batch_ids.map(b => `#${b}`).join(', ')}.
          </p>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert">
            Stopped early: {error}. Cards in batches that did not run were not changed.
          </p>
        )}
        {problems.length > 0 && (
          <ul className="max-h-64 space-y-1 overflow-auto text-sm">
            {problems.map(p => (
              <li key={p.objective_id} className="rounded-md border border-line px-2 py-1.5">
                <span className="font-mono text-xs text-fg-3">#{p.objective_id}</span>{' '}
                <span className="text-fg-0">{p.title ?? '(unknown card)'}</span>
                <div className="text-xs text-fg-2">{p.result === 'failed' ? 'Failed' : 'Skipped'}: {p.error}</div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  )
}

// ── History (audit trail) ───────────────────────────────────────────────────

export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const [batches, setBatches] = useState<TriageBatchSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.get<{ batches: TriageBatchSummary[] }>('/board-triage/batches?limit=30')
      .then(r => setBatches(r.batches))
      .catch(err => setError((err as Error).message || 'Could not load history'))
  }, [])
  return (
    <Modal open onClose={onClose} labelledBy={titleId} panelClassName="w-[min(36rem,calc(100vw-2rem))]">
      <div className="space-y-3 p-4" data-testid="triage-history-dialog">
        <h2 id={titleId} className="text-base font-semibold text-fg-0">Triage history</h2>
        {error && <p className="text-sm text-danger">{error}</p>}
        {batches && batches.length === 0 && <p className="text-sm text-fg-2">No bulk actions yet.</p>}
        {batches && batches.length > 0 && (
          <ul className="max-h-80 space-y-1 overflow-auto text-sm">
            {batches.map(b => (
              <li key={b.id} className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-line px-2 py-1.5">
                <span className="font-mono text-xs text-fg-3">#{b.id}</span>
                <span className="font-medium text-fg-0">{TRIAGE_VERB[b.action].label}</span>
                <span className="text-fg-2">{b.requested} card{b.requested === 1 ? '' : 's'} by {b.actor}</span>
                <span className="text-xs text-fg-2">{b.ok} ok · {b.skipped} skipped · {b.failed} failed</span>
                <span className="ml-auto font-mono text-xs text-fg-3">{b.created_at}</span>
                {b.note && <div className="w-full text-xs text-fg-2">“{b.note}”</div>}
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  )
}
