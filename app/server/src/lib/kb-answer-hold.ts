import fs from 'fs'

/**
 * Saved Ask answers that are kept out of search until a person reviews them
 * (obj 901746, public issues #120 / #153).
 *
 * An answer page (`type: answer`, under `answers/`) whose frontmatter says
 * `answer_check: held` failed the check against the pages it cites, or one of
 * those pages changed after it was saved. Every search path asks this module
 * before it returns or reads a page, so a held answer cannot be retrieved and
 * cited by a later answer:
 *
 *   - hybrid / keyword / semantic search and "related" (`kb-semantic/search.ts`)
 *   - the spawn-prompt KB retrieval (`knowledge-search.ts` `searchKnowledge`)
 *   - Ask's own note list (`doc-ingest/ask.ts` `listNotes`)
 *
 * Only fs is imported here, so every search module can depend on it without a cycle.
 * The state lives in the page itself (no table), so it travels with the file
 * and a person can see why an answer is held by opening it.
 */

export const ANSWER_CHECK_FIELD = 'answer_check'
export type AnswerCheckStatus = 'passed' | 'held' | 'reviewed' | 'unchecked'
export const ANSWER_CHECK_STATUSES: AnswerCheckStatus[] = ['passed', 'held', 'reviewed', 'unchecked']

function frontmatter(text: string): string | null {
  const m = text.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---/)
  return m ? m[1] : null
}

function field(fm: string, key: string): string | undefined {
  const v = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim()
  return v === undefined ? undefined : v.replace(/^(['"])(.*)\1$/, '$2')
}

/** The check status written on an answer page, or null when the text is not an answer page or has none. */
export function answerCheckStatus(text: string): AnswerCheckStatus | null {
  const fm = frontmatter(text)
  if (!fm || field(fm, 'type') !== 'answer') return null
  const v = field(fm, ANSWER_CHECK_FIELD)
  return (ANSWER_CHECK_STATUSES as string[]).includes(v ?? '') ? v as AnswerCheckStatus : null
}

/** True for an answer page that is waiting for a person (pure). */
export function isHeldAnswerText(text: string): boolean {
  return answerCheckStatus(text) === 'held'
}

const HEAD_BYTES = 4096
const CACHE_MAX = 5000
const cache = new Map<string, { mtimeMs: number; size: number; held: boolean }>()

/**
 * True for a held answer page on disk. Only markdown files are read, only
 * their first 4 KB, and the verdict is cached per (mtime, size), so a search
 * over hundreds of hits costs a stat each. Unreadable = not held (the search
 * paths already drop files they cannot read).
 */
export function isHeldAnswerFile(abs: string): boolean {
  if (!abs.toLowerCase().endsWith('.md')) return false
  let st: fs.Stats
  try { st = fs.statSync(abs) } catch { return false }
  const hit = cache.get(abs)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.held
  let held = false
  try {
    const fd = fs.openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size))
      fs.readSync(fd, buf, 0, buf.length, 0)
      held = isHeldAnswerText(buf.toString('utf8'))
    } finally { fs.closeSync(fd) }
  } catch { held = false }
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, held })
  return held
}

/** A visibility predicate with held answers removed (wraps the caller's own, if any). */
export function withoutHeldAnswers(allow?: (p: string) => boolean): (p: string) => boolean {
  return allow ? (p => !isHeldAnswerFile(p) && allow(p)) : (p => !isHeldAnswerFile(p))
}

/**
 * A write that would take a held answer out of hold (rewrite it without
 * `answer_check: held`, or with the type changed) is a review, and only a
 * person reviews. Plain file-write paths a bot can reach (chat `write_doc`,
 * `PUT /api/docs/file` from an agent key or a card session) call this before
 * writing; it returns the refusal sentence, or null when the write is fine
 * (the file is not a held answer, or the new text keeps it held).
 */
export function heldAnswerReleaseRefusal(abs: string, nextText: string): string | null {
  if (!isHeldAnswerFile(abs)) return null
  if (isHeldAnswerText(nextText)) return null
  return 'That saved answer is kept out of search until a person reviews it. A person approves or keeps it out on Context → Cleanup; it cannot be released by rewriting the file.'
}
