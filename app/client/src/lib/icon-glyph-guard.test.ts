/**
 * One icon set guard (polish F9, #900810). Every icon in the client is a
 * lucide-react component, drawn with the one stroke default from main.tsx.
 * Emoji (⚙️ 📄 🧠 …), unicode glyphs (▸ × ✓ ★ ● …), HTML entities (&times;)
 * and arrows used as link icons ("Open →") rendered in whatever font the OS
 * had, at a different weight and baseline from the lucide icons beside them.
 * New ones fail here — use the lucide icon instead (X, Check, ChevronRight,
 * ArrowRight, Pin, Circle …).
 *
 * Arrows inside prose ("Settings → Secrets") are wording, not icons, and are
 * allowed; an arrow that starts or ends a string or JSX text is an icon.
 * Masks (•••• in "cc_live_••••1234") are text and allowed.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

const RULES: Array<[string, RegExp]> = [
  ['emoji', /\p{Extended_Pictographic}/u],
  ['glyph', /[▸▹►▶▾▴◂◄◀×✕✖✗✘✓✔★☆●○◉◇◆▲△▼▽⯇⯈⚿›‹⋯]/u],
  ['entity', /&(?:times|rarr|larr|uarr|darr|raquo|laquo|rsaquo|lsaquo|check|cross|starf|star|bull|hellip);/i],
  ['escaped emoji', /\\u(?:d83[c-e]|fe0f|27(?:13|14|15|16|17|18)|260[56]|25(?:b8|b6|be|cf|c6|c7|b2))/i],
  ['arrow icon', /(?:^|[>'"`{]\s*)[→←↗](?=\s*\S)|[→←↗]\s*(?:$|[<'"`}])/],
]

export function glyphIcons(src: string): string[] {
  const hits: string[] = []
  stripComments(src).split('\n').forEach((line, i) => {
    for (const [kind, re] of RULES) {
      const m = line.match(re)
      if (m) hits.push(`${i + 1}: ${kind} ${JSON.stringify(m[0])}`)
    }
  })
  return hits
}

describe('one icon set guard', () => {
  it('the matcher catches emoji, glyphs, entities, escapes and arrow icons', () => {
    expect(glyphIcons(`return { icon: '⚙️' }`)).toHaveLength(1)
    expect(glyphIcons(`<span>{'▸'}</span>`)).toHaveLength(1)
    expect(glyphIcons(`<button>&times;</button>`)).toHaveLength(1)
    expect(glyphIcons(`<span>{isImage ? '\\uD83D\\uDDBC\\uFE0F' : 'x'}</span>`)).toHaveLength(1)
    expect(glyphIcons(`{saved ? 'Flagged ✓' : 'Flag'}`)).toHaveLength(1)
    expect(glyphIcons(`<span className="x">Open →</span>`)).toHaveLength(1)
    expect(glyphIcons(`label: \`\${t.pinned ? '★ ' : ''}\${t.title}\``)).toHaveLength(1)
  })

  it('the matcher allows prose arrows, masks, ellipses and comments', () => {
    expect(glyphIcons(`<p>Add it in Settings → Secrets under that name.</p>`)).toEqual([])
    expect(glyphIcons('{`${data.start} → ${data.end}`}')).toEqual([])
    expect(glyphIcons(`<span>cc_live_••••{k.last4}</span>`)).toEqual([])
    expect(glyphIcons(`placeholder="Search objectives…"`)).toEqual([])
    expect(glyphIcons(`// the old ▸ chevron and ⚙️ emoji lived here`)).toEqual([])
  })

  it('no client source uses an emoji or unicode glyph as an icon', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(50)
    const bad = files.flatMap(f => glyphIcons(fs.readFileSync(f, 'utf8')).map(h => `${path.relative(SRC, f)}:${h}`))
    expect(bad).toEqual([])
  })

  it('no hand-copied SVG icons: inline <svg> only for charts and graphs', () => {
    // Data visualisations draw their own SVG; icons come from lucide-react.
    const allowed = new Set(['components/CostsPage.tsx', 'components/kb-wiki/PageGraph.tsx', 'components/kb-wiki/WorkspaceGraph.tsx'])
    const withSvg = walk(SRC)
      .filter(f => /\.tsx$/.test(f) && /<svg[\s>]/.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map(f => path.relative(SRC, f))
      .filter(f => !allowed.has(f))
    expect(withSvg).toEqual([])
  })
})
