/**
 * Baseline arm: ONE plain Claude Code session (`claude -p`), same model, in a temp
 * copy of the task repo. No board, no worktree, no reviewer, no CLAUDE.md, no MCP
 * servers, no user-level settings or hooks.
 */
import { spawn } from 'node:child_process'
import { diffAgainstRepo } from '../scoring.js'
import { resultOf } from '../transcript.js'
import type { StreamEvent, Transcript } from '../types.js'
import { failedOutcome, taskPrompt, type ArmContext, type ArmResult, type ArmRunner } from './common.js'

export interface BaselineOptions {
  claudeBin?: string
  timeoutMs?: number
  /** Extra args appended verbatim (e.g. for a different permission mode). */
  extraArgs?: string[]
  /** After SIGTERM on timeout, wait this long before SIGKILL. Default 10s. */
  killGraceMs?: number
  /** Passed to --setting-sources. Default 'project,local' (the temp workdir has none). */
  settingSources?: string
}

/** Text the CLI prints when it has no credential. Not a task failure: the run is invalid. */
const AUTH_FAILURE_RE = /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired/i

/** The keys of the stream-json init event worth keeping; the rest describe the operator's machine. */
const INIT_KEEP = ['type', 'subtype', 'model', 'cwd', 'claude_code_version', 'permissionMode', 'apiKeySource', 'tools']

/** Strip machine-specific detail (plugins, socket paths, memory paths) from a recorded event. */
export function sanitizeEvent(e: StreamEvent): StreamEvent {
  if (e.type !== 'system' || e.subtype !== 'init') return e
  return Object.fromEntries(Object.entries(e).filter(([k]) => INIT_KEEP.includes(k))) as StreamEvent
}

/** The final assistant text, used to recognise an authentication failure. */
function finalText(events: StreamEvent[]): string {
  const r = [...events].reverse().find((e) => e.type === 'result')
  return typeof r?.result === 'string' ? r.result : ''
}

/** Env for the child: everything the CLI needs to authenticate, minus board identity. */
export function baselineEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    // A board session's identity must not leak into the "no board" arm.
    if (k.startsWith('CC_') || k === 'OBJECTIVE_ID' || k === 'INTERNAL_API_SECRET') continue
    out[k] = v
  }
  return out
}

export function baselineArgs(ctx: ArmContext, extra: string[] = [], settingSources = 'project,local'): string[] {
  const args = [
    '-p', taskPrompt(ctx.task),
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--strict-mcp-config',
    // Only project/local settings — the temp workdir has none — so the operator's
    // user-level hooks, plugins and permissions do not shape the baseline.
    '--setting-sources', settingSources,
  ]
  if (ctx.model) args.push('--model', ctx.model)
  // Round DOWN to the cent so the cap never exceeds what the budget has left.
  if (ctx.capUsd !== null) args.push('--max-budget-usd', (Math.floor(ctx.capUsd * 100) / 100).toFixed(2))
  return [...args, ...extra]
}

export function baselineArm(opts: BaselineOptions = {}): ArmRunner {
  const bin = opts.claudeBin ?? 'claude'
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000
  return {
    arm: 'baseline',
    run(ctx: ArmContext): Promise<ArmResult> {
      const t0 = Date.now()
      return new Promise((resolve) => {
        // A .js/.cjs/.mjs stand-in (tests, wrappers) runs through node, so it needs no exec bit.
        const viaNode = /\.[cm]?js$/.test(bin)
        const argv = baselineArgs(ctx, opts.extraArgs, opts.settingSources)
        const child = spawn(viaNode ? process.execPath : bin, viaNode ? [bin, ...argv] : argv, { cwd: ctx.workdir, env: baselineEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
        const events: StreamEvent[] = []
        let buf = ''
        let stderr = ''
        let timedOut = false
        let killTimer: NodeJS.Timeout | undefined
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          // Escalate, and stop waiting for "close" if a child still holds the pipe.
          killTimer = setTimeout(() => {
            child.kill('SIGKILL')
            setTimeout(() => finish(), 5_000).unref()
          }, opts.killGraceMs ?? 10_000)
          killTimer.unref()
        }, timeoutMs)
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString()
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            if (!line) continue
            try { events.push(JSON.parse(line)) } catch { /* non-JSON noise */ }
          }
        })
        child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000) })
        let settled = false
        const finish = (spawnError?: string) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          const wall = Date.now() - t0
          const res = resultOf(events)
          const files = diffAgainstRepo(ctx.task, ctx.workdir)
          const transcript: Transcript = {
            schema: 'cc-bench-transcript/1',
            arm: 'baseline',
            task_id: ctx.task.id,
            provenance: 'live',
            model: res?.model ?? ctx.model,
            recorded_at: new Date().toISOString(),
            rounds: [{ role: 'worker', cwd: ctx.workdir, events: events.map(sanitizeEvent), files }],
            // The measured process wall time, so a replay reports exactly what was measured.
            wall_ms: wall,
          }
          if (spawnError || !res) {
            const error = spawnError ?? (timedOut ? `timed out after ${timeoutMs}ms` : `no result event (exit; stderr: ${stderr.trim().slice(-300)})`)
            transcript.final_status = timedOut ? 'timeout' : 'error'
            transcript.error = error
            // A session that started but never reported may have spent up to its cap.
            const costUnknown = !spawnError && events.length > 0
            resolve({ outcome: failedOutcome(error, wall, ctx.model, { status: transcript.final_status, notes: [`${events.length} stream events`], ...(costUnknown ? { cost_unknown: true } : {}) }), transcript })
            return
          }
          const authFailed = res.is_error && AUTH_FAILURE_RE.test(`${finalText(events)} ${stderr}`)
          if (authFailed) {
            transcript.final_status = 'error'
            transcript.error = 'claude CLI is not authenticated'
          }
          resolve({
            outcome: {
              status: timedOut ? 'timeout' : res.is_error ? 'error' : 'completed',
              tokens: res.tokens,
              cost_usd: res.cost_usd,
              wall_ms: wall,
              review_iterations: 0,
              human_interventions: 0,
              model: res.model ?? ctx.model,
              ...(res.is_error ? { error: authFailed ? 'claude CLI is not authenticated' : 'session ended with is_error' } : {}),
              ...(authFailed ? { fatal: 'the claude CLI is not authenticated in this environment (it answered "Not logged in"); log in or set ANTHROPIC_API_KEY, then re-run' } : {}),
              notes: [`${events.length} stream events`, `session duration ${res.duration_ms}ms`],
            },
            transcript,
          })
        }
        child.on('error', (e) => finish(`could not start ${bin}: ${e.message}`))
        child.on('close', () => finish())
      })
    },
  }
}
