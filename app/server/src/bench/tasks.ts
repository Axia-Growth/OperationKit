/** Task-set loading, seeded ordering and task selection for the benchmark. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Arm, TaskSet, TaskSpec } from './types.js'

/** app/server/fixtures/bench — resolved from this file so it works from any cwd. */
export const DEFAULT_TASKSET_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'fixtures', 'bench',
)
export const DEFAULT_TASKSET_VERSION = 'v1'

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p, base))
    else if (e.isFile()) out.push(path.relative(base, p))
  }
  return out
}

/** Every regular file under `dir`, relative paths, sorted. */
export function listRepoFiles(dir: string): string[] {
  return fs.existsSync(dir) ? listFiles(dir) : []
}

export function hashDir(dir: string): string {
  const h = crypto.createHash('sha256')
  for (const rel of listFiles(dir)) {
    h.update(rel.split(path.sep).join('/'))
    h.update('\0')
    h.update(fs.readFileSync(path.join(dir, rel)))
    h.update('\0')
  }
  return h.digest('hex')
}

export function loadTaskSet(versionDir = path.join(DEFAULT_TASKSET_ROOT, DEFAULT_TASKSET_VERSION)): TaskSet {
  const root = path.resolve(versionDir)
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  if (raw.schema !== 'cc-bench-taskset/1') throw new Error(`unsupported task-set schema: ${raw.schema}`)
  const seen = new Set<string>()
  const tasks: TaskSpec[] = raw.tasks.map((t: Omit<TaskSpec, 'dir'>) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) throw new Error(`bad task id: ${t.id}`)
    if (seen.has(t.id)) throw new Error(`duplicate task id: ${t.id}`)
    seen.add(t.id)
    const dir = path.join(root, 'tasks', t.id)
    for (const sub of ['repo', 'check']) {
      if (!fs.existsSync(path.join(dir, sub))) throw new Error(`task ${t.id} is missing ${sub}/`)
    }
    if (!t.prompt || !Array.isArray(t.must_exist)) throw new Error(`task ${t.id} needs prompt and must_exist`)
    for (const arm of ['board', 'baseline'] as Arm[]) {
      if (!(Number.isFinite(t.est_usd?.[arm]) && t.est_usd[arm] > 0)) throw new Error(`task ${t.id} needs est_usd.${arm} > 0`)
    }
    return { ...t, dir }
  })
  for (const id of raw.smoke ?? []) if (!seen.has(id)) throw new Error(`smoke task ${id} is not in the set`)
  return {
    schema: raw.schema,
    version: raw.version,
    description: raw.description ?? '',
    smoke: raw.smoke ?? [],
    tasks,
    root,
    hash: hashDir(root),
  }
}

/** mulberry32 — tiny, deterministic, good enough for shuffling a dozen tasks. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates with a seeded RNG. Same seed + same input = same order, everywhere. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  const rnd = seededRandom(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Per-task arm order. Alternating which arm goes first (seeded) keeps time-of-day
 * drift, rate limits and prompt-cache warmth from always favouring the same arm.
 */
export function armOrder(arms: readonly Arm[], seed: number, index: number): Arm[] {
  if (arms.length < 2) return [...arms]
  const flip = seededRandom((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0)() < 0.5
  return flip ? [...arms].reverse() : [...arms]
}

/** `smoke` | `all` | comma list of ids. Unknown ids are an error, never silently dropped. */
export function selectTasks(set: TaskSet, selector: string): TaskSpec[] {
  if (selector === 'all') return set.tasks
  const ids = selector === 'smoke' ? set.smoke : selector.split(',').map((s) => s.trim()).filter(Boolean)
  const byId = new Map(set.tasks.map((t) => [t.id, t]))
  const unknown = ids.filter((id) => !byId.has(id))
  if (unknown.length) throw new Error(`unknown task id(s): ${unknown.join(', ')}`)
  if (!ids.length) throw new Error('no tasks selected')
  return ids.map((id) => byId.get(id)!)
}
