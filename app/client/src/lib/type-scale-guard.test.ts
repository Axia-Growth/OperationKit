/**
 * Type scale guard (polish F1, #900802). Text sizes come from the six-step
 * scale in tailwind.config.ts (xs 12, sm 13, base 14, lg 16, xl 20, 2xl 24)
 * and letter-spacing from its three tokens (tight, normal, eyebrow). An
 * arbitrary `text-[13.5px]` or `tracking-[0.08em]` is how the app drifted to
 * 20 sizes and 10 trackings, so new ones fail here.
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

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

export function offScale(src: string): string[] {
  const hits: string[] = []
  stripComments(src).split('\n').forEach((line, i) => {
    const re = /(?<![\w-])text-\[\d+(?:\.\d+)?(?:px|rem|em)\]|(?<![\w-])tracking-(?:\[[^\]]+\]|wide|wider|widest|tighter)(?![\w-])|(?<![\w-])text-(?:3xl|4xl|5xl|6xl)(?![\w-])/g
    for (const m of line.matchAll(re)) hits.push(`${i + 1}: ${m[0]}`)
  })
  return hits
}

describe('type scale guard', () => {
  it('the matcher catches arbitrary sizes and trackings and allows tokens', () => {
    expect(offScale('<b className="text-[13.5px] tracking-[0.08em]">')).toHaveLength(2)
    expect(offScale('<b className="sm:text-[15px] tracking-wider text-3xl">')).toHaveLength(3)
    expect(offScale('<b className="text-xs text-sm text-base text-lg text-xl text-2xl tracking-tight tracking-eyebrow">')).toHaveLength(0)
    expect(offScale('<b className="text-[var(--accent)] text-fg-3">')).toHaveLength(0)
  })

  it('no client source uses an off-scale text size or tracking', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(50)
    const bad = files.flatMap(f => offScale(fs.readFileSync(f, 'utf8')).map(h => `${path.relative(SRC, f)}:${h}`))
    expect(bad).toEqual([])
  })
})
