/**
 * The board's deterministic title key (obj 64, Part C) — split out of
 * `objective-dedupe.ts` (obj 900795) so pure readers such as the High Agency
 * supervisor can use the SAME normaliser without importing the activity feed
 * (and with it the whole server graph). `objective-dedupe.ts` re-exports it, so
 * every existing import keeps working. Steps are documented there.
 */

/*
 * Trailing copy-style suffixes, matched on the lowercased title: "(2)",
 * "( 3 )", "(copy)", "(copy 2)", "copy", "copy 2", "- copy", "— copy 3".
 *
 * obj 900838 (CodeQL js/polynomial-redos): this used to be ONE unanchored
 * regex that opened with `\s*` and closed with `\s*$`. Every position inside
 * a long run of spaces was a fresh start, so a title like "a" + 50k spaces +
 * "b" took quadratic time on the POST /api/objectives path. Same rules,
 * applied from the end of the string instead.
 */
const PAREN_SUFFIX_INNER_RE = /^\s*(?:copy(?:\s*\d+)?|\d+)\s*$/u
const COPY_WORD_SUFFIX_RE = /\bcopy(?:\s*\d+)?$/u
const COPY_SEPARATOR_RE = /[-–—_:]$/u

/** Remove ONE trailing copy suffix (and the whitespace before it). Unchanged when there is none. */
function stripCopySuffixOnce(s: string): string {
  const t = s.trimEnd()
  if (t.endsWith(')')) {
    const open = t.lastIndexOf('(')
    if (open >= 0 && PAREN_SUFFIX_INNER_RE.test(t.slice(open + 1, -1))) return t.slice(0, open).trimEnd()
  }
  const m = COPY_WORD_SUFFIX_RE.exec(t)
  if (m) {
    let head = t.slice(0, m.index).trimEnd()
    if (COPY_SEPARATOR_RE.test(head)) head = head.slice(0, -1).trimEnd()
    return head
  }
  return t
}

/** Deterministic title key — see the module header for the exact steps. */
export function normalizeTitle(title: string | null | undefined): string {
  let s = (title ?? '').normalize('NFKC').toLowerCase().trim()
  // Strip stacked suffixes ("Foo (copy) (2)") until stable; bounded so a hostile
  // title cannot spin.
  for (let i = 0; i < 5; i++) {
    const next = stripCopySuffixOnce(s)
    if (next === s) break
    s = next
  }
  return s
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
