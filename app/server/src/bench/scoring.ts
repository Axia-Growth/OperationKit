/**
 * Scoring — the ONLY judge of success, identical for every arm.
 *
 * After an arm finishes, the task's hidden checks (tasks/<id>/check/*.test.js) are
 * copied into `<workdir>/.bench-check/` and run with `node --test`. A run succeeds
 * when every check passes AND every `must_exist` path exists. The agent never sees
 * the checks: they are not in the starting repo and any `.bench-check/` it created
 * is deleted first.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Score, TaskSpec } from './types.js'

export const CHECK_DIR = '.bench-check'
const CHECK_TIMEOUT_MS = 60_000

/** Fresh temp copy of the task's starting repo. */
export function prepareWorkdir(task: TaskSpec, parent = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(parent, `cc-bench-${task.id}-`))
  fs.cpSync(path.join(task.dir, 'repo'), dir, { recursive: true })
  return dir
}

/** Resolve `rel` inside `root`, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  const r = path.resolve(root)
  if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error(`path escapes the workdir: ${rel}`)
  return abs
}

/** Parse the `# pass N` / `# fail N` totals node:test prints in TAP mode. */
export function parseTapTotals(out: string): { pass: number; fail: number } {
  const num = (k: string) => {
    const m = new RegExp(`^# ${k} (\\d+)$`, 'm').exec(out)
    return m ? Number(m[1]) : 0
  }
  return { pass: num('pass'), fail: num('fail') + num('cancelled') }
}

/**
 * Minimal environment for the check process: no secrets, no inherited NODE_OPTIONS
 * that could load code, no proxy/test-runner flags from the parent vitest.
 */
function checkEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: os.tmpdir(),
    TMPDIR: os.tmpdir(),
    LANG: 'C.UTF-8',
  }
}

export function scoreWorkdir(task: TaskSpec, workdir: string): Score {
  const missing = task.must_exist.filter((rel) => !fs.existsSync(safeJoin(workdir, rel)))
  const checkDst = path.join(workdir, CHECK_DIR)
  fs.rmSync(checkDst, { recursive: true, force: true })
  fs.cpSync(path.join(task.dir, 'check'), checkDst, { recursive: true })
  const files = fs.readdirSync(checkDst).filter((f) => f.endsWith('.test.js')).sort()
  if (!files.length) throw new Error(`task ${task.id} has no check/*.test.js`)

  const res = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...files.map((f) => path.join(CHECK_DIR, f))],
    { cwd: workdir, env: checkEnv(), encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  )
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const { pass, fail } = parseTapTotals(out)
  const timedOut = res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  const exit = timedOut ? null : res.status
  const tail = out.trim().split('\n').slice(-25).join('\n')
  return {
    // pass > 0 guards against a checker that silently ran nothing.
    success: exit === 0 && fail === 0 && pass > 0 && missing.length === 0,
    checks_passed: pass,
    checks_failed: fail,
    missing_files: missing,
    check_exit_code: exit,
    output_tail: timedOut ? `check timed out after ${CHECK_TIMEOUT_MS}ms\n${tail}` : tail,
  }
}

/** Snapshot of files that differ from the task's starting repo (null = deleted). */
export function diffAgainstRepo(task: TaskSpec, workdir: string, ignore: string[] = [CHECK_DIR, 'node_modules', '.git']): Record<string, string | null> {
  const start = path.join(task.dir, 'repo')
  const walk = (dir: string, base: string): string[] => {
    if (!fs.existsSync(dir)) return []
    const out: string[] = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.relative(base, path.join(dir, e.name))
      if (ignore.some((i) => rel === i || rel.startsWith(i + path.sep))) continue
      if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), base))
      else if (e.isFile()) out.push(rel)
    }
    return out
  }
  const changed: Record<string, string | null> = {}
  const now = new Set(walk(workdir, workdir))
  for (const rel of [...now].sort()) {
    const cur = fs.readFileSync(path.join(workdir, rel), 'utf8')
    const orig = path.join(start, rel)
    if (!fs.existsSync(orig) || fs.readFileSync(orig, 'utf8') !== cur) changed[rel.split(path.sep).join('/')] = cur
  }
  for (const rel of walk(start, start)) if (!now.has(rel)) changed[rel.split(path.sep).join('/')] = null
  return changed
}
