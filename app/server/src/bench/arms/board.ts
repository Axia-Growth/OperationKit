/**
 * Board arm: the task goes through Command Center exactly like real work —
 * a card is filed and started over the Agent API, a worker session does the work
 * in a worktree of the bench fixture repo, and the board routes the result through
 * whatever review it would normally apply (AI review on yellow/red lanes).
 *
 * Inputs (all from the CLI / env, see docs/bench/README.md):
 *   - `baseUrl` + `apiKey` (a `cc_live_` key with board:read, board:write, board:start)
 *   - `workspace` + `project`: the project MUST be the throwaway bench repo created by
 *     `bench board-setup` (never a client repo) and registered on that workspace.
 *   - `benchRepo`: local path of that repo's checkout, where the worker's branch lands.
 *
 * Metrics come from the card itself: `total_cost_usd` / `total_tokens` (worker AND
 * reviewer sessions), `ai_review_iteration`, and the human-typed follow-ups in the
 * card thread. The work product is read from the card's branch (`cc/obj-<id>-*`) in
 * the bench repo, falling back to its worktree when nothing was committed.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { diffAgainstRepo, safeJoin } from '../scoring.js'
import { emptyTokens } from '../transcript.js'
import type { ArmOutcome, ReviewerRound, Transcript } from '../types.js'
import { failedOutcome, taskPrompt, type ArmContext, type ArmResult, type ArmRunner } from './common.js'

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface BoardOptions {
  baseUrl: string
  apiKey: string
  workspace: string
  project: string
  benchRepo: string
  pollMs?: number
  timeoutMs?: number
  /** After the card stops, wait until the recorded cost is stable this long (cost lands after extraction). */
  settleMs?: number
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Override how the work product is copied into the workdir (tests). */
  collect?: (cardId: number, ctx: ArmContext) => { source: string }
  /** Directory pattern of a card's worktree; `{id}` is replaced. */
  worktreePattern?: string
}

/** Statuses at which the worker and any reviewer have stopped. */
const STOPPED = new Set(['review', 'done', 'cancelled'])
const HUMAN_SENDERS = new Set(['owner', 'member'])

interface CardRow {
  id: number
  status: string
  total_cost_usd?: number | null
  total_tokens?: number | null
  ai_review_iteration?: number | null
  ai_review_verdict?: string | null
  model?: string | null
}

export function boardCardBody(ctx: ArmContext, opts: Pick<BoardOptions, 'workspace' | 'project'>): Record<string, unknown> {
  const dir = `tasks/${ctx.task.id}`
  return {
    title: `[bench ${ctx.runId}] ${ctx.task.id}: ${ctx.task.title}`,
    description: [
      taskPrompt(ctx.task, `\`${dir}/\` of this project`),
      '',
      `Edit only files inside \`${dir}/\`. Treat \`${dir}/\` as the repository root for every path above. Commit your change on your branch.`,
      `(Benchmark card, run ${ctx.runId}, seed ${ctx.seed}. Throwaway fixture repo — nothing here ships.)`,
    ].join('\n'),
    workspace: opts.workspace,
    project: opts.project,
    type: 'task',
    create_pr: true,
    ...(ctx.model ? { model: ctx.model } : {}),
    start: true,
    // Re-running a task must not be refused as a duplicate title.
    force: true,
  }
}

/** Count follow-ups a PERSON typed into the card thread (not bots, not the system). */
export function countHumanInterventions(output: unknown): number {
  const msgs = (output as { messages?: Array<{ type?: string; sender?: { kind?: string } }> })?.messages ?? []
  return msgs.filter((m) => m.type === 'followup' && HUMAN_SENDERS.has(String(m.sender?.kind))).length
}

/** Copy tasks/<id>/ from the card's branch (or its worktree) into the workdir. */
export function collectFromBenchRepo(benchRepo: string, cardId: number, ctx: ArmContext, worktreePattern = '/tmp/cc-worktree-{id}'): { source: string } {
  const sub = `tasks/${ctx.task.id}`
  const git = (...args: string[]) => execFileSync('git', ['-C', benchRepo, ...args], { encoding: 'utf8' })
  const branch = git('for-each-ref', '--format=%(refname:short)', `refs/heads/cc/obj-${cardId}-*`).trim().split('\n').filter(Boolean)[0]
  const worktree = path.join(worktreePattern.replace('{id}', String(cardId)), sub)
  const reset = () => {
    for (const e of fs.readdirSync(ctx.workdir)) fs.rmSync(path.join(ctx.workdir, e), { recursive: true, force: true })
  }
  // Prefer an uncommitted worktree when it exists (it is a superset of the branch).
  if (fs.existsSync(worktree)) {
    reset()
    fs.cpSync(worktree, ctx.workdir, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') })
    return { source: `worktree ${worktree}` }
  }
  if (!branch) throw new Error(`no branch cc/obj-${cardId}-* in ${benchRepo} and no worktree at ${worktree}`)
  const files = git('ls-tree', '-r', '--name-only', branch, '--', sub).split('\n').filter(Boolean)
  if (!files.length) throw new Error(`branch ${branch} has no ${sub}/`)
  reset()
  for (const f of files) {
    const dst = safeJoin(ctx.workdir, path.relative(sub, f))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, execFileSync('git', ['-C', benchRepo, 'show', `${branch}:${f}`]))
  }
  return { source: `branch ${branch}` }
}

export function boardArm(opts: BoardOptions): ArmRunner {
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? (() => Date.now())
  const pollMs = opts.pollMs ?? 15_000
  const timeoutMs = opts.timeoutMs ?? 90 * 60_000
  const settleMs = opts.settleMs ?? 60_000
  const base = opts.baseUrl.replace(/\/$/, '')

  async function apiRaw(method: string, p: string, body?: unknown): Promise<{ ok: boolean; status: number; text: string; json: unknown }> {
    const res = await doFetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${opts.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: unknown = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = {} }
    return { ok: res.ok, status: res.status, text, json }
  }

  async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
    const r = await apiRaw(method, p, body)
    if (!r.ok) throw new Error(`${method} ${p} -> HTTP ${r.status}: ${r.text.slice(0, 300)}`)
    return r.json as T
  }

  return {
    arm: 'board',
    async run(ctx: ArmContext): Promise<ArmResult> {
      const t0 = now()
      const notes: string[] = []
      const cancelCard = async (cardId: number, why: string) => {
        notes.push(why)
        try { await api('PATCH', `/api/objectives/${cardId}/status`, { status: 'cancelled' }) } catch (e) { notes.push(`cancel failed: ${(e as Error).message}`) }
      }
      type Created = CardRow & { start?: { started?: boolean; reason?: string }; objective?: CardRow }
      let created: { ok: boolean; status: number; text: string; json: unknown }
      try {
        created = await apiRaw('POST', '/api/objectives', boardCardBody(ctx, opts))
      } catch (e) {
        return { outcome: failedOutcome(`could not file the card: ${(e as Error).message}`, now() - t0, ctx.model) }
      }
      const body = created.json as Created
      // A refused start (409 session_cap / lease_conflict) still CREATES the card, and a
      // session-cap card may auto-start later and spend outside the budget. Cancel it.
      const id = Number(body?.id ?? body?.objective?.id)
      if (!created.ok || body?.start?.started === false) {
        const why = body?.start?.reason ?? `HTTP ${created.status}: ${created.text.slice(0, 200)}`
        if (Number.isInteger(id) && id > 0) await cancelCard(id, `card #${id} was filed but not started (${why}); cancelled it`)
        return { outcome: failedOutcome(Number.isInteger(id) && id > 0 ? `card #${id} was filed but not started: ${why}` : `could not file the card: ${why}`, now() - t0, ctx.model, { notes }) }
      }
      let card: CardRow = body
      notes.push(`card #${id}`)

      let status: ArmOutcome['status'] = 'completed'
      let error: string | undefined
      const cancel = (why: string) => cancelCard(id, why)

      // Poll until the worker and any reviewer have stopped.
      for (;;) {
        await sleep(pollMs)
        try {
          card = await api<CardRow>('GET', `/api/objectives/${id}`)
        } catch (e) {
          notes.push(`poll error: ${(e as Error).message}`)
          if (now() - t0 > timeoutMs) {
            status = 'timeout'
            error = 'timed out while the board was unreachable'
            await cancel('timeout while unreachable; tried to cancel the card')
            break
          }
          continue
        }
        const cost = Number(card.total_cost_usd ?? 0)
        if (ctx.capUsd !== null && cost > ctx.capUsd) {
          await cancel(`budget: card cost $${cost.toFixed(2)} crossed the per-run cap $${ctx.capUsd.toFixed(2)}`)
          status = 'error'
          error = 'stopped at the run budget cap'
          break
        }
        if (now() - t0 > timeoutMs) {
          await cancel(`timeout after ${timeoutMs}ms`)
          status = 'timeout'
          error = `timed out after ${timeoutMs}ms`
          break
        }
        if (STOPPED.has(card.status)) break
      }
      const wall = now() - t0

      // Cost is written by session-intel extraction AFTER a session ends, so it can
      // still read 0 (or the worker-only figure) when the card stops. Wait until it is
      // non-zero and unchanged across two polls, or settleMs runs out.
      let lastCost = Number(card.total_cost_usd ?? 0)
      for (let waited = 0; waited < settleMs; waited += pollMs) {
        await sleep(pollMs)
        try { card = await api<CardRow>('GET', `/api/objectives/${id}`) } catch { break }
        const c = Number(card.total_cost_usd ?? 0)
        if (c > 0 && c === lastCost) break
        lastCost = c
      }
      const costUnknown = !(Number(card.total_cost_usd ?? 0) > 0)
      if (costUnknown) notes.push('card cost never landed; the budget is charged the full per-run cap')

      let human = 0
      try {
        human = countHumanInterventions(await api('GET', `/api/objectives/${id}/output`))
      } catch (e) {
        notes.push(`could not read the card thread: ${(e as Error).message}`)
      }
      if (card.status === 'cancelled' && status === 'completed') {
        status = 'error'
        error = 'card was cancelled'
      }
      if (status === 'completed') {
        try {
          const { source } = (opts.collect ?? ((cid, c) => collectFromBenchRepo(opts.benchRepo, cid, c, opts.worktreePattern)))(id, ctx)
          notes.push(`work read from ${source}`)
        } catch (e) {
          notes.push(`collect failed: ${(e as Error).message}`)
        }
      }
      const iterations = Number(card.ai_review_iteration ?? 0)
      const tokens = emptyTokens()
      // The card records one combined token count; the split is not stored per card.
      tokens.total = Number(card.total_tokens ?? 0)
      notes.push(`final status ${card.status}${card.ai_review_verdict ? `, review verdict ${card.ai_review_verdict}` : ''}`)

      const outcome: ArmOutcome = {
        status,
        tokens,
        cost_usd: Number(card.total_cost_usd ?? 0),
        wall_ms: wall,
        review_iterations: iterations,
        human_interventions: human,
        model: card.model ?? ctx.model,
        ...(costUnknown ? { cost_unknown: true } : {}),
        ...(error ? { error } : {}),
        notes,
      }
      // A board run is recorded as summary rounds so it can be replayed in mock mode.
      const reviewRounds: ReviewerRound[] = Array.from({ length: iterations }, () => ({ role: 'reviewer', verdict: 'fail', cost_usd: 0, duration_ms: 0 }))
      if (reviewRounds.length && card.ai_review_verdict === 'pass') reviewRounds[reviewRounds.length - 1].verdict = 'pass'
      const transcript: Transcript = {
        schema: 'cc-bench-transcript/1',
        arm: 'board',
        task_id: ctx.task.id,
        provenance: 'live',
        model: outcome.model,
        recorded_at: new Date().toISOString(),
        wall_ms: wall,
        rounds: [
          {
            role: 'worker',
            files: diffAgainstRepo(ctx.task, ctx.workdir),
            events: [{ type: 'result', subtype: 'success', total_cost_usd: outcome.cost_usd, duration_ms: 0, usage: { input_tokens: tokens.total }, is_error: status !== 'completed', note: `board card #${id}; cost and tokens are card totals (worker + reviewer)` }],
          },
          ...reviewRounds,
        ],
        human_interventions: Array.from({ length: human }, () => ({ after_round: 0, kind: 'human_followup' })),
        final_status: status,
        ...(error ? { error } : {}),
      }
      return { outcome, transcript }
    },
  }
}
