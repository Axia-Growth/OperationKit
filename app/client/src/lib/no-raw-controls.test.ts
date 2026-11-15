/**
 * Board + card viewer controls come from the shared primitives (polish F4,
 * obj 900805). A hand-rolled <button>/<input>/<textarea>/<select> is how the
 * board ended up with ~75 buttons in four heights and a faded-accent disabled
 * state. Use Button / IconButton / RowButton / Input / Textarea / SearchInput /
 * Select from components/ui instead.
 *
 * - preview/* and components/objective-modal/*: ZERO raw controls, no exceptions.
 * - The card editor, card search, proposal card and the viewer header/composer:
 *   a raw control is allowed only with a `raw-control: <reason>` comment on one
 *   of the two lines above it (a native checkbox, the file picker, …).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

const RAW = /<(button|input|textarea|select)(?=[\s>/]|$)/

/** Every raw control in a file as `line: snippet`; `allowMarked` skips ones with a raw-control: note. */
export function rawControls(src: string, allowMarked: boolean): string[] {
  const lines = src.split('\n')
  const hits: string[] = []
  lines.forEach((line, i) => {
    if (!RAW.test(line)) return
    const above = lines.slice(Math.max(0, i - 2), i).join('\n')
    if (allowMarked && /raw-control:\s*\S/.test(above)) return
    hits.push(`${i + 1}: ${line.trim()}`)
  })
  return hits
}

const STRICT_DIRS = ['preview', 'components/objective-modal']
const MARKED_FILES = [
  'components/ObjectiveModal.tsx',
  'components/ObjectiveSearchPanel.tsx',
  'components/ObjectiveProposalCard.tsx',
  'components/session-viewer/ViewerHeader.tsx',
  'components/session-viewer/Composer.tsx',
  'components/session-viewer/CorrectionPanel.tsx',
]

describe('board + card viewer use the shared control primitives', () => {
  it('the matcher catches raw controls and honours a raw-control note', () => {
    expect(rawControls('<button onClick={x}>', false)).toHaveLength(1)
    expect(rawControls('<input\n  value={v}', false)).toHaveLength(1)
    expect(rawControls('<Button size="sm">', false)).toHaveLength(0)
    expect(rawControls('<RowButton>', false)).toHaveLength(0)
    expect(rawControls('{/* raw-control: native file picker */}\n<input type="file" />', true)).toHaveLength(0)
    expect(rawControls('{/* raw-control: native file picker */}\n<input type="file" />', false)).toHaveLength(1)
  })

  for (const dir of STRICT_DIRS) {
    it(`${dir}/* has zero raw <button>/<input>/<textarea>/<select>`, () => {
      const found = walk(path.join(SRC, dir)).flatMap(f =>
        rawControls(fs.readFileSync(f, 'utf8'), false).map(h => `${path.relative(SRC, f)}:${h}`),
      )
      expect(found).toEqual([])
    })
  }

  it('card editor, search, proposal card and viewer only keep documented raw controls', () => {
    const found = MARKED_FILES.flatMap(rel =>
      rawControls(fs.readFileSync(path.join(SRC, rel), 'utf8'), true).map(h => `${rel}:${h}`),
    )
    expect(found).toEqual([])
  })
})
