import fs from 'fs'
import path from 'path'
import { slugify } from '../doc-ingest/notes.js'
import { ANSWERS_DIR, GENERATED_BY, kbPagePath } from './paths.js'
import { appendLog, compileWiki, fmField, wikilink, yamlArray, yamlValue } from './wiki.js'
import { noteKbChanged } from '../kb-semantic/service.js'
import type { LlmCall } from '../doc-ingest/llm.js'
import { checkFields, cleanRel, isExistingPage, ruleCheck, sourceHashes, verifyAnswer, type AnswerCheck } from './answer-check.js'

/**
 * Filing an Ask answer back into the wiki (obj 720117) — the step that makes
 * the knowledge base compound: a good answer becomes a page, linked from the
 * pages it used, so the next question can build on it.
 */

export interface FileAnswerInput {
  question: string
  answer: string
  /** KB-relative paths of the pages the answer used. Unknown ones are dropped. */
  sources: string[]
  filedBy?: string
  now?: Date
  /**
   * The result of checking the answer against its pages (obj 901746). When
   * absent, the AI-free rules run here, so a wrong citation is never filed as
   * a searchable fact even by a caller that skipped `checkAndFileAnswer`.
   */
  check?: AnswerCheck
}

export interface FiledAnswer {
  rel: string
  title: string
  /** What the check found. `held` = saved but kept out of search until a person reviews it. */
  check: AnswerCheck
}

function titleAt(kbRoot: string, rel: string): string {
  const abs = kbPagePath(kbRoot, rel)
  if (!abs) return path.posix.basename(rel, '.md')
  try {
    const text = fs.readFileSync(abs, 'utf8')
    return fmField(text, 'title') || text.match(/^# (.+)$/m)?.[1]?.trim() || path.posix.basename(rel, '.md')
  } catch { return path.posix.basename(rel, '.md') }
}

/** Rewrite the Ask citation form `[[organizations/x.md]]` to `[[organizations/x|Title]]`. Pure apart from `titleFor`. */
export function rewriteCitations(answer: string, known: (rel: string) => string | undefined): string {
  return answer.replace(/\[\[([^[\]\n|#]+)(#[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]/g, (m, target: string, _h: string | undefined, label: string | undefined) => {
    const rel = cleanRel(target)
    const title = known(rel)
    return title === undefined ? m : wikilink(rel, label?.trim() || title)
  })
}

/** Pure renderer for an answer page. */
export function renderAnswerPage(o: { question: string; answer: string; sources: Array<{ rel: string; title: string }>; filedBy?: string; updated: string; checkLines?: string[] }): string {
  const fm = [
    '---',
    `title: ${yamlValue(o.question)}`,
    'type: answer',
    `sources: ${yamlArray(o.sources.map(s => s.rel))}`,
    ...(o.filedBy ? [`filed_by: ${yamlValue(o.filedBy)}`] : []),
    `updated: ${o.updated}`,
    ...(o.checkLines ?? []),
    `generated_by: ${GENERATED_BY}`,
    '---',
  ]
  const parts = [...fm, '', `# ${o.question}`, '', o.answer.trim(), '']
  if (o.sources.length) parts.push('## Pages this answer used', '', ...o.sources.map(s => `- ${wikilink(s.rel, s.title)}`), '')
  return parts.join('\n')
}

/**
 * Save an answer as `answers/<date>-<slug>.md`, recompile so its sources link
 * back to it, and log it. The check result and the cited pages' fingerprints
 * go in its frontmatter; a `held` answer is saved but every search skips it.
 */
export function fileAnswer(kbRoot: string, input: FileAnswerInput): FiledAnswer {
  const question = input.question.replace(/\s+/g, ' ').trim()
  if (!question) throw new Error('An answer needs the question it answers.')
  if (!input.answer.trim()) throw new Error('The answer is empty.')
  const now = input.now ?? new Date()
  const date = now.toISOString().slice(0, 10)

  const sources: Array<{ rel: string; title: string }> = []
  for (const raw of input.sources ?? []) {
    const rel = cleanRel(raw)
    if (!isExistingPage(kbRoot, rel) || sources.some(s => s.rel === rel)) continue
    sources.push({ rel, title: titleAt(kbRoot, rel) })
  }
  const titles = new Map<string, string>()
  const known = (rel: string) => {
    if (!titles.has(rel)) titles.set(rel, isExistingPage(kbRoot, rel) ? titleAt(kbRoot, rel) : '\0')
    const t = titles.get(rel)!
    return t === '\0' ? undefined : t
  }

  const check: AnswerCheck = input.check ?? (() => {
    const r = ruleCheck(kbRoot, { answer: input.answer, sources: input.sources ?? [] })
    return r.problems.length
      ? { status: 'held', kind: 'ungrounded', reason: r.problems.join(' '), unsupported: [], checked_by: 'rules', pages: r.pages }
      : { status: 'unchecked', unsupported: [], checked_by: 'rules', ai_skipped: 'Only the citations were checked.', pages: r.pages }
  })()
  const checkLines = Object.entries(checkFields(check, sourceHashes(kbRoot, check.pages), date))
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([k, v]) => `${k}: ${v}`)

  const base = `${date}-${slugify(question).slice(0, 60).replace(/-+$/, '')}`
  fs.mkdirSync(path.join(kbRoot, ANSWERS_DIR), { recursive: true })
  let rel = `${ANSWERS_DIR}/${base}.md`
  for (let i = 2; fs.existsSync(path.join(kbRoot, rel)); i++) rel = `${ANSWERS_DIR}/${base}-${i}.md`

  fs.writeFileSync(path.join(kbRoot, rel), renderAnswerPage({
    question,
    answer: rewriteCitations(input.answer, known),
    sources,
    filedBy: input.filedBy,
    updated: date,
    checkLines,
  }), { flag: 'wx' })
  noteKbChanged(path.join(kbRoot, rel)) // semantic index + link graph
  compileWiki(kbRoot, { now })
  const held = check.status === 'held'
  appendLog(kbRoot, { kind: 'answer', title: `Saved an answer${held ? ' (kept out of search until someone reviews it)' : ''}: ${question}`, pages: [rel, ...sources.map(s => s.rel)], when: now })
  return { rel, title: question, check }
}

/**
 * The save path every caller uses (Ask's "Save to Context", the agent API, the
 * internal route, the chat tool): check the answer against the pages it cites
 * with the AI, then file it with the verdict. `llm` null = rules only.
 */
export async function checkAndFileAnswer(kbRoot: string, input: FileAnswerInput, llm: LlmCall | null, opts: { workspace?: string | null } = {}): Promise<FiledAnswer> {
  const question = input.question.replace(/\s+/g, ' ').trim()
  if (!question) throw new Error('An answer needs the question it answers.')
  if (!input.answer.trim()) throw new Error('The answer is empty.')
  const check = await verifyAnswer(kbRoot, { question, answer: input.answer, sources: input.sources ?? [] }, llm, opts)
  return fileAnswer(kbRoot, { ...input, check })
}
