/**
 * Card briefs: stop conditions and a checkable "done" (obj 901496).
 *
 * A card a bot files carries two structured parts next to its free text:
 *
 *   done_when        ONE checkable statement of what done looks like. It is
 *                    stored in the board's existing `completion_goal` column
 *                    (no second success field).
 *   stop_conditions  short lines, each a case where the worker must STOP and
 *                    report instead of pushing on.
 *
 * Stop conditions have no column of their own. They are written into the card
 * description as ONE fixed section, so there is no database migration:
 *
 *   ## Stop and report if
 *   - the change needs a database migration
 *   - the fields already exist under another name
 *
 * `composeCardBrief` writes that section and `parseCardBrief` reads it back.
 * The card page and the worker prompt both read it through `parseCardBrief`,
 * so they can never disagree on what the stop conditions are. A person who
 * types the same heading and bullets into a card by hand gets the same
 * treatment.
 */

export const STOP_CONDITIONS_HEADING = '## Stop and report if'

export const MAX_STOP_CONDITIONS = 8
export const MAX_STOP_CONDITION_LENGTH = 300
export const MAX_DONE_WHEN_LENGTH = 1000

export interface CardBrief {
  /** The description with the stop-conditions section taken out. */
  body: string
  stopConditions: string[]
}

/** One line of plain text: no newlines, no leading bullet, clipped. */
function oneLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*•]\s+)+/, '')
    .trim()
    .slice(0, max)
    .trim()
}

/**
 * What a tool caller sent as `stop_conditions`, as a clean list. Accepts an
 * array of strings, or one string with a condition per line. Empty lines and
 * repeats are dropped; anything past `MAX_STOP_CONDITIONS` is dropped.
 */
export function normalizeStopConditions(raw: unknown): string[] {
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n/) : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const line = oneLine(item, MAX_STOP_CONDITION_LENGTH)
    if (!line) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= MAX_STOP_CONDITIONS) break
  }
  return out
}

/** What a tool caller sent as `done_when`, as one clipped statement ('' = none). */
export function normalizeDoneWhen(raw: unknown): string {
  return oneLine(raw, MAX_DONE_WHEN_LENGTH)
}

const isHeading = (line: string): boolean => line.trim().replace(/:$/, '').toLowerCase() === STOP_CONDITIONS_HEADING.toLowerCase()
const bulletText = (line: string): string | null => {
  const m = /^\s*[-*•]\s+(.*)$/.exec(line)
  return m ? m[1].trim() : null
}

/**
 * Split a card description into its free text and its stop conditions. The
 * section is the heading line followed by bullet lines; it ends at the first
 * line that is not a bullet. With no section, `body` is the description
 * unchanged and the list is empty.
 */
export function parseCardBrief(description: string | null | undefined): CardBrief {
  const text = typeof description === 'string' ? description : ''
  if (!text) return { body: '', stopConditions: [] }
  const lines = text.split('\n')
  const kept: string[] = []
  const found: string[] = []
  let i = 0
  let any = false
  while (i < lines.length) {
    if (!isHeading(lines[i])) {
      kept.push(lines[i])
      i++
      continue
    }
    // Bullets may follow after blank lines, but a heading with no bullet at
    // all is ordinary text, not a section.
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    const start = j
    while (j < lines.length && bulletText(lines[j]) !== null) {
      found.push(bulletText(lines[j])!)
      j++
    }
    if (j === start) {
      kept.push(lines[i])
      i++
      continue
    }
    any = true
    // Drop the blank lines that set the section apart, so the text reads as before.
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
    while (j < lines.length && lines[j].trim() === '') j++
    if (kept.length > 0 && j < lines.length) kept.push('')
    i = j
  }
  if (!any) return { body: text, stopConditions: [] }
  return { body: kept.join('\n'), stopConditions: normalizeStopConditions(found) }
}

/**
 * The description to store: the free text, then the stop-conditions section.
 * Stop conditions already written into the text under the same heading are
 * merged with the ones passed in, so the card never carries two sections.
 */
export function composeCardBrief(description: string, stopConditions: unknown): string {
  const parsed = parseCardBrief(description)
  const all = normalizeStopConditions([...parsed.stopConditions, ...normalizeStopConditions(stopConditions)])
  if (all.length === 0) return description
  const body = parsed.body.replace(/\s+$/, '')
  return [...(body ? [body, ''] : []), STOP_CONDITIONS_HEADING, ...all.map(l => `- ${l}`)].join('\n')
}
