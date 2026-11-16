/**
 * Card numbers (obj 901080).
 *
 * Bots, messages and PR bodies refer to a card by its number (`#901075`), so
 * every search box must take that number back. One parser, shared by the
 * server search route and the client's search boxes, so they never disagree on
 * what counts as "a card number".
 *
 * Accepted (surrounding whitespace ignored):
 *   901075            a bare number
 *   #901075           the way bots write it
 *   card 901075 / card #901075 / obj 901075 / objective #901075
 *   https://host/o/901075  (any host, also /preview/o/<id>, ?query and #hash)
 *   /o/901075               a relative board link
 * Anything else (words around the number, a decimal, 0) is NOT a card number:
 * the caller runs its ordinary text search.
 */

// `#` and the whitespace after it are one optional group, so no two `\s*` sit
// next to each other and the pattern cannot backtrack polynomially (CodeQL
// js/polynomial-redos, obj 901089). It accepts exactly what `#?\s*` did.
const BARE = /^(?:(?:card|obj|objective)\s*)?(?:#\s*)?(\d{1,12})$/i
const PATH = /(?:^|\/)o\/(\d{1,12})(?:[/?#]|$)/

/** A query longer than this is never a card number (checked before any regex). */
export const MAX_QUERY_LENGTH = 200

function toId(digits: string): number | null {
  const n = Number(digits)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** The card id a search query names, or null when it is ordinary text. */
export function parseCardNumberQuery(raw: string | null | undefined): number | null {
  const q = (raw ?? '').trim()
  if (!q) return null
  // The longest real query is a pasted board link. Anything longer is ordinary
  // text, and refusing it here keeps every regex below off huge inputs.
  if (q.length > MAX_QUERY_LENGTH) return null
  const bare = BARE.exec(q)
  if (bare) return toId(bare[1])
  // A pasted link: one token, and it must contain an /o/<id> segment.
  if (/\s/.test(q)) return null
  let path = q
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) {
    try { path = new URL(q).pathname } catch { return null }
  }
  const m = PATH.exec(path)
  return m ? toId(m[1]) : null
}

/** How a card number is written everywhere it is shown: `#901075`. */
export function formatCardNumber(id: number | string): string {
  return `#${id}`
}
