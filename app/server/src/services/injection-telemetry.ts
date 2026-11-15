/**
 * Boundary telemetry (obj 900910): frame a cross-boundary payload AND scan it.
 *
 * `frameAndScan` is the one call a boundary makes. It returns the framed text
 * (lib/untrusted-content.ts) and, as a side effect, runs the heuristic scanner
 * (lib/injection-scanner.ts) over the RAW payload. A hit writes ONE
 * activity_log row with `metadata.kind = 'injection_suspect'` (event_type
 * `progress` — activity_log.event_type has a CHECK constraint, so new kinds go
 * in metadata). It NEVER blocks: the framed text is returned whatever the scan
 * says, and a logging failure is swallowed — telemetry must not break delivery.
 *
 * Dedupe: the same payload on the same boundary is logged once per 10 minutes
 * per process. Chat history is re-framed on every turn, so without this one
 * hostile web page would log a row per turn for the rest of the conversation.
 */
import crypto from 'crypto'
import { logActivity } from '../routes/feed.js'
import { scanForInjection, type InjectionScan } from '../lib/injection-scanner.js'
import { frameUntrusted, type UntrustedPayload } from '../lib/untrusted-content.js'

export const INJECTION_SUSPECT_KIND = 'injection_suspect'

export interface BoundaryContext {
  /** Same vocabulary as UntrustedPayload.source (`web`, `email`, `mcp`, `relayed-message`…). */
  boundary: string
  objectiveId?: number | null
  workspace?: string | null
  project?: string | null
  /** Tool name, card #, node id… */
  label?: string | null
  /** Who was about to read it (bot slug, session id). */
  reader?: string | null
}

const DEDUPE_MS = 10 * 60 * 1000
const DEDUPE_MAX = 2000
const seen = new Map<string, number>()

/** Test hook. */
export function resetInjectionTelemetryDedupe(): void {
  seen.clear()
}

function firstSighting(key: string, now: number): boolean {
  const at = seen.get(key)
  if (at !== undefined && now - at < DEDUPE_MS) return false
  if (seen.size >= DEDUPE_MAX) {
    // Drop the oldest half; Map iterates in insertion order.
    let n = 0
    for (const k of seen.keys()) {
      seen.delete(k)
      if (++n >= DEDUPE_MAX / 2) break
    }
  }
  seen.set(key, now)
  return true
}

/**
 * Scan one payload and log a hit. Returns the scan so a caller (and a test) can
 * see the verdict; the caller must NOT branch delivery on it.
 */
export function noteUntrustedPayload(text: unknown, ctx: BoundaryContext): InjectionScan {
  let scan: InjectionScan
  try {
    scan = scanForInjection(text)
  } catch {
    return { suspect: false, rules: [], excerpt: null }
  }
  if (!scan.suspect) return scan
  try {
    const raw = typeof text === 'string' ? text : JSON.stringify(text ?? null) ?? ''
    const sha = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
    if (!firstSighting(`${ctx.boundary}:${ctx.objectiveId ?? ''}:${ctx.reader ?? ''}:${sha}`, Date.now())) return scan
    logActivity({
      project: ctx.project || 'operationkit',
      workspace: ctx.workspace ?? undefined,
      objective_id: ctx.objectiveId ?? null,
      event_type: 'progress',
      title: `possible prompt injection on ${ctx.boundary}${ctx.label ? ` (${ctx.label.slice(0, 80)})` : ''} — delivered framed, not blocked`,
      detail: `rules=${scan.rules.join(',')}${scan.excerpt ? ` excerpt=${JSON.stringify(scan.excerpt)}` : ''}`,
      metadata: {
        kind: INJECTION_SUSPECT_KIND,
        boundary: ctx.boundary,
        label: ctx.label ?? null,
        reader: ctx.reader ?? null,
        rules: scan.rules,
        excerpt: scan.excerpt,
        sha256_16: sha,
        bytes: raw.length,
        blocked: false,
      },
    })
  } catch (err) {
    console.warn('[injection-telemetry] log failed:', (err as Error).message)
  }
  return scan
}

/** Frame a payload for the model and scan it. The one call each boundary makes. */
export function frameAndScan(p: UntrustedPayload, ctx: Omit<BoundaryContext, 'boundary' | 'label'> = {}): string {
  noteUntrustedPayload(p.text, { ...ctx, boundary: p.source, label: p.label ?? null })
  return frameUntrusted(p)
}
