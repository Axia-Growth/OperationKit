/**
 * scripts/vault-migrate.mjs on a fixture vault (obj 900968).
 *
 * The tool is run the way an operator runs it: as a child `node` process
 * against a throwaway COPY of fixtures/vault-migrate/vault. No db, no server
 * imports, and never a real vault.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(HERE, '../../../../scripts/vault-migrate.mjs')
const FIXTURE = path.join(HERE, 'fixtures', 'vault-migrate')

let tmp = ''
let vault = ''
let ws = ''

/** Every file under dir → its text, so two snapshots can be compared exactly. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(child)
      else out[child] = fs.readFileSync(path.join(dir, child), 'utf8')
    }
  }
  walk('')
  return out
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function migrate(extra: string[] = [], map = path.join(FIXTURE, 'mapping.csv')) {
  return run(['--workspace', ws, '--map', map, '--date', '2026-11-16', ...extra])
}

function mapFile(rows: string): string {
  const file = path.join(tmp, `map-${Math.random().toString(36).slice(2)}.csv`)
  fs.writeFileSync(file, rows)
  return file
}

const read = (rel: string) => fs.readFileSync(path.join(ws, rel), 'utf8')

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-migrate-test-'))
  vault = path.join(tmp, 'vault')
  fs.cpSync(path.join(FIXTURE, 'vault'), vault, { recursive: true })
  ws = path.join(vault, 'acme')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('vault-migrate', () => {
  it('dry run changes nothing', () => {
    const before = snapshot(vault)
    const r = migrate()
    expect(r.code).toBe(0)
    expect(r.out).toContain('DRY RUN, nothing written')
    expect(r.out).toContain('decisions/2026-01-05-pricing-model.md -> products/pricing/2026-01-05-pricing-model.md')
    expect(r.out).toContain('Files to move: 3')
    expect(snapshot(vault)).toEqual(before)
  })

  it('dry run reports exactly what apply then does', () => {
    const dry = JSON.parse(migrate(['--json']).out)
    const applied = JSON.parse(migrate(['--json', '--apply']).out)
    expect(dry.mode).toBe('dry-run')
    expect(applied.mode).toBe('apply')
    for (const key of ['moves', 'links', 'front_matter', 'files_rewritten', 'redirect_rows']) {
      expect(applied[key]).toEqual(dry[key])
    }
  })

  it('apply moves the files and writes the redirect table', () => {
    const r = migrate(['--apply'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('APPLIED')
    expect(Object.keys(snapshot(ws)).sort()).toEqual([
      'archive/moved.md',
      'guides/onboarding.md',
      'guides/style.md',
      'img/chart.png',
      'index.md',
      'products/pricing/2026-01-05-pricing-model.md',
      'projects/hiring/2026-02-10-hiring-plan.md',
      'topics/new-name.md',
    ])
    const moved = read('archive/moved.md')
    expect(moved).toContain('| `decisions/2026-01-05-pricing-model.md` | `products/pricing/2026-01-05-pricing-model.md` | decision | 2026-11-16 |')
    expect(moved).toContain('| `decisions/old-name.md` | `topics/new-name.md` | topic | 2026-11-16 |')
    // The body of a moved page travels with it.
    expect(read('topics/new-name.md')).toContain('Notes with no heading.')
  })

  it('rewrites [[wiki links]] that point at a moved file', () => {
    migrate(['--apply'])
    const index = read('index.md')
    expect(index).toContain('[[products/pricing/2026-01-05-pricing-model]]')
    expect(index).toContain('[[projects/hiring/2026-02-10-hiring-plan#Roles|roles]]')
    // A renamed file: the by-name link follows the new name.
    expect(index).toContain('[[new-name]]')
    expect(index).not.toContain('[[old-name]]')
    // A by-name link whose file kept its name still resolves, so it is left alone.
    expect(index).toContain('[[2026-01-05-pricing-model|Pricing]]')
    expect(read('guides/onboarding.md')).toContain('[[projects/hiring/2026-02-10-hiring-plan]]')
    // Code is never rewritten.
    expect(index).toContain('`[[decisions/2026-01-05-pricing-model]]`')
  })

  it('rewrites relative markdown links, in pages that link to a moved file and inside the moved file', () => {
    migrate(['--apply'])
    const index = read('index.md')
    expect(index).toContain('[Pricing model](products/pricing/2026-01-05-pricing-model.md)')
    expect(index).toContain('[Roles](./projects/hiring/2026-02-10-hiring-plan.md#roles)')
    expect(index).toContain('```\n[Pricing model](decisions/2026-01-05-pricing-model.md)\n```')
    expect(read('guides/onboarding.md')).toContain('[pricing](../products/pricing/2026-01-05-pricing-model.md)')
    // The moved page sits two folders deep now: its own relative links are recomputed.
    const pricing = read('products/pricing/2026-01-05-pricing-model.md')
    expect(pricing).toContain('[hiring plan](../../projects/hiring/2026-02-10-hiring-plan.md)')
    expect(pricing).toContain('[onboarding guide](../../guides/onboarding.md)')
    expect(pricing).toContain('![the chart](../../img/chart.png)')
    expect(read('topics/new-name.md')).toContain('[home](../index.md)')
    // Every rewritten relative link resolves to a real file.
    for (const [file, text] of Object.entries(snapshot(ws))) {
      if (!file.endsWith('.md') || file === 'archive/moved.md') continue
      const prose = text.replace(/```[\s\S]*?```/g, '')
      for (const m of prose.matchAll(/\]\((?!https?:)([^)#\s]+)/g)) {
        const target = path.join(ws, path.dirname(file), m[1])
        expect(fs.existsSync(target), `${file} -> ${m[1]}`).toBe(true)
      }
    }
  })

  it('leaves a link to an unmoved file untouched', () => {
    const before = snapshot(vault)
    migrate(['--apply'])
    const index = read('index.md')
    expect(index).toContain('[[guides/onboarding]]')
    expect(index).toContain('[Onboarding](guides/onboarding.md)')
    expect(index).toContain('[Site](https://example.org/decisions/2026-01-05-pricing-model.md)')
    expect(read('guides/onboarding.md')).toContain('Stay here: [style guide](style.md) and [[guides/style]].')
    // A page with no link to a moved file is byte-identical, and so is everything outside the workspace.
    expect(read('guides/style.md')).toBe(before['acme/guides/style.md'])
    expect(read('img/chart.png')).toBe(before['acme/img/chart.png'])
    expect(fs.readFileSync(path.join(vault, 'other/outside.md'), 'utf8')).toBe(before['other/outside.md'])
  })

  it('adds missing front matter without changing existing keys', () => {
    migrate(['--apply'])
    // No front matter before: all four keys, title from the first heading, date from the file name.
    expect(read('products/pricing/2026-01-05-pricing-model.md').startsWith(
      '---\ntitle: "Pricing model"\ntype: decision\ndate: 2026-01-05\nworkspace: acme\n---\n\n# Pricing model\n',
    )).toBe(true)
    // Existing title, tags and type are kept exactly (the mapping says "project", the page says "plan").
    expect(read('projects/hiring/2026-02-10-hiring-plan.md').startsWith(
      '---\ntitle: Hiring plan 2026\ntags: [people]\ntype: plan\ndate: 2026-02-10\nworkspace: acme\n---\n\n# A different heading\n',
    )).toBe(true)
    // No heading: the title comes from the new file name.
    const renamed = read('topics/new-name.md')
    expect(renamed).toMatch(/^---\ntitle: "New name"\ntype: topic\ndate: \d{4}-\d{2}-\d{2}\nworkspace: acme\n---\n\nNotes with no heading\./)
    // A page that was not in the mapping gets no front matter added.
    expect(read('guides/onboarding.md').startsWith('---\ntitle: Onboarding\n---\n')).toBe(true)
    expect(read('guides/style.md').startsWith('# Style guide')).toBe(true)
  })

  it('refuses paths with "..", absolute paths and anything else that leaves the workspace, and writes nothing', () => {
    const before = snapshot(vault)
    const cases: Array<[string, RegExp]> = [
      ['decisions/old-name.md,../other/stolen.md,topic\n', /paths with "\.\." are refused/],
      ['../other/outside.md,topics/outside.md,topic\n', /paths with "\.\." are refused/],
      ['decisions/old-name.md,topics/../../other/x.md,topic\n', /paths with "\.\." are refused/],
      [`decisions/old-name.md,${path.join(vault, 'other', 'x.md')},topic\n`, /absolute paths are not allowed/],
      ['decisions\\old-name.md,topics/x.md,topic\n', /backslashes are not allowed/],
      ['decisions/old-name.md,guides/style.md,topic\n', /already exists; will not overwrite/],
      ['decisions/nope.md,topics/nope.md,topic\n', /does not exist/],
      ['decisions/old-name.md,topics/a.md,topic\nguides/style.md,topics/a.md,topic\n', /already on row/],
    ]
    for (const [rows, message] of cases) {
      // One good row rides along: a refused run must not apply ANY row.
      const r = migrate(['--apply'], mapFile(`decisions/2026-01-05-pricing-model.md,products/p.md,decision\n${rows}`))
      expect(r.code, rows).toBe(1)
      expect(r.out).toContain('REFUSED, nothing written')
      expect(r.out).toMatch(message)
      expect(snapshot(vault), rows).toEqual(before)
    }
  })

  it('refuses a destination that goes through a symlink out of the workspace', () => {
    fs.symlinkSync(path.join(vault, 'other'), path.join(ws, 'escape'))
    const before = snapshot(path.join(vault, 'other'))
    const r = migrate(['--apply'], mapFile('decisions/old-name.md,escape/stolen.md,topic\n'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/goes through a symlink/)
    expect(snapshot(path.join(vault, 'other'))).toEqual(before)
    expect(fs.existsSync(path.join(ws, 'decisions/old-name.md'))).toBe(true)
  })

  it('a second run is a no-op', () => {
    expect(migrate(['--apply']).code).toBe(0)
    const after = snapshot(vault)
    const dry = migrate()
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('Nothing to do.')
    const again = migrate(['--apply', '--json'])
    expect(again.code).toBe(0)
    const report = JSON.parse(again.out)
    expect(report.changes).toBe(0)
    expect(report.moves).toEqual([])
    expect(report.already_moved).toHaveLength(3)
    expect(report.links).toEqual([])
    expect(report.front_matter).toEqual([])
    expect(snapshot(vault)).toEqual(after)
  })

  it('needs both --workspace and --map', () => {
    const r = run(['--map', path.join(FIXTURE, 'mapping.csv')])
    expect(r.code).toBe(2)
    expect(r.err).toContain('Usage:')
  })
})

// ---- linear scanners that replaced two regexes CodeQL flagged (obj 901153)

type Helpers = {
  mapOutsideCode: (content: string, fn: (text: string, atStart: boolean) => string) => string
  findClosingTickRun: (line: string, from: number, n: number) => number
  atxHeadingText: (line: string) => string | null
}
const helpers = async () => (await import(pathToFileURL(SCRIPT).href)) as Helpers

/** The pre-901153 inline-span scanner, verbatim, as the oracle for "behaviour unchanged". */
function oldMapOutsideCode(content: string, fn: (text: string, atStart: boolean) => string) {
  const parts = content.split(/(\r?\n)/)
  let fence: string | null = null
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (fence || !line) continue
    let out = ''
    let pos = 0
    const tick = /`+/g
    let m
    while ((m = tick.exec(line))) {
      const closeRe = new RegExp('(?<!`)' + m[0] + '(?!`)', 'g')
      closeRe.lastIndex = m.index + m[0].length
      const c = closeRe.exec(line)
      if (!c) continue
      out += fn(line.slice(pos, m.index), m.index === 0) + line.slice(m.index, c.index + m[0].length)
      pos = c.index + m[0].length
      tick.lastIndex = pos
    }
    parts[i] = out + fn(line.slice(pos), pos === 0)
  }
  return parts.join('')
}
const oldHeading = (line: string) => {
  const h = line.match(/^#\s+(.+?)\s*#*\s*$/)
  return h ? h[1].trim() : null
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
}
const randomString = (next: () => number, alphabet: string[], max: number) => {
  let s = ''
  const n = Math.floor(next() * max)
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(next() * alphabet.length)]
  return s
}
const mark = (text: string) => `<${text}>`

describe('vault-migrate inline code spans (no dynamic RegExp)', () => {
  it('skips code spans of 1, 2 and 3 backticks', async () => {
    const { mapOutsideCode } = await helpers()
    expect(mapOutsideCode('a `x` b', mark)).toBe('<a >`x`< b>')
    expect(mapOutsideCode('a ``x ` y`` b', mark)).toBe('<a >``x ` y``< b>')
    expect(mapOutsideCode('a ```x `` y``` b', mark)).toBe('<a >```x `` y```< b>')
    expect(mapOutsideCode('`x` and ``y``', mark)).toBe('<>`x`< and >``y``<>')
  })

  it('treats unbalanced runs as plain text', async () => {
    const { mapOutsideCode, findClosingTickRun } = await helpers()
    expect(mapOutsideCode('a `x b', mark)).toBe('<a `x b>')
    expect(mapOutsideCode('a ``x` b', mark)).toBe('<a ``x` b>')
    expect(mapOutsideCode('a ```x`` b', mark)).toBe('<a ```x`` b>')
    // the unmatched `` is text; the later single-tick pair is still a span
    expect(mapOutsideCode('a ``x `y` z', mark)).toBe('<a ``x >`y`< z>')
    expect(findClosingTickRun('``x```y``', 2, 2)).toBe(7)
    expect(findClosingTickRun('``x```', 2, 2)).toBe(-1)
  })

  it('matches the old RegExp scanner on random input', async () => {
    const { mapOutsideCode } = await helpers()
    const next = rng(901153)
    const alphabet = ['`', '`', '`', 'a', ' ', '[', ']', '\n', '~']
    for (let i = 0; i < 5000; i++) {
      const s = randomString(next, alphabet, 30)
      expect(mapOutsideCode(s, mark), JSON.stringify(s)).toBe(oldMapOutsideCode(s, mark))
    }
  })
})

describe('vault-migrate title from the first # heading (linear)', () => {
  it('reads ordinary headings', async () => {
    const { atxHeadingText } = await helpers()
    expect(atxHeadingText('# Hello world')).toBe('Hello world')
    expect(atxHeadingText('#   Spaced   ## ')).toBe('Spaced')
    expect(atxHeadingText('# C# notes')).toBe('C# notes')
    expect(atxHeadingText('# ##')).toBe('#')
    expect(atxHeadingText('#   ')).toBe('')
    expect(atxHeadingText('#Nope')).toBeNull()
    expect(atxHeadingText('## Two')).toBeNull()
  })

  it('matches the old regex on random input', async () => {
    const { atxHeadingText } = await helpers()
    const next = rng(42)
    const alphabet = [' ', ' ', '#', '#', 'a', '\t', ' ', '\r', ' ']
    for (let i = 0; i < 20000; i++) {
      const s = '#' + randomString(next, alphabet, 14)
      expect(atxHeadingText(s), JSON.stringify(s)).toBe(oldHeading(s))
    }
  })

  it('stays fast on long runs of spaces and #', async () => {
    const { atxHeadingText } = await helpers()
    const t = Date.now()
    expect(atxHeadingText('# a' + ' #'.repeat(50000) + ' x')).toBe('a' + ' #'.repeat(50000) + ' x')
    expect(atxHeadingText('# ' + ' '.repeat(100000) + ' ')).toBe('')
    expect(Date.now() - t).toBeLessThan(1000)
  })
})
