/**
 * The three arm adapters (obj 900908), with no model call and no live board:
 *   - transcript replay (Write / Edit / MultiEdit / files snapshot, metrics);
 *   - baseline arm against a fake `claude` binary that speaks stream-json;
 *   - board arm against a fake Agent API, including the per-run budget cancel;
 *   - board-setup + reading the worker's branch out of the bench repo.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { baselineArgs, baselineArm, baselineEnv, sanitizeEvent } from './arms/baseline.js'
import { boardArm, boardCardBody, collectFromBenchRepo, countHumanInterventions, type FetchLike } from './arms/board.js'
import type { ArmContext } from './arms/common.js'
import { BENCH_REPO_MARKER, boardSetup } from './cli.js'
import { runBench } from './runner.js'
import { BudgetGuard } from './budget.js'
import { prepareWorkdir, scoreWorkdir } from './scoring.js'
import { loadTaskSet } from './tasks.js'
import { applyWorkerRound, replayTranscript, resultOf, validateTranscript } from './transcript.js'
import type { Transcript } from './types.js'

const set = loadTaskSet()
const task = (id: string) => set.tasks.find((t) => t.id === id)!
const tmp: string[] = []
const mk = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmp.push(d)
  return d
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const ctxFor = (id: string, over: Partial<ArmContext> = {}): ArmContext => {
  const workdir = prepareWorkdir(task(id))
  tmp.push(workdir)
  return { task: task(id), workdir, runId: 'test', seed: 1, model: 'claude-test', capUsd: 2, ...over }
}

describe('transcript replay', () => {
  it('applies Write, Edit and MultiEdit calls rebased from the recorded cwd', () => {
    const d = mk('replay-')
    fs.mkdirSync(path.join(d, 'src'))
    fs.writeFileSync(path.join(d, 'src', 'a.js'), 'let x = 1\nlet y = 1\n')
    const warnings = applyWorkerRound({
      role: 'worker',
      cwd: '/rec',
      events: [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/rec/src/b.js', content: 'B' } }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/rec/src/a.js', old_string: 'x = 1', new_string: 'x = 2' } }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'MultiEdit', input: { file_path: 'src/a.js', edits: [{ old_string: '1', new_string: '3', replace_all: true }, { old_string: 'zzz', new_string: '' }] } }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }] } },
      ],
    }, d)
    expect(fs.readFileSync(path.join(d, 'src', 'b.js'), 'utf8')).toBe('B')
    expect(fs.readFileSync(path.join(d, 'src', 'a.js'), 'utf8')).toBe('let x = 2\nlet y = 3\n')
    expect(warnings).toEqual(['MultiEdit: old_string not found in src/a.js'])
  })

  it('a files snapshot is authoritative and can delete files', () => {
    const d = mk('replay-')
    fs.writeFileSync(path.join(d, 'gone.js'), 'x')
    applyWorkerRound({ role: 'worker', events: [], files: { 'gone.js': null, 'dir/new.js': 'N' } }, d)
    expect(fs.existsSync(path.join(d, 'gone.js'))).toBe(false)
    expect(fs.readFileSync(path.join(d, 'dir', 'new.js'), 'utf8')).toBe('N')
  })

  it('refuses a transcript that writes outside the workdir', () => {
    const d = mk('replay-')
    expect(() => applyWorkerRound({ role: 'worker', cwd: '/rec', events: [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/etc/x', content: '' } }] } }] }, d)).toThrow(/escapes/)
  })

  it('sums worker and reviewer cost, tokens, wall time and counts reviews / human interventions', () => {
    const tr: Transcript = {
      schema: 'cc-bench-transcript/1', arm: 'board', task_id: 't', provenance: 'synthetic', model: null, recorded_at: '', overhead_ms: 1000,
      rounds: [
        { role: 'worker', events: [{ type: 'system', subtype: 'init', model: 'mx' }, { type: 'result', total_cost_usd: 0.5, duration_ms: 2000, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } }] },
        { role: 'reviewer', verdict: 'fail', cost_usd: 0.25, duration_ms: 3000, tokens: { input: 1, output: 2 } },
        { role: 'worker', events: [{ type: 'result', total_cost_usd: 0.1, duration_ms: 500, usage: { input_tokens: 1 } }] },
        { role: 'reviewer', verdict: 'pass', cost_usd: 0.05, duration_ms: 100 },
      ],
      human_interventions: [{ after_round: 1, kind: 'owner_message' }],
    }
    const o = replayTranscript(tr, mk('replay-'))
    expect(o).toMatchObject({ status: 'completed', cost_usd: 0.9, wall_ms: 6600, review_iterations: 2, human_interventions: 1, model: 'mx' })
    expect(o.tokens).toEqual({ input: 12, output: 7, cache_read: 100, cache_creation: 20, total: 139 })
  })

  it('validates schema, arm/task match, and no reviewer rounds on the baseline', () => {
    expect(() => validateTranscript({ schema: 'x' })).toThrow(/cc-bench-transcript/)
    const ok = { schema: 'cc-bench-transcript/1', arm: 'baseline', task_id: 'a', rounds: [{ role: 'worker', events: [] }] }
    expect(() => validateTranscript(ok, { arm: 'board', task_id: 'a' })).toThrow(/expected board\/a/)
    expect(() => validateTranscript({ ...ok, rounds: [...ok.rounds, { role: 'reviewer' }] })).toThrow(/baseline transcript cannot contain reviewer/)
    expect(resultOf([])).toBeNull()
  })
})

describe('baseline arm', () => {
  it('builds a plain, capped, same-model claude invocation', () => {
    const args = baselineArgs(ctxFor('t01-sum-range', { capUsd: 1.234 }))
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--strict-mcp-config', '--no-session-persistence']))
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'claude-test'])
    expect(args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2)).toEqual(['--max-budget-usd', '1.23'])
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'project,local'])
    const withUser = baselineArgs(ctxFor('t01-sum-range'), [], 'user,project,local')
    expect(withUser[withUser.indexOf('--setting-sources') + 1]).toBe('user,project,local')
    expect(args[1]).toContain(task('t01-sum-range').prompt)
  })

  it('strips board identity from the child env', () => {
    const env = baselineEnv({ PATH: '/bin', CC_SESSION_TOKEN: 's', CC_OBJECTIVE_ID: '1', INTERNAL_API_SECRET: 'x', ANTHROPIC_API_KEY: 'k' })
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'k' })
  })

  it('runs a (fake) claude binary, parses stream-json, and records a replayable transcript', async () => {
    const bin = path.join(mk('fake-claude-'), 'claude.cjs')
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.writeFileSync('args.json', JSON.stringify(args))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', model: 'claude-fake-1' })
fs.writeFileSync('src/range.js', fs.readFileSync('src/range.js', 'utf8').replace('i < to', 'i <= to'))
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sed -i ...' } }] } })
out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, total_cost_usd: 0.0421, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } })
`)
    const ctx = ctxFor('t01-sum-range')
    const { outcome, transcript } = await baselineArm({ claudeBin: bin }).run(ctx)
    expect(outcome.error).toBeUndefined()
    expect(outcome).toMatchObject({ status: 'completed', cost_usd: 0.0421, review_iterations: 0, human_interventions: 0, model: 'claude-fake-1' })
    expect(outcome.tokens.total).toBe(1160)
    fs.rmSync(path.join(ctx.workdir, 'args.json'))
    expect(scoreWorkdir(ctx.task, ctx.workdir).success).toBe(true)

    // The recorded transcript replays to the same work and the same numbers.
    expect(transcript!.rounds[0]).toMatchObject({ role: 'worker', files: { 'src/range.js': expect.stringContaining('i <= to') } })
    const again = ctxFor('t01-sum-range')
    const replayed = replayTranscript(transcript!, again.workdir)
    expect(replayed.cost_usd).toBe(0.0421)
    expect(replayed.wall_ms).toBe(outcome.wall_ms)
    expect(scoreWorkdir(again.task, again.workdir).success).toBe(true)
  })

  it('treats "Not logged in" as a broken environment and stops the whole run', async () => {
    const bin = path.join(mk('fake-claude-'), 'claude.cjs')
    fs.writeFileSync(bin, `const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
out({ type: "system", subtype: "init", model: "m", messaging_socket_path: "/private/sock", plugins: ["x"] })
out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", total_cost_usd: 0, duration_ms: 5, usage: {} })
`)
    const { outcome, transcript } = await baselineArm({ claudeBin: bin }).run(ctxFor('t01-sum-range'))
    expect(outcome.status).toBe('error')
    expect(outcome.fatal).toMatch(/not authenticated/)
    // machine detail is not recorded
    expect(transcript!.rounds[0]).toMatchObject({ events: [{ type: 'system', subtype: 'init', model: 'm' }, expect.anything()] })
    expect(JSON.stringify(transcript)).not.toContain('/private/sock')

    const result = await runBench({ mode: 'live', taskSet: set, tasks: set.tasks, runners: [baselineArm({ claudeBin: bin })], seed: 3, model: 'm', budget: new BudgetGuard(5) })
    expect(result.runs).toHaveLength(1)
    expect(result.stopped?.reason).toMatch(/^environment: the claude CLI is not authenticated/)
  })

  it('sanitizeEvent keeps only the portable init keys and leaves other events alone', () => {
    expect(sanitizeEvent({ type: 'system', subtype: 'init', model: 'm', memory_paths: ['/home/x'] })).toEqual({ type: 'system', subtype: 'init', model: 'm' })
    const ev = { type: 'assistant', message: { content: [] } }
    expect(sanitizeEvent(ev)).toBe(ev)
  })

  it('kills a session that ignores SIGTERM and charges the budget its cap (cost unknown)', async () => {
    const bin = path.join(mk('fake-claude-'), 'claude.cjs')
    fs.writeFileSync(bin, `process.on("SIGTERM", () => {})
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: "m" }) + "\\n")
setInterval(() => {}, 1000)
`)
    const t0 = Date.now()
    const { outcome } = await baselineArm({ claudeBin: bin, timeoutMs: 300, killGraceMs: 200 }).run(ctxFor('t01-sum-range'))
    expect(Date.now() - t0).toBeLessThan(8_000)
    expect(outcome).toMatchObject({ status: 'timeout', cost_usd: 0, cost_unknown: true })
  })

  it('rounds the CLI cap down to the cent', () => {
    const args = baselineArgs(ctxFor('t01-sum-range', { capUsd: 0.019 }))
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.01')
  })

  it('reports a missing binary as an error run, not a crash', async () => {
    const { outcome } = await baselineArm({ claudeBin: '/nonexistent/claude-bin' }).run(ctxFor('t01-sum-range'))
    expect(outcome.status).toBe('error')
    expect(outcome.error).toMatch(/could not start|no result event/)
  })
})

interface FakeCard { id: number; status: string; total_cost_usd: number; total_tokens: number; ai_review_iteration: number; ai_review_verdict: string | null; model: string }

function fakeBoard(script: Array<Partial<FakeCard>>, thread: unknown = { messages: [] }) {
  const calls: Array<{ method: string; url: string; body?: unknown; auth?: string }> = []
  let card: FakeCard = { id: 4242, status: 'working', total_cost_usd: 0, total_tokens: 0, ai_review_iteration: 0, ai_review_verdict: null, model: 'claude-test' }
  let step = 0
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.Authorization })
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })
    if (method === 'POST' && url.endsWith('/api/objectives')) return reply(201, { ...card, start: { started: true } })
    if (method === 'PATCH' && url.endsWith('/status')) { card = { ...card, status: 'cancelled' }; return reply(200, card) }
    if (url.endsWith('/output')) return reply(200, thread)
    if (method === 'GET') {
      if (card.status !== 'cancelled' && step < script.length) card = { ...card, ...script[step++] }
      return reply(200, card)
    }
    return reply(404, {})
  }
  return { fetch, calls }
}

const boardOpts = { baseUrl: 'http://board.test/', apiKey: 'cc_live_test', workspace: 'bench-ws', project: 'cc-bench-fixture', benchRepo: '/nope', pollMs: 1, settleMs: 3, sleep: async () => {} }

describe('board arm', () => {
  it('files and starts a review-routed card in the bench project with the shared prompt', () => {
    const body = boardCardBody(ctxFor('t02-slugify'), boardOpts)
    expect(body).toMatchObject({ workspace: 'bench-ws', project: 'cc-bench-fixture', type: 'task', create_pr: true, start: true, force: true, model: 'claude-test' })
    expect(String(body.description)).toContain(task('t02-slugify').prompt)
    expect(String(body.description)).toContain('tasks/t02-slugify/')
  })

  it('counts only follow-ups a person typed', () => {
    expect(countHumanInterventions({ messages: [
      { type: 'followup', sender: { kind: 'owner' } },
      { type: 'followup', sender: { kind: 'member' } },
      { type: 'followup', sender: { kind: 'agent' } },
      { type: 'followup', sender: { kind: 'system' } },
      { type: 'assistant' },
    ] })).toBe(2)
    expect(countHumanInterventions(null)).toBe(0)
  })

  it('follows the card through review to a stop and reads the card totals', async () => {
    const { fetch, calls } = fakeBoard(
      [
        { status: 'working', total_cost_usd: 0.4 },
        { status: 'ai_review', total_cost_usd: 0.9, ai_review_iteration: 1 },
        { status: 'working', total_cost_usd: 1.0, ai_review_verdict: 'fail' },
        { status: 'ai_review', total_cost_usd: 1.3, ai_review_iteration: 2 },
        { status: 'review', total_cost_usd: 1.5, total_tokens: 900_000, ai_review_verdict: 'pass' },
        { total_cost_usd: 1.6 }, // reviewer cost lands after the stop
      ],
      { messages: [{ type: 'followup', sender: { kind: 'owner' } }] },
    )
    let collected = 0
    const ctx = ctxFor('t01-sum-range', { capUsd: 3 })
    const arm = boardArm({ ...boardOpts, fetch, collect: (id, c) => {
      collected = id
      fs.cpSync(path.join(c.task.dir, 'solution'), c.workdir, { recursive: true })
      return { source: 'test' }
    } })
    const { outcome, transcript } = await arm.run(ctx)
    expect(collected).toBe(4242)
    expect(outcome).toMatchObject({ status: 'completed', cost_usd: 1.6, review_iterations: 2, human_interventions: 1 })
    expect(outcome.tokens.total).toBe(900_000)
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://board.test/api/objectives', auth: 'Bearer cc_live_test' })
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect(scoreWorkdir(ctx.task, ctx.workdir).success).toBe(true)
    // Recorded for replay: two reviewer rounds, the last one the pass.
    expect(transcript!.rounds.filter((r) => r.role === 'reviewer').map((r) => (r as { verdict: string }).verdict)).toEqual(['fail', 'pass'])
  })

  it('cancels the card when its cost crosses the per-run cap', async () => {
    const { fetch, calls } = fakeBoard([{ status: 'working', total_cost_usd: 0.5 }, { status: 'working', total_cost_usd: 2.5 }])
    const { outcome } = await boardArm({ ...boardOpts, fetch, collect: () => { throw new Error('must not collect') } }).run(ctxFor('t01-sum-range', { capUsd: 2 }))
    expect(outcome.status).toBe('error')
    expect(outcome.error).toMatch(/budget cap/)
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([expect.objectContaining({ url: 'http://board.test/api/objectives/4242/status', body: { status: 'cancelled' } })])
  })

  it('cancels a card the board created but refused to start (409 session_cap)', async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body })
      if (init?.method === 'POST') return { ok: false, status: 409, text: async () => JSON.stringify({ error: 'cap', objective: { id: 31 }, start: { started: false, reason: 'session_cap', auto_start: true } }) }
      return { ok: true, status: 200, text: async () => '{}' }
    }
    const { outcome } = await boardArm({ ...boardOpts, fetch }).run(ctxFor('t01-sum-range'))
    expect(outcome.error).toMatch(/card #31 was filed but not started: session_cap/)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST http://board.test/api/objectives', 'PATCH http://board.test/api/objectives/31/status'])
  })

  it('waits for the card cost to land after the stop, and flags a cost that never lands', async () => {
    const late = fakeBoard([{ status: 'review', total_cost_usd: 0 }, { total_cost_usd: 0 }, { total_cost_usd: 1.2 }, { total_cost_usd: 1.2 }])
    const a = await boardArm({ ...boardOpts, settleMs: 10, fetch: late.fetch, collect: () => ({ source: 't' }) }).run(ctxFor('t01-sum-range'))
    expect(a.outcome.cost_usd).toBe(1.2)
    expect(a.outcome.cost_unknown).toBeUndefined()

    const never = fakeBoard([{ status: 'review', total_cost_usd: 0 }])
    const b = await boardArm({ ...boardOpts, settleMs: 3, fetch: never.fetch, collect: () => ({ source: 't' }) }).run(ctxFor('t01-sum-range'))
    expect(b.outcome).toMatchObject({ cost_usd: 0, cost_unknown: true })
  })

  it('reports a refused start (session cap) without polling', async () => {
    const fetch: FetchLike = async () => ({ ok: true, status: 201, text: async () => JSON.stringify({ id: 9, status: 'queue', start: { started: false, reason: 'session_cap' } }) })
    const { outcome } = await boardArm({ ...boardOpts, fetch }).run(ctxFor('t01-sum-range'))
    expect(outcome).toMatchObject({ status: 'error' })
    expect(outcome.error).toMatch(/not started: session_cap/)
  })
})

describe('board-setup + collecting the worker branch', () => {
  const git = (repo: string, ...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })

  it('creates the fixture repo, refuses a non-bench directory, and reads tasks/<id>/ from cc/obj-<id>-*', () => {
    const repo = path.join(mk('bench-repo-'), 'cc-bench-fixture')
    boardSetup(repo, set.root)
    expect(fs.readFileSync(path.join(repo, BENCH_REPO_MARKER), 'utf8')).toContain(set.hash)
    for (const t of set.tasks) expect(fs.existsSync(path.join(repo, 'tasks', t.id, 'package.json'))).toBe(true)
    // idempotent
    boardSetup(repo, set.root)
    expect(git(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('1')

    const other = mk('not-bench-')
    fs.writeFileSync(path.join(other, 'precious.txt'), 'x')
    expect(() => boardSetup(other, set.root)).toThrow(/refusing to touch it/)

    // A worker branch with a fix, as a board worktree would leave it.
    git(repo, 'checkout', '-q', '-b', 'cc/obj-77-bench-t01')
    const f = path.join(repo, 'tasks', 't01-sum-range', 'src', 'range.js')
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('i < to', 'i <= to'))
    git(repo, 'commit', '-qam', 'fix')
    git(repo, 'checkout', '-q', 'main')

    const ctx = ctxFor('t01-sum-range')
    const { source } = collectFromBenchRepo(repo, 77, ctx, path.join(mk('no-wt-'), 'cc-worktree-{id}'))
    expect(source).toBe('branch cc/obj-77-bench-t01')
    expect(scoreWorkdir(ctx.task, ctx.workdir).success).toBe(true)
    expect(() => collectFromBenchRepo(repo, 78, ctxFor('t01-sum-range'), '/nonexistent/{id}')).toThrow(/no branch cc\/obj-78/)
  })
})
