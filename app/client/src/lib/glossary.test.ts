/**
 * Glossary guard (polish F7, obj 900808). docs/glossary.md picks ONE word per
 * concept for anything a person reads. This test fails when a retired word shows
 * up in a user-visible string in the client: a quoted string or JSX text that
 * reads like a sentence (has a space), not code (paths, class lists, ids).
 *
 *   card      — not "objective"
 *   bot       — not "worker"
 *   scheduled task — not "routine" / "strategy workflow"
 *   run       — not "execution"
 *   Context   — not "knowledge base" / "wiki"
 *
 * Code names (types, props, API paths, settings keys) keep their own names; only
 * prose is checked. If a retired word is genuinely right somewhere, add the exact
 * file:text pair to ALLOW with a reason.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const RETIRED = /\b(objectives?|sub-objectives?|executions?|knowledge[- ]base|wiki|routines?|workers?|strategy workflows?)\b/i

/** Exact visible strings allowed to keep a retired word, with the reason. */
const ALLOW: Array<[file: string, text: RegExp, why: string]> = []

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx?$/.test(e.name) && !/\.test\.|\.fixture\.|\.d\.ts$/.test(e.name) ? [p] : []
  })
}

/** Blank out comments (keeping line numbers) so prose in comments does not count. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** A string that reads like prose rather than code. */
function isProse(s: string): boolean {
  const t = s.trim()
  if (!/ /.test(t)) return false // single tokens are identifiers/keys
  if (/^[/.]|\/api\//.test(t)) return false // paths
  if (/^[a-z0-9-]+( [a-z0-9:/[\]%.!-]+)+$/.test(t)) return false // class lists
  if (/\b(SELECT|FROM|WHERE)\b/.test(t)) return false
  return true
}

export function visibleStrings(line: string): string[] {
  if (/\bconsole\.(log|warn|error|info|debug)\(/.test(line)) return [] // developer console, not UI
  const segs: string[] = []
  for (const m of line.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`/g)) segs.push((m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, '').replace(/\$\{.*$/, '').replace(/^[^{]*\}/, ''))
  for (const m of line.matchAll(/>([^<>{}]+)</g)) segs.push(m[1])
  const t = line.trim()
  if (/^[A-Z][A-Za-z ,.'’—–?!-]+$/.test(t) && / [a-z]+ /.test(t)) segs.push(t) // a bare JSX text line
  return segs.filter(isProse)
}

describe('glossary: one user-facing word per concept', () => {
  const files = walk(SRC)

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('the prose detector ignores code and catches copy', () => {
    expect(visibleStrings(`const r = await fetch('/api/objectives/1')`)).toEqual([])
    expect(visibleStrings(`<div className="font-mono text-xs">x</div>`)).toEqual([])
    expect(visibleStrings('title={`Model: ${objective.model} here`}').some(s => RETIRED.test(s))).toBe(false)
    expect(visibleStrings(`<h2>Edit objective</h2>`).some(s => RETIRED.test(s))).toBe(true)
    expect(visibleStrings(`toast('Routine paused after 5 failures')`).some(s => RETIRED.test(s))).toBe(true)
  })

  it('no retired word in user-visible client strings', () => {
    const hits: string[] = []
    for (const f of files) {
      const rel = path.relative(SRC, f)
      stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const s of visibleStrings(line)) {
          if (!RETIRED.test(s)) continue
          if (ALLOW.some(([file, re]) => file === rel && re.test(s))) continue
          hits.push(`${rel}:${i + 1}: ${s.trim().slice(0, 120)}`)
        }
      })
    }
    expect(hits).toEqual([])
  })

  it('the glossary doc exists and names every retired word', () => {
    const doc = fs.readFileSync(path.resolve(SRC, '..', '..', '..', 'docs', 'glossary.md'), 'utf8')
    for (const w of ['objective', 'worker', 'routine', 'execution', 'knowledge base', 'wiki', 'strategy workflow', 'scheduled task']) expect(doc).toContain(w)
  })
})
