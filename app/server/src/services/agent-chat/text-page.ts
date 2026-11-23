/**
 * Paging for long text a chat bot reads (obj 901494).
 *
 * `read_file` used to return the first 20,000 characters and `truncated: true`,
 * with no way to get the rest. A bot whose own file had grown past that (Dev's
 * open-loops list, 20,046 characters) then refused to rewrite it, correctly,
 * because all it had was a partial copy. A page says where it starts, where the
 * next one starts, and how long the whole text is, so the bot can read to the
 * end before it writes.
 *
 * Offsets are character offsets (JS string indexes) into the file as read. A
 * page ends on a line break when there is one in its second half, so a loop
 * line or a table row is not cut in two, and never splits a surrogate pair.
 */

export interface TextPage {
  content: string
  /** Where this page starts. */
  offset: number
  /** Where the next page starts; null when this page reaches the end. */
  next_offset: number | null
  total_chars: number
  /** True when the text goes on after this page. */
  truncated: boolean
}

export function pageText(text: string, offset: number, maxChars: number): TextPage {
  const total = text.length
  let start = Number.isFinite(offset) ? Math.max(0, Math.min(Math.trunc(offset), total)) : 0
  // Never start in the middle of a surrogate pair.
  if (start > 0 && start < total && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start -= 1
  let end = Math.min(total, start + Math.max(1, Math.trunc(maxChars)))
  if (end < total) {
    const nl = text.lastIndexOf('\n', end - 1)
    if (nl >= start + Math.floor((end - start) / 2)) end = nl + 1
    else if (isHighSurrogate(text.charCodeAt(end - 1)) && end - 1 > start) end -= 1
  }
  const more = end < total
  return { content: text.slice(start, end), offset: start, next_offset: more ? end : null, total_chars: total, truncated: more }
}

/** Reads a tool's optional `offset` argument (a number, or digits in a string). */
export function offsetArg(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : 0
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/** One plain line a model can act on: what it has, and the exact next call. */
export function pageNote(page: TextPage, rel: string): string | undefined {
  if (page.next_offset === null && page.offset === 0) return undefined
  const range = `characters ${page.offset} to ${page.offset + page.content.length} of ${page.total_chars}`
  return page.next_offset === null
    ? `This is the last page (${range}).`
    : `This is ${range}, NOT the whole file. For the next page call read_file with path "${rel}" and offset ${page.next_offset}; repeat until next_offset is null. Do not write this file back until you have read every page.`
}

function isHighSurrogate(c: number): boolean { return c >= 0xd800 && c <= 0xdbff }
function isLowSurrogate(c: number): boolean { return c >= 0xdc00 && c <= 0xdfff }
