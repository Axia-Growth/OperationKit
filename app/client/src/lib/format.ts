/**
 * Plain-language formatters (polish F7, obj 900808).
 *
 * One place that turns machine values into words a person reads: timestamps,
 * money, durations, byte counts, cron schedules, enum/status codes and errors.
 * Rule of thumb for every screen: never render an ISO/UTC string, a raw cron
 * expression, a snake_case enum, a config key or an "HTTP 500" to a user — run
 * it through one of these. Machine detail may still go in a `title` tooltip or a
 * collapsed "Details" block, never in the main text.
 *
 * All time output uses the BROWSER's time zone (no hard-coded zone).
 */

// ── Time ────────────────────────────────────────────────────────────────────

type DateInput = string | number | Date | null | undefined

function toMs(v: DateInput): number | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime()
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  // SQLite `datetime('now')` gives "2026-11-12 06:03:12" (UTC, no zone). Treat a
  // zone-less stamp as UTC, which is what the server writes.
  const s = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** "Nov 12, 2026, 6:03 AM" in the viewer's own time zone. "" for a missing/bad value. */
export function formatAbsoluteTime(v: DateInput): string {
  const t = toMs(v)
  if (t == null) return ''
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

/** "Nov 12, 2026" in the viewer's own time zone. */
export function formatDate(v: DateInput): string {
  const t = toMs(v)
  if (t == null) return ''
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * Relative time in words: "just now", "5 minutes ago", "in 3 hours",
 * "yesterday", and past a week the absolute date ("Nov 2, 2026").
 */
export function formatRelativeTime(v: DateInput, now: number = Date.now()): string {
  const t = toMs(v)
  if (t == null) return ''
  const diff = t - now
  const abs = Math.abs(diff)
  const future = diff > 0
  const s = Math.round(abs / 1000)
  if (s < 45) return future ? 'in a few seconds' : 'just now'
  const unit = (n: number, word: string) => {
    const w = `${n} ${word}${n === 1 ? '' : 's'}`
    return future ? `in ${w}` : `${w} ago`
  }
  const m = Math.round(s / 60)
  if (m < 60) return unit(Math.max(1, m), 'minute')
  const h = Math.round(m / 60)
  if (h < 24) return unit(h, 'hour')
  const d = Math.round(h / 24)
  if (d === 1) return future ? 'tomorrow' : 'yesterday'
  if (d < 7) return unit(d, 'day')
  return formatDate(t)
}

/**
 * The one time formatter for UI text: a relative label plus the absolute local
 * time for a `title` tooltip. Usage: `<span title={x.title}>{x.label}</span>`.
 */
export function formatDateTime(v: DateInput, now: number = Date.now()): { label: string; title: string } {
  const label = formatRelativeTime(v, now)
  if (!label) return { label: '—', title: '' }
  return { label, title: formatAbsoluteTime(v) }
}

// ── Money, duration, size ───────────────────────────────────────────────────

/**
 * US dollars for people: "$1.24", "$1,204.50", "<$0.01" for a non-zero
 * sub-cent amount, "$0.00" for zero. Never four decimals.
 */
export function formatCost(usd: number | string | null | undefined): string {
  const n = Number(usd)
  if (usd == null || usd === '' || !Number.isFinite(n)) return '—'
  if (n !== 0 && Math.abs(n) < 0.01) return n < 0 ? '-<$0.01' : '<$0.01'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "450 ms", "12 s", "4 min 5 s", "2 h 10 min", "3 d 4 h". "—" for missing. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`
}

/** "512 bytes", "4.2 KB", "1.3 MB". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

// ── Enums / codes ───────────────────────────────────────────────────────────

/** Words that keep their capitals when an enum is humanized. */
const ACRONYMS: Record<string, string> = {
  ai: 'AI', api: 'API', pr: 'PR', ci: 'CI', id: 'ID', url: 'URL', mcp: 'MCP', llm: 'LLM',
  ui: 'UI', sms: 'SMS', http: 'HTTP', ssh: 'SSH', json: 'JSON', csv: 'CSV', kb: 'KB', usd: 'USD',
}

/**
 * Turn a machine code into a sentence-case label: `ai_review` → "AI review",
 * `needs-review` → "Needs review", `flowRun` → "Flow run". Pass `labels` to
 * override specific values with hand-written copy.
 */
export function humanize(value: string | null | undefined, labels?: Record<string, string>): string {
  if (value == null || value === '') return ''
  if (labels && Object.prototype.hasOwnProperty.call(labels, value)) return labels[value]
  const words = String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.:/]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
  return words
    .map((w, i) => ACRONYMS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
}

// ── Cron ────────────────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function clock(h: number, m: number): string {
  const d = new Date(2000, 0, 1, h, m)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function isInt(s: string): boolean { return /^\d+$/.test(s) }

/**
 * A cron expression in words: "0 6 * * *" → "Every day at 6:00 AM",
 * "*\/15 * * * *" → "Every 15 minutes", "0 9 * * 1-5" → "Weekdays at 9:00 AM".
 * Times are the cron's own clock (labelled `(UTC)` when `utc` is set). Shapes
 * it cannot read come back as "Custom schedule" — never the raw string.
 */
export function describeCron(expr: string | null | undefined, opts: { utc?: boolean } = {}): string {
  if (!expr || !expr.trim()) return 'No schedule'
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return 'Custom schedule'
  const [min, hour, dom, mon, dow] = parts
  const tz = opts.utc ? ' (UTC)' : ''
  const anyDay = dom === '*' && mon === '*'
  if (anyDay && dow === '*') {
    if (min === '*' && hour === '*') return 'Every minute'
    const everyMin = /^\*\/(\d+)$/.exec(min)
    if (everyMin && hour === '*') return `Every ${everyMin[1]} minutes`
    if (isInt(min) && hour === '*') return Number(min) === 0 ? 'Every hour' : `Every hour at :${min.padStart(2, '0')}`
    const everyHour = /^\*\/(\d+)$/.exec(hour)
    if (isInt(min) && everyHour) return `Every ${everyHour[1]} hours`
    if (isInt(min) && isInt(hour)) return `Every day at ${clock(+hour, +min)}${tz}`
    if (isInt(min) && /^\d+(,\d+)+$/.test(hour)) {
      const hs = hour.split(',').map(h => clock(+h, +min))
      return `Every day at ${hs.slice(0, -1).join(', ')} and ${hs[hs.length - 1]}${tz}`
    }
    return 'Custom schedule'
  }
  if (anyDay && isInt(min) && isInt(hour)) {
    const at = `${clock(+hour, +min)}${tz}`
    if (dow === '1-5') return `Weekdays at ${at}`
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${at}`
    if (/^\d(,\d)*$/.test(dow)) {
      const names = dow.split(',').map(d => DAYS[+d % 7]).filter(Boolean)
      if (names.length === 1) return `Every ${names[0]} at ${at}`
      return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} at ${at}`
    }
  }
  if (isInt(min) && isInt(hour) && isInt(dom) && mon === '*' && dow === '*') {
    return `Monthly on day ${dom} at ${clock(+hour, +min)}${tz}`
  }
  return 'Custom schedule'
}

// ── Errors ──────────────────────────────────────────────────────────────────

const STATUS_SENTENCES: Record<number, string> = {
  400: 'That request was not accepted. Check the details and try again.',
  401: 'Your session has expired. Sign in again to continue.',
  403: 'You do not have access to this.',
  404: 'We could not find that. It may have been moved or deleted.',
  408: 'That took too long. Try again.',
  409: 'That conflicts with something that already exists.',
  413: 'That file is too large.',
  415: 'That file type is not supported.',
  422: 'Some of the details are not valid. Check them and try again.',
  429: 'Too many requests right now. Wait a moment and try again.',
}

/** The browser's own words for "the request never reached the server" (Chrome, Firefox, Safari). */
const NETWORK_FAILURE = /failed to fetch|networkerror|network request failed|load failed/i
export const NETWORK_ERROR_MESSAGE = 'Could not reach the server. Check your connection and try again.'

/**
 * The message to show for a failed action: a network failure (the browser's raw
 * "Failed to fetch") becomes the plain sentence above; anything else keeps its
 * own message, because a server's `error` text is usually the useful part;
 * no message at all gives `fallback`. Unlike `friendlyError`, it never swaps a
 * specific server message for a generic one.
 */
export function actionErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (raw && NETWORK_FAILURE.test(raw)) return NETWORK_ERROR_MESSAGE
  return raw || fallback
}

/**
 * The server's own reason for a refused request (obj 901196). A 4xx whose JSON
 * body carries `error` states a rule the person can act on ("Agent 'general' is
 * not in workspace 'x' pool …"), so a form shows it instead of a generic line.
 * Null for a 5xx, a network failure, or an error without server text.
 */
export function serverReason(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number' || status < 400 || status >= 500) return null
  const body = (err as { body?: unknown }).body
  const msg = body && typeof body === 'object' ? (body as { error?: unknown }).error : null
  return typeof msg === 'string' && msg.trim() ? msg.trim() : null
}

/**
 * A plain sentence for a failure, plus the technical detail to show collapsed.
 * `friendlyError(500)` → "Something went wrong on our side. Try again in a moment."
 * Accepts an HTTP status, an Error, a Response-like `{status}` or a string such
 * as "HTTP 502" / "Failed to fetch".
 */
export function friendlyError(err: unknown): { message: string; detail: string } {
  let status: number | null = null
  let detail = ''
  if (typeof err === 'number') status = err
  else if (typeof err === 'string') detail = err
  else if (err instanceof Error) detail = err.message
  else if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    status = (err as { status: number }).status
  }
  if (status == null) {
    const m = /\bHTTP\s*(\d{3})\b/i.exec(detail) ?? /^(\d{3})\b/.exec(detail)
    if (m) status = Number(m[1])
  }
  if (status == null && NETWORK_FAILURE.test(detail)) {
    return { message: NETWORK_ERROR_MESSAGE, detail }
  }
  if (status != null) {
    const message = STATUS_SENTENCES[status]
      ?? (status >= 500 ? 'Something went wrong on our side. Try again in a moment.' : 'That did not work. Try again.')
    return { message, detail: detail || `Status ${status}` }
  }
  return { message: 'Something went wrong. Try again in a moment.', detail }
}
