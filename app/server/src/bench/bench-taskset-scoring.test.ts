/**
 * Benchmark task set + scorer (obj 900908). The scorer is the only judge of
 * success, so it is tested on BOTH outcomes for every task: each starting repo must
 * fail its hidden checks and each reference solution must pass them.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECK_DIR, diffAgainstRepo, parseTapTotals, prepareWorkdir, safeJoin, scoreWorkdir } from './scoring.js'
import { armOrder, loadTaskSet, seededShuffle, selectTasks } from './tasks.js'

const set = loadTaskSet()
const dirs: string[] = []
const work = (taskId: string) => {
  const d = prepareWorkdir(set.tasks.find((t) => t.id === taskId)!)
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('task set v1', () => {
  it('has at least 10 self-contained tasks with unique ids and a 1-2 task smoke subset', () => {
    expect(set.schema).toBe('cc-bench-taskset/1')
    expect(set.version).toBe('v1')
    expect(set.tasks.length).toBeGreaterThanOrEqual(10)
    expect(new Set(set.tasks.map((t) => t.id)).size).toBe(set.tasks.length)
    expect(set.smoke.length).toBeGreaterThanOrEqual(1)
    expect(set.smoke.length).toBeLessThanOrEqual(2)
    expect(set.hash).toMatch(/^[0-9a-f]{64}$/)
    for (const t of set.tasks) {
      // No dependencies: a task must be solvable and checkable with node alone.
      const pkg = JSON.parse(fs.readFileSync(path.join(t.dir, 'repo', 'package.json'), 'utf8'))
      expect(pkg.dependencies ?? {}).toEqual({})
      expect(fs.existsSync(path.join(t.dir, 'repo', CHECK_DIR))).toBe(false)
    }
  })

  it.each(set.tasks.map((t) => t.id))('%s: starting repo FAILS and reference solution PASSES', (id) => {
    const task = set.tasks.find((t) => t.id === id)!
    const start = scoreWorkdir(task, work(id))
    expect(start.success).toBe(false)

    const solved = work(id)
    fs.cpSync(path.join(task.dir, 'solution'), solved, { recursive: true })
    const s = scoreWorkdir(task, solved)
    expect(s.output_tail).not.toMatch(/not ok/)
    expect(s).toMatchObject({ success: true, checks_failed: 0, missing_files: [], check_exit_code: 0 })
    expect(s.checks_passed).toBeGreaterThan(0)
  })
})

describe('scorer', () => {
  it('parses node:test TAP totals', () => {
    expect(parseTapTotals('ok 1 - a\n# tests 3\n# pass 2\n# fail 1\n# cancelled 0\n')).toEqual({ pass: 2, fail: 1 })
    expect(parseTapTotals('garbage')).toEqual({ pass: 0, fail: 0 })
  })

  it('fails a run whose checks pass but a must_exist file is missing', () => {
    const task = set.tasks.find((t) => t.id === 't10-release-notes')!
    const d = work(task.id)
    fs.cpSync(path.join(task.dir, 'solution'), d, { recursive: true })
    fs.rmSync(path.join(d, 'CHANGELOG.md'))
    const s = scoreWorkdir(task, d)
    expect(s.success).toBe(false)
    expect(s.missing_files).toEqual(['CHANGELOG.md'])
  })

  it('replaces any .bench-check/ the agent planted, so it cannot grade itself', () => {
    const d = work('t01-sum-range')
    fs.mkdirSync(path.join(d, CHECK_DIR))
    fs.writeFileSync(path.join(d, CHECK_DIR, 'range.test.js'), "import test from 'node:test'\ntest('fake', () => {})\n")
    fs.writeFileSync(path.join(d, CHECK_DIR, 'extra.test.js'), "import test from 'node:test'\ntest('fake2', () => {})\n")
    const s = scoreWorkdir(set.tasks.find((t) => t.id === 't01-sum-range')!, d)
    expect(s.success).toBe(false)
    expect(fs.existsSync(path.join(d, CHECK_DIR, 'extra.test.js'))).toBe(false)
  })

  it('refuses paths that escape the workdir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-safe-'))
    dirs.push(root)
    expect(safeJoin(root, 'src/a.js')).toBe(path.join(root, 'src/a.js'))
    expect(() => safeJoin(root, '../evil.js')).toThrow(/escapes/)
    expect(() => safeJoin(root, '/etc/passwd')).toThrow(/escapes/)
  })

  it('diffs a workdir against the starting repo (changed, added, deleted)', () => {
    const task = set.tasks.find((t) => t.id === 't09-rename-refactor')!
    const d = work(task.id)
    fs.writeFileSync(path.join(d, 'src', 'new.js'), 'export {}\n')
    fs.rmSync(path.join(d, 'src', 'cart.js'))
    fs.writeFileSync(path.join(d, 'src', 'pricing.js'), 'x\n')
    expect(diffAgainstRepo(task, d)).toEqual({ 'src/new.js': 'export {}\n', 'src/pricing.js': 'x\n', 'src/cart.js': null })
  })
})

describe('seeded ordering', () => {
  it('is deterministic per seed and a permutation of the input', () => {
    const ids = set.tasks.map((t) => t.id)
    const a = seededShuffle(ids, 19)
    expect(seededShuffle(ids, 19)).toEqual(a)
    expect([...a].sort()).toEqual([...ids].sort())
    expect(seededShuffle(ids, 20)).not.toEqual(a)
  })

  it('alternates which arm goes first, deterministically', () => {
    const firsts = Array.from({ length: 12 }, (_, i) => armOrder(['board', 'baseline'], 19, i)[0])
    expect(new Set(firsts).size).toBe(2)
    expect(Array.from({ length: 12 }, (_, i) => armOrder(['board', 'baseline'], 19, i)[0])).toEqual(firsts)
    expect(armOrder(['baseline'], 19, 0)).toEqual(['baseline'])
  })

  it('selects smoke / all / explicit ids and rejects unknown ids', () => {
    expect(selectTasks(set, 'smoke').map((t) => t.id)).toEqual(set.smoke)
    expect(selectTasks(set, 'all')).toHaveLength(set.tasks.length)
    expect(selectTasks(set, 't04-roman, t01-sum-range').map((t) => t.id)).toEqual(['t04-roman', 't01-sum-range'])
    expect(() => selectTasks(set, 't01-sum-range,nope')).toThrow(/unknown task id/)
  })
})
