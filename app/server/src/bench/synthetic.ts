/**
 * Builds the SYNTHETIC transcripts mock mode replays in CI. They are test fixtures
 * for the harness, not measurements: the numbers are made up (deterministic per
 * task id) and every file is marked `provenance: "synthetic"`.
 *
 * They are shaped like real Claude Code stream-json so the replayer is exercised on
 * Write, Edit and MultiEdit tool calls and on a `files` snapshot, and they include
 * deliberate failures so scoring is tested on both outcomes:
 *   - baseline writes a buggy CSV parser (t06) and a buggy semver compare (t07);
 *   - board: the reviewer FAILS the buggy CSV parser, the worker fixes it in round 2;
 *     the reviewer PASSES the buggy semver compare, and the hidden checks still fail it
 *     (the reviewer is never the judge of success);
 *   - board t03 records one human follow-up.
 *
 * Regenerate: npx tsx src/bench/cli.ts make-synthetic  (writes fixtures/bench/transcripts/v1)
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Arm, StreamEvent, TaskSet, TaskSpec, Transcript, TranscriptRound, WorkerRound } from './types.js'

const RECORDED_AT = '2026-11-15T00:00:00.000Z'
const MODEL = 'claude-sonnet-5-5'
/** The fake cwd the synthetic sessions "ran" in; absolute tool paths are rebased from it. */
const CWD = '/tmp/cc-bench-synthetic'

const BUGGY_CSV = `// Parses CSV text into rows. Handles quotes, but splits lines first.
export function parseCsv(text) {
  return text
    .split(/\\r?\\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const out = []
      let field = ''
      let quoted = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (quoted) {
          if (c === '"' && line[i + 1] === '"') { field += '"'; i++ }
          else if (c === '"') quoted = false
          else field += c
        } else if (c === '"') quoted = true
        else if (c === ',') { out.push(field); field = '' }
        else field += c
      }
      out.push(field)
      return out
    })
}
`

const BUGGY_SEMVER = `export function compareSemver(a, b) {
  const [ca, pa] = a.split('-', 2)
  const [cb, pb] = b.split('-', 2)
  const na = ca.split('.').map(Number)
  const nb = cb.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (na[i] !== nb[i]) return na[i] < nb[i] ? -1 : 1
  if (pa === pb) return 0
  if (pa === undefined) return 1
  if (pb === undefined) return -1
  return pa < pb ? -1 : 1 // lexical: wrong for numeric identifiers (beta.11 vs beta.2)
}
`

/** Deterministic pseudo-random in [0,1) from a string. */
function unit(key: string): number {
  return crypto.createHash('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32
}

function solutionFiles(task: TaskSpec): Record<string, string> {
  const dir = path.join(task.dir, 'solution')
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

function initEvent(): StreamEvent {
  return { type: 'system', subtype: 'init', model: MODEL, cwd: CWD, tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash'] }
}

function assistantToolUse(name: string, input: Record<string, unknown>, n: number): StreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_synthetic_${n}`, name, input }] } }
}

function resultEvent(key: string, scale: number): StreamEvent {
  const r = unit(key)
  const input = Math.round((4_000 + r * 6_000) * scale)
  const output = Math.round((900 + r * 2_400) * scale)
  const cacheRead = Math.round((40_000 + r * 90_000) * scale)
  const cacheCreation = Math.round((8_000 + r * 12_000) * scale)
  const cost = (input * 3 + output * 15 + cacheRead * 0.3 + cacheCreation * 3.75) / 1e6
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: Math.round((35_000 + r * 70_000) * scale),
    num_turns: Math.round(4 + r * 8),
    total_cost_usd: Math.round(cost * 1e6) / 1e6,
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation },
  }
}

/** One worker round that writes `files` through Write calls (absolute paths, like the real CLI). */
function writeRound(files: Record<string, string>, key: string, scale: number): WorkerRound {
  let n = 0
  const events: StreamEvent[] = [initEvent()]
  for (const [rel, content] of Object.entries(files)) {
    events.push(assistantToolUse('Read', { file_path: `${CWD}/${rel}` }, n++))
    events.push(assistantToolUse('Write', { file_path: `${CWD}/${rel}`, content }, n++))
  }
  events.push(assistantToolUse('Bash', { command: 'node --test', description: 'Run tests' }, n++))
  events.push(resultEvent(key, scale))
  return { role: 'worker', cwd: CWD, events }
}

function editRound(edits: Array<{ file: string; old_string: string; new_string: string }>, key: string, scale: number, multi = false): WorkerRound {
  const events: StreamEvent[] = [initEvent()]
  if (multi) {
    const byFile = new Map<string, Array<{ old_string: string; new_string: string; replace_all?: boolean }>>()
    for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), { old_string: e.old_string, new_string: e.new_string, replace_all: true }])
    let n = 0
    for (const [file, list] of byFile) events.push(assistantToolUse('MultiEdit', { file_path: `${CWD}/${file}`, edits: list }, n++))
  } else {
    edits.forEach((e, i) => events.push(assistantToolUse('Edit', { file_path: `${CWD}/${e.file}`, old_string: e.old_string, new_string: e.new_string }, i)))
  }
  events.push(resultEvent(key, scale))
  return { role: 'worker', cwd: CWD, events }
}

function review(key: string, verdict: 'pass' | 'fail', findings: string): TranscriptRound {
  const r = unit(`review:${key}`)
  return {
    role: 'reviewer',
    verdict,
    findings,
    cost_usd: Math.round((0.35 + r * 0.5) * 1e4) / 1e4,
    tokens: { input: Math.round(9_000 + r * 5_000), output: Math.round(1_500 + r * 1_500), cache_read: Math.round(120_000 + r * 80_000), cache_creation: Math.round(15_000 + r * 10_000) },
    duration_ms: Math.round(150_000 + r * 120_000),
  }
}

function workerRoundFor(task: TaskSpec, arm: Arm, files: Record<string, string>, scale: number): WorkerRound {
  const key = `${arm}:${task.id}`
  // Exercise each replay path on at least one task.
  if (task.id === 't01-sum-range' && arm === 'board') {
    return editRound([{ file: 'src/range.js', old_string: 'i < to', new_string: 'i <= to' }], key, scale)
  }
  if (task.id === 't09-rename-refactor' && arm === 'baseline') {
    return editRound([
      { file: 'src/pricing.js', old_string: 'calc', new_string: 'computeTotal' },
      { file: 'src/cart.js', old_string: 'calc', new_string: 'computeTotal' },
    ], key, scale, true)
  }
  if (task.id === 't10-release-notes' && arm === 'board') {
    return { role: 'worker', cwd: CWD, events: [initEvent(), resultEvent(key, scale)], files }
  }
  return writeRound(files, key, scale)
}

export function buildSyntheticTranscript(task: TaskSpec, arm: Arm): Transcript {
  const sol = solutionFiles(task)
  const rounds: TranscriptRound[] = []
  const base: Omit<Transcript, 'rounds'> = { schema: 'cc-bench-transcript/1', arm, task_id: task.id, provenance: 'synthetic', model: MODEL, recorded_at: RECORDED_AT }
  if (arm === 'baseline') {
    const files = task.id === 't06-csv-quotes' ? { 'src/csv.js': BUGGY_CSV } : task.id === 't07-semver-compare' ? { 'src/semver.js': BUGGY_SEMVER } : sol
    rounds.push(workerRoundFor(task, arm, files, 1))
    return { ...base, rounds }
  }
  // Board: the worker session carries the board's prompt scaffolding (larger context).
  const overhead = Math.round(45_000 + unit(`overhead:${task.id}`) * 90_000)
  if (task.id === 't06-csv-quotes') {
    rounds.push(workerRoundFor(task, arm, { 'src/csv.js': BUGGY_CSV }, 1.6))
    rounds.push(review(`${task.id}:1`, 'fail', 'A newline inside a quoted field splits the row: parseCsv(\'"line1\\nline2",x\') returns two rows.'))
    rounds.push(workerRoundFor(task, arm, sol, 1.2))
    rounds.push(review(`${task.id}:2`, 'pass', 'Quoted newlines, doubled quotes and CRLF handled.'))
  } else if (task.id === 't07-semver-compare') {
    rounds.push(workerRoundFor(task, arm, { 'src/semver.js': BUGGY_SEMVER }, 1.6))
    rounds.push(review(task.id, 'pass', 'Core and prerelease ordering look correct.'))
  } else {
    rounds.push(workerRoundFor(task, arm, sol, 1.6))
    rounds.push(review(task.id, 'pass', 'Change matches the brief.'))
  }
  return {
    ...base,
    overhead_ms: overhead,
    rounds,
    ...(task.id === 't03-parse-duration' ? { human_interventions: [{ after_round: 0, kind: 'owner_message', text: 'synthetic: owner asked the worker to also reject whitespace' }] } : {}),
  }
}

export function writeSyntheticTranscripts(set: TaskSet, outDir: string): string[] {
  const written: string[] = []
  for (const task of set.tasks) {
    for (const arm of ['board', 'baseline'] as Arm[]) {
      const p = path.join(outDir, arm, `${task.id}.json`)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify(buildSyntheticTranscript(task, arm), null, 2) + '\n')
      written.push(p)
    }
  }
  return written
}
