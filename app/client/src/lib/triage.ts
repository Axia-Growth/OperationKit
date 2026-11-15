import {
  TRIAGE_MAX_BATCH,
  type TriageAction,
  type TriageBatchRequest,
  type TriageBatchResponse,
  type TriageItemOutcome,
} from '@operationkit/shared'

/* ─────────────────────────────────────────────────────────
   Needs You bulk triage (obj 900869) — pure client logic.
   The server takes at most TRIAGE_MAX_BATCH cards per request, so a big
   selection (the board had ~405 cards in Needs You) is sent as several
   batches, one after the other. Every batch is its own audit row.
   ───────────────────────────────────────────────────────── */

export function chunkIds(ids: readonly number[], size = TRIAGE_MAX_BATCH): number[][] {
  const out: number[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/** Toggle one id; with `range` (shift-click) select every id between the last
 *  clicked one and this one, in the order the column shows them. */
export function toggleSelection(
  current: ReadonlySet<number>,
  id: number,
  opts: { range?: boolean; anchor?: number | null; order?: readonly number[] } = {},
): Set<number> {
  const next = new Set(current)
  const { range, anchor, order } = opts
  if (range && anchor != null && order) {
    const a = order.indexOf(anchor)
    const b = order.indexOf(id)
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      for (const x of order.slice(lo, hi + 1)) next.add(x)
      return next
    }
  }
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Keep only ids that are still in the column — a card that left Needs You
 *  while selected (a bot picked it up, someone else approved it) drops out. */
export function pruneSelection(selected: ReadonlySet<number>, visible: readonly number[]): Set<number> {
  const live = new Set(visible)
  const next = new Set<number>()
  for (const id of selected) if (live.has(id)) next.add(id)
  return next
}

export interface TriageRunResult {
  action: TriageAction
  batch_ids: number[]
  requested: number
  ok: number
  skipped: number
  failed: number
  items: TriageItemOutcome[]
}

export function mergeBatchResults(action: TriageAction, results: TriageBatchResponse[]): TriageRunResult {
  return {
    action,
    batch_ids: results.map(r => r.batch_id),
    requested: results.reduce((n, r) => n + r.requested, 0),
    ok: results.reduce((n, r) => n + r.ok, 0),
    skipped: results.reduce((n, r) => n + r.skipped, 0),
    failed: results.reduce((n, r) => n + r.failed, 0),
    items: results.flatMap(r => r.items),
  }
}

/** Send a confirmed action over the whole selection, chunk by chunk. A chunk
 *  that errors stops the run (later chunks are not sent); what already ran is
 *  returned with the error so the person sees exactly what changed. */
export async function runTriage(
  post: (body: TriageBatchRequest) => Promise<TriageBatchResponse>,
  req: Omit<TriageBatchRequest, 'objective_ids'> & { objective_ids: readonly number[] },
  onProgress?: (done: number, total: number) => void,
): Promise<{ result: TriageRunResult; error: string | null }> {
  const chunks = chunkIds(req.objective_ids)
  const results: TriageBatchResponse[] = []
  let done = 0
  for (const ids of chunks) {
    try {
      results.push(await post({ ...req, objective_ids: ids }))
    } catch (err) {
      return { result: mergeBatchResults(req.action, results), error: (err as Error).message || 'Request failed' }
    }
    done += ids.length
    onProgress?.(done, req.objective_ids.length)
  }
  return { result: mergeBatchResults(req.action, results), error: null }
}

export const TRIAGE_VERB: Record<TriageAction, { label: string; past: string; effect: string }> = {
  approve: { label: 'Approve', past: 'approved', effect: 'moves from Needs You to Done' },
  dismiss: { label: 'Dismiss', past: 'dismissed', effect: 'moves from Needs You to Cancelled' },
  reassign: { label: 'Reassign', past: 'reassigned', effect: 'gets the new owner and stays where it is' },
}
