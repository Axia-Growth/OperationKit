/**
 * Markdown chunking for knowledge-base embeddings (obj 900816).
 *
 * A note is split at its headings so each chunk carries one topic, and the
 * heading trail (`Title > Section > Subsection`) travels with the chunk: it is
 * prepended to the text that gets embedded (a section body that never repeats
 * its heading still embeds "about" that heading) and it is what the UI shows
 * next to a semantic hit.
 *
 * Sizing is in characters, not model tokens, so the chunker stays
 * provider-agnostic. ~1,200 chars is ≈ 250–300 word-pieces, which fits the
 * 256-token window of the small local models; API models with longer windows
 * are simply under-filled, which costs nothing. Long sections are cut into
 * overlapping windows on paragraph / sentence / word boundaries; tiny sections
 * (a heading with one line under it) are merged forward so the index is not
 * full of near-empty vectors.
 *
 * Pure: no I/O, no clock. Deterministic for a given input + options.
 */

export interface ChunkOptions {
  /** Target max characters of BODY per chunk (heading trail not counted). */
  maxChars?: number
  /** Characters repeated between consecutive windows of one long section. */
  overlapChars?: number
  /** Sections shorter than this are merged into the next one. */
  minChars?: number
}

export interface KbChunk {
  /** 0-based position in the document. */
  index: number
  /** Heading trail, e.g. "Deploy runbook > Rollback". '' when the doc has no title/headings. */
  heading: string
  /** The chunk body (markdown, frontmatter stripped). Used for snippets. */
  text: string
  /** What is actually embedded: heading trail + body. */
  embedText: string
  /** 1-based line in the ORIGINAL file where this chunk's section starts. */
  line: number
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  maxChars: 1200,
  overlapChars: 200,
  minChars: 200,
}

/** Hard cap so one pathological file cannot dominate the index. */
export const MAX_CHUNKS_PER_DOC = 200

interface Section {
  trail: string[]
  body: string
  line: number
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** Split `--- … ---` frontmatter off; return the title it declares (if any) and the body's line offset. */
export function splitFrontmatter(text: string): { title: string; body: string; bodyLine: number } {
  if (!text.startsWith('---')) return { title: '', body: text, bodyLine: 1 }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { title: '', body: text, bodyLine: 1 }
  const fm = text.slice(3, end)
  const afterFence = text.indexOf('\n', end + 4)
  const body = afterFence < 0 ? '' : text.slice(afterFence + 1)
  const bodyLine = text.slice(0, afterFence < 0 ? text.length : afterFence + 1).split('\n').length
  const tm = fm.match(/(?:^|\n)\s*title:\s*["']?([^"'\n]+)["']?/i)
  return { title: tm ? tm[1].trim() : '', body, bodyLine }
}

function sectionsOf(body: string, bodyLine: number): Section[] {
  const lines = body.split('\n')
  const sections: Section[] = []
  const trail: string[] = []
  let current: Section = { trail: [], body: '', line: bodyLine }
  const buf: string[] = []
  let inFence = false
  const flush = () => {
    current.body = buf.join('\n').trim()
    if (current.body || current.trail.length) sections.push(current)
    buf.length = 0
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const m = inFence ? null : line.match(HEADING_RE)
    if (m) {
      flush()
      const level = m[1].length
      trail.length = Math.min(trail.length, level - 1)
      while (trail.length < level - 1) trail.push('')
      trail[level - 1] = m[2].replace(/[*_`]/g, '').trim()
      current = { trail: trail.filter(Boolean), body: '', line: bodyLine + i }
      continue
    }
    buf.push(line)
  }
  flush()
  return sections
}

/** Cut `text` into windows of ≤ max chars with `overlap` chars repeated, on the nicest boundary available. */
export function windowText(text: string, max: number, overlap: number): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let start = 0
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(max / 2)))
  while (start < text.length) {
    let end = Math.min(text.length, start + max)
    if (end < text.length) {
      const slice = text.slice(start, end)
      const floor = Math.floor(max * 0.5)
      const para = slice.lastIndexOf('\n\n')
      const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'), slice.lastIndexOf('? '), slice.lastIndexOf('! '))
      const nl = slice.lastIndexOf('\n')
      const space = slice.lastIndexOf(' ')
      const cut = [para, sentence >= 0 ? sentence + 1 : -1, nl, space].find(p => p >= floor)
      if (cut !== undefined && cut > 0) end = start + cut
    }
    const piece = text.slice(start, end).trim()
    if (piece) out.push(piece)
    if (end >= text.length) break
    // Step back by the overlap, then forward to a word start so a window never begins mid-word.
    let next = Math.max(start + 1, end - safeOverlap)
    const sp = text.indexOf(' ', next)
    if (sp > 0 && sp < end) next = sp + 1
    start = next
  }
  return out
}

/**
 * Chunk one markdown document. `fallbackTitle` (usually the file name) is used
 * when the note has neither frontmatter `title:` nor a leading `# H1`.
 */
export function chunkMarkdown(text: string, fallbackTitle = '', opts: ChunkOptions = {}): KbChunk[] {
  const o = { ...DEFAULT_CHUNK_OPTIONS, ...opts }
  const { title: fmTitle, body, bodyLine } = splitFrontmatter(text.replace(/\r\n/g, '\n'))
  const sections = sectionsOf(body, bodyLine)
  const h1 = sections.find(s => s.trail.length === 1)?.trail[0]
  const docTitle = fmTitle || h1 || fallbackTitle

  // Merge small sections forward (they keep the FIRST section's trail and line).
  const merged: Section[] = []
  for (const s of sections) {
    const prev = merged[merged.length - 1]
    if (prev && prev.body.length < o.minChars && prev.body.length + s.body.length <= o.maxChars) {
      const head = s.trail.length && s.body ? `${s.trail[s.trail.length - 1]}\n` : ''
      prev.body = [prev.body, head + s.body].filter(Boolean).join('\n\n')
      continue
    }
    merged.push({ ...s })
  }

  const chunks: KbChunk[] = []
  for (const s of merged) {
    if (!s.body.trim()) continue
    const trail = [...s.trail]
    if (docTitle && trail[0] !== docTitle) trail.unshift(docTitle)
    const heading = trail.join(' > ')
    for (const piece of windowText(s.body, o.maxChars, o.overlapChars)) {
      if (chunks.length >= MAX_CHUNKS_PER_DOC) return chunks
      chunks.push({
        index: chunks.length,
        heading,
        text: piece,
        embedText: heading ? `${heading}\n\n${piece}` : piece,
        line: s.line,
      })
    }
  }
  return chunks
}
