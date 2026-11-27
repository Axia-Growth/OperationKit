// Knowledge-gap flags (obj 901767): the shared contract for a worker, bot,
// outside agent or person reporting a knowledge-base defect while they work.
// A flag is a QUEUE ROW, never a wiki edit: the Cleanup tab lists open flags
// and a later curator run reads them. No imports: loads in browser and Node.

export const KB_FLAG_KINDS = ['missing', 'wrong', 'stale'] as const
export type KbFlagKind = typeof KB_FLAG_KINDS[number]

export const KB_FLAG_STATUSES = ['open', 'resolved', 'dismissed'] as const
export type KbFlagStatus = typeof KB_FLAG_STATUSES[number]

/** Who filed it: a card's worker (session token), a card's AI reviewer, a chat bot, an outside agent key, or a person. */
export type KbFlagSource = 'worker' | 'reviewer' | 'bot' | 'agent' | 'person'

export const KB_FLAG_KIND_LABEL: Record<KbFlagKind, string> = {
  missing: 'Missing',
  wrong: 'Wrong',
  stale: 'Out of date',
}

export const KB_FLAG_LIMITS = {
  subject: 300,
  detail: 4000,
  suggested_fix: 8000,
  page: 500,
  trace: 500,
  resolution_note: 2000,
} as const

export interface KbFlag {
  id: number
  workspace: string
  kind: KbFlagKind
  /** What knowledge is affected, in a few words ("Acme's billing contact"). */
  subject: string
  /** Knowledge-base-relative page path, when the defect is on (or belongs on) a known page. */
  page: string | null
  /** What is missing / wrong / stale, and how the filer noticed. */
  detail: string
  /** Optional proposed correction. Never applied automatically. */
  suggested_fix: string | null
  /** The board card the filer was working on. */
  objective_id: number | null
  /** Session id, run id or URL of the trace it came from. */
  trace: string | null
  source: KbFlagSource
  filed_by: string
  status: KbFlagStatus
  /** How many times the same open flag was filed (same workspace + kind + page/subject). */
  seen_count: number
  last_seen_at: string
  resolution_note: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

export interface KbFlagInput {
  kind?: unknown
  subject?: unknown
  page?: unknown
  detail?: unknown
  suggested_fix?: unknown
  objective_id?: unknown
  trace?: unknown
}

export interface CleanKbFlagInput {
  kind: KbFlagKind
  subject: string
  page: string | null
  detail: string
  suggested_fix: string | null
  objective_id: number | null
  trace: string | null
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : ''
}

/**
 * Normalise a page reference to a knowledge-base-relative path, or return an
 * error. A flag may point at a page that does not exist yet (missing
 * knowledge), so existence is NOT checked; escaping paths are refused.
 */
export function cleanKbFlagPage(raw: string): { page: string | null } | { error: string } {
  const r = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!r) return { page: null }
  if (r.length > KB_FLAG_LIMITS.page) return { error: `Keep page under ${KB_FLAG_LIMITS.page} characters.` }
  if (r.includes('\0') || r.startsWith('/') || /^[a-z]:/i.test(r) || r.split('/').some(seg => seg === '..' || seg === '')) {
    return { error: 'page must be a knowledge-base-relative path like "organizations/acme.md".' }
  }
  return { page: r }
}

/** Validate a flag body. Returns every problem (empty = valid) and the clean input. */
export function validateKbFlagInput(b: KbFlagInput): { errors: string[]; input?: CleanKbFlagInput } {
  const errors: string[] = []
  const kind = text(b.kind).toLowerCase()
  if (!(KB_FLAG_KINDS as readonly string[]).includes(kind)) errors.push('kind must be "missing", "wrong" or "stale".')
  const subject = text(b.subject).replace(/\s+/g, ' ')
  if (!subject) errors.push('subject is required: what knowledge is affected, in a few words.')
  else if (subject.length > KB_FLAG_LIMITS.subject) errors.push(`Keep subject under ${KB_FLAG_LIMITS.subject} characters.`)
  const detail = text(b.detail)
  if (!detail) errors.push('detail is required: what is missing, wrong or out of date, and how you noticed.')
  else if (detail.length > KB_FLAG_LIMITS.detail) errors.push(`Keep detail under ${KB_FLAG_LIMITS.detail} characters.`)
  const fix = text(b.suggested_fix)
  if (fix.length > KB_FLAG_LIMITS.suggested_fix) errors.push(`Keep suggested_fix under ${KB_FLAG_LIMITS.suggested_fix} characters.`)
  const trace = text(b.trace)
  if (trace.length > KB_FLAG_LIMITS.trace) errors.push(`Keep trace under ${KB_FLAG_LIMITS.trace} characters.`)
  let page: string | null = null
  if (b.page !== undefined && b.page !== null) {
    if (typeof b.page !== 'string') errors.push('page must be a string.')
    else {
      const p = cleanKbFlagPage(b.page)
      if ('error' in p) errors.push(p.error)
      else page = p.page
    }
  }
  let objectiveId: number | null = null
  if (b.objective_id !== undefined && b.objective_id !== null && b.objective_id !== '') {
    const n = Number(b.objective_id)
    if (!Number.isInteger(n) || n <= 0) errors.push('objective_id must be a card number.')
    else objectiveId = n
  }
  if (errors.length) return { errors }
  return {
    errors,
    input: { kind: kind as KbFlagKind, subject, page, detail, suggested_fix: fix || null, objective_id: objectiveId, trace: trace || null },
  }
}

/**
 * Same-defect key: an open flag with the same workspace + kind + page +
 * subject is the same report, so filing it again bumps `seen_count` instead of
 * stacking rows. Two different defects on one page keep separate rows.
 */
export function kbFlagDedupeKey(input: Pick<CleanKbFlagInput, 'kind' | 'page' | 'subject'>): string {
  const page = (input.page ?? '').toLowerCase().replace(/\.md$/, '')
  const subject = input.subject.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return `${input.kind}|${page}|${subject}`
}
