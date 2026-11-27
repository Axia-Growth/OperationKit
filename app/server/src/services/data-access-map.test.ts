import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildDataAccessBlock,
  dataAccessFlagTemplate,
  parseDataAccessFlag,
  readDataAccessMapState,
  DATA_ACCESS_MAP_REL,
  DATA_ACCESS_FLAGS_REL,
  DATA_ACCESS_GAPS,
} from './data-access-map.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function write(rel: string, text: string) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

const obj = { id: 4242, workspace: 'acme' }

describe('data-access map: paths', () => {
  it('lives at data-access/map.md with flags in data-access/flags', () => {
    expect(DATA_ACCESS_MAP_REL).toBe('data-access/map.md')
    expect(DATA_ACCESS_FLAGS_REL).toBe('data-access/flags')
  })
})

describe('readDataAccessMapState', () => {
  it('no map = no prompt state, even with flags on disk', () => {
    write(`${DATA_ACCESS_FLAGS_REL}/2026-11-23-x.md`, '---\nstatus: open\n---\n')
    expect(readDataAccessMapState('acme', dir)).toMatchObject({ exists: false, openFlags: 0 })
  })

  it('counts open flags only; README and non-markdown are ignored', () => {
    write(DATA_ACCESS_MAP_REL, '# Data-access map\n')
    write(`${DATA_ACCESS_FLAGS_REL}/README.md`, 'how to flag')
    write(`${DATA_ACCESS_FLAGS_REL}/2026-11-20-a.md`, '---\nkind: knowledge-gap\nstatus: open\n---\n')
    write(`${DATA_ACCESS_FLAGS_REL}/2026-11-21-b.md`, '---\nstatus: resolved\n---\n')
    write(`${DATA_ACCESS_FLAGS_REL}/2026-11-22-c.md`, 'typed by hand, no frontmatter')
    write(`${DATA_ACCESS_FLAGS_REL}/notes.txt`, 'x')
    expect(readDataAccessMapState('acme', dir)).toEqual({ exists: true, openFlags: 2, kbDir: dir })
  })

  it('a symlinked map is not followed (could point out of the workspace)', () => {
    const outside = path.join(dir, 'outside.md')
    fs.writeFileSync(outside, '# elsewhere')
    fs.mkdirSync(path.join(dir, 'data-access'))
    fs.symlinkSync(outside, path.join(dir, DATA_ACCESS_MAP_REL))
    expect(readDataAccessMapState('acme', dir).exists).toBe(false)
  })

  it('never throws on a missing folder', () => {
    expect(readDataAccessMapState('acme', path.join(dir, 'nope')).exists).toBe(false)
  })
})

describe('parseDataAccessFlag', () => {
  it('reads the template it hands out back as an open knowledge-gap on the map', () => {
    const f = parseDataAccessFlag(dataAccessFlagTemplate('card #1'))
    expect(f).toMatchObject({ kind: 'knowledge-gap', target: DATA_ACCESS_MAP_REL, status: 'open', open: true })
  })

  it('closed statuses are not open', () => {
    for (const s of ['resolved', 'Rejected', 'wontfix']) {
      expect(parseDataAccessFlag(`---\nstatus: ${s}\n---\n`).open).toBe(false)
    }
  })

  it('the template names every gap kind', () => {
    const t = dataAccessFlagTemplate('x')
    for (const g of DATA_ACCESS_GAPS) expect(t).toContain(g)
  })
})

describe('buildDataAccessBlock', () => {
  it('is empty when the workspace has no map, so prompts are unchanged', () => {
    expect(buildDataAccessBlock(obj, false, { exists: false, openFlags: 0, kbDir: dir })).toEqual([])
    expect(buildDataAccessBlock(obj, true, { exists: false, openFlags: 0, kbDir: null })).toEqual([])
  })

  it('tells the agent to consult the map, flag not copy, and not to edit the map itself', () => {
    const text = buildDataAccessBlock(obj, false, { exists: true, openFlags: 0, kbDir: dir }).join('\n')
    expect(text).toContain('## Data-access map')
    expect(text).toContain('data-access/map.md')
    expect(text).toMatch(/Flag, don't copy/)
    expect(text).toMatch(/Never put rows, exports, query results or schema dumps/)
    expect(text).toMatch(/Do not edit `data-access\/map\.md` yourself/)
    expect(text).toContain('flagged_by: card #4242')
    expect(text).toContain(path.join(dir, DATA_ACCESS_MAP_REL))
    expect(text).not.toContain('open flag')
  })

  it('mentions open flags so an agent checks them first', () => {
    const one = buildDataAccessBlock(obj, false, { exists: true, openFlags: 1, kbDir: dir }).join('\n')
    expect(one).toContain('1 open flag waiting')
    const many = buildDataAccessBlock(obj, false, { exists: true, openFlags: 3, kbDir: dir }).join('\n')
    expect(many).toContain('3 open flags waiting')
  })

  it('jailed: reads and writes through /api/docs/file, never a host path', () => {
    const text = buildDataAccessBlock(obj, true, { exists: true, openFlags: 0, kbDir: dir }).join('\n')
    expect(text).toContain('/api/docs/file')
    expect(text).toContain('X-CC-Session-Token: $CC_SESSION_TOKEN')
    expect(text).toContain('"/data-access/flags/"')
    expect(text).not.toContain(dir)
    expect(text).not.toContain('/api/internal')
  })

  it('reads the disk by default', () => {
    write(DATA_ACCESS_MAP_REL, '# map')
    const state = readDataAccessMapState('acme', dir)
    expect(buildDataAccessBlock(obj, false, state).length).toBeGreaterThan(0)
  })
})
