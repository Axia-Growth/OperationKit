/**
 * Recorded transcripts (`cc-bench-transcript/1`): read metrics out of them and
 * replay their file edits onto a workdir. This is what mock mode runs instead of a
 * model, so CI exercises the real scorer, budget guard and report with zero calls.
 */
import fs from 'node:fs'
import path from 'node:path'
import { safeJoin } from './scoring.js'
import type { Arm, ArmOutcome, ReviewerRound, StreamEvent, TokenUsage, Transcript, WorkerRound } from './types.js'

export function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 }
}

export function addTokens(a: TokenUsage, b: Partial<TokenUsage>): TokenUsage {
  const input = a.input + (b.input ?? 0)
  const output = a.output + (b.output ?? 0)
  const cache_read = a.cache_read + (b.cache_read ?? 0)
  const cache_creation = a.cache_creation + (b.cache_creation ?? 0)
  return { input, output, cache_read, cache_creation, total: input + output + cache_read + cache_creation }
}

/** The final `result` event of a Claude Code stream-json session, normalised. */
export function resultOf(events: StreamEvent[]): { cost_usd: number; duration_ms: number; tokens: TokenUsage; is_error: boolean; model: string | null } | null {
  const r = [...events].reverse().find((e) => e.type === 'result')
  if (!r) return null
  const u = (r.usage ?? {}) as Record<string, number | undefined>
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
  return {
    cost_usd: Number(r.total_cost_usd ?? 0),
    duration_ms: Number(r.duration_ms ?? 0),
    tokens: addTokens(emptyTokens(), {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      cache_creation: u.cache_creation_input_tokens ?? 0,
    }),
    is_error: Boolean(r.is_error),
    model: typeof init?.model === 'string' ? init.model : null,
  }
}

interface ToolUse { name: string; input: Record<string, unknown> }

function toolUses(events: StreamEvent[]): ToolUse[] {
  const out: ToolUse[] = []
  for (const e of events) {
    if (e.type !== 'assistant') continue
    const content = (e.message as { content?: unknown[] } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const c of content as Array<Record<string, unknown>>) {
      if (c?.type === 'tool_use' && typeof c.name === 'string') out.push({ name: c.name, input: (c.input ?? {}) as Record<string, unknown> })
    }
  }
  return out
}

/** Map a recorded (possibly absolute) tool path into the replay workdir. */
function rebase(p: string, recordedCwd: string | undefined, workdir: string): string {
  let rel = p
  if (path.isAbsolute(p)) {
    if (!recordedCwd) throw new Error(`absolute path ${p} in a round with no recorded cwd`)
    rel = path.relative(recordedCwd, p)
  }
  return safeJoin(workdir, rel)
}

function applyEdit(text: string, oldS: string, newS: string, all: boolean): string | null {
  if (!oldS || !text.includes(oldS)) return null
  return all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS)
}

/**
 * Apply one worker round to `workdir`. A `files` snapshot, when present, is
 * authoritative; otherwise Write / Edit / MultiEdit tool calls are replayed in order.
 * Returns warnings (an Edit whose old_string is missing — the same failure the live
 * tool would have reported).
 */
export function applyWorkerRound(round: WorkerRound, workdir: string): string[] {
  const warnings: string[] = []
  if (round.files) {
    for (const [rel, content] of Object.entries(round.files)) {
      const abs = safeJoin(workdir, rel)
      if (content === null) fs.rmSync(abs, { force: true })
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content)
      }
    }
    return warnings
  }
  for (const t of toolUses(round.events)) {
    if (!['Write', 'Edit', 'MultiEdit'].includes(t.name)) continue
    const abs = rebase(String(t.input.file_path ?? ''), round.cwd, workdir)
    if (t.name === 'Write') {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, String(t.input.content ?? ''))
      continue
    }
    if (!fs.existsSync(abs)) {
      warnings.push(`${t.name} on missing file ${path.relative(workdir, abs)}`)
      continue
    }
    let text = fs.readFileSync(abs, 'utf8')
    const edits = t.name === 'Edit'
      ? [t.input]
      : ((t.input.edits as Array<Record<string, unknown>> | undefined) ?? [])
    for (const e of edits) {
      const next = applyEdit(text, String(e.old_string ?? ''), String(e.new_string ?? ''), Boolean(e.replace_all))
      if (next === null) warnings.push(`${t.name}: old_string not found in ${path.relative(workdir, abs)}`)
      else text = next
    }
    fs.writeFileSync(abs, text)
  }
  return warnings
}

export function validateTranscript(t: unknown, expect?: { arm: Arm; task_id: string }): Transcript {
  const tr = t as Transcript
  if (!tr || tr.schema !== 'cc-bench-transcript/1') throw new Error('not a cc-bench-transcript/1 file')
  if (!Array.isArray(tr.rounds) || !tr.rounds.length) throw new Error('transcript has no rounds')
  if (expect && (tr.arm !== expect.arm || tr.task_id !== expect.task_id)) {
    throw new Error(`transcript is for ${tr.arm}/${tr.task_id}, expected ${expect.arm}/${expect.task_id}`)
  }
  if (tr.arm === 'baseline' && tr.rounds.some((r) => r.role === 'reviewer')) throw new Error('a baseline transcript cannot contain reviewer rounds')
  return tr
}

/** Replay a transcript onto `workdir` and return the arm outcome it records. */
export function replayTranscript(tr: Transcript, workdir: string): ArmOutcome {
  let tokens = emptyTokens()
  let cost = 0
  let wall = tr.overhead_ms ?? 0
  let reviews = 0
  let model = tr.model
  let workerError = false
  const notes: string[] = [`replayed ${tr.provenance} transcript (${tr.rounds.length} rounds)`]
  for (const round of tr.rounds) {
    if (round.role === 'reviewer') {
      const r = round as ReviewerRound
      reviews++
      cost += r.cost_usd
      wall += r.duration_ms
      tokens = addTokens(tokens, r.tokens ?? {})
      continue
    }
    const w = round as WorkerRound
    for (const warning of applyWorkerRound(w, workdir)) notes.push(`replay warning: ${warning}`)
    const res = resultOf(w.events)
    if (res) {
      cost += res.cost_usd
      wall += res.duration_ms
      tokens = addTokens(tokens, res.tokens)
      model = model ?? res.model
      workerError = workerError || res.is_error
    }
  }
  const status = tr.final_status ?? (workerError ? 'error' : 'completed')
  return {
    status,
    tokens,
    cost_usd: Math.round(cost * 1e6) / 1e6,
    wall_ms: tr.wall_ms ?? wall,
    review_iterations: reviews,
    human_interventions: tr.human_interventions?.length ?? 0,
    model,
    ...(tr.error ? { error: tr.error } : {}),
    notes,
  }
}

export function transcriptPath(dir: string, arm: Arm, taskId: string): string {
  return path.join(dir, arm, `${taskId}.json`)
}

export function loadTranscript(dir: string, arm: Arm, taskId: string): Transcript {
  const p = transcriptPath(dir, arm, taskId)
  if (!fs.existsSync(p)) throw new Error(`no recorded transcript for ${arm}/${taskId} at ${p}`)
  return validateTranscript(JSON.parse(fs.readFileSync(p, 'utf8')), { arm, task_id: taskId })
}

export function writeTranscript(dir: string, tr: Transcript): string {
  const p = transcriptPath(dir, tr.arm, tr.task_id)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(tr, null, 2) + '\n')
  return p
}
