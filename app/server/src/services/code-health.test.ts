// Code-health Job (obj 901770): the managed routine per linked repo, the fire
// guard, the always-review routing, and the lightweight-only auto-merge gate.
//
// DB_PATH → temp sqlite; PORT → dead port and fetch is stubbed so a fire's
// card-spawn PATCH never reaches a live Command Center.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RoutineRow } from './routine-scheduler.js'

const TMP_DB = path.join(os.tmpdir(), `cc-code-health-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59947'
process.env.ALERTS_ENABLED = 'false'

const { initDb, getDb } = await import('../db/index.js')
const ch = await import('./code-health.js')
const { fireRoutine } = await import('./routine-scheduler.js')
const { classifyAiFireResult } = await import('./routine-auto-pause.js')
const { decideAutoMerge } = await import('./auto-merge.js')
const { decideWorkerEndRoute } = await import('./poller-decisions.js')
const { isMoneyPath } = await import('./merge-lane.js')
const { createWorkspaceRepo, getWorkspaceRepo } = await import('./workspace-repos.js')

const ADMIN = { userId: 1, label: 'user:tester' }

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP_DB + s)) fs.unlinkSync(TMP_DB + s)
})

beforeEach(() => {
  const db = getDb()
  db.exec("DELETE FROM code_health_jobs; DELETE FROM workspace_repos; DELETE FROM routines WHERE name LIKE 'code-health:%'")
  db.exec("DELETE FROM settings WHERE key LIKE 'code_health_%'")
})

function ws(): string {
  const row = getDb().prepare('SELECT slug FROM workspaces ORDER BY slug LIMIT 1').get() as { slug: string } | undefined
  if (row) return row.slug
  getDb().prepare("INSERT INTO workspaces (slug, name) VALUES ('acme', 'Acme')").run()
  return 'acme'
}

function repo(github: string | null = 'acme/widget') {
  return createWorkspaceRepo({ workspace: ws(), name: 'widget', github, stack: [] })
}

const routineOf = (id: number | null) => getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow

describe('default is off — no surprise runs', () => {
  it('a fresh install has no code-health routine and a linked repo reports off', () => {
    const r = repo()
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM routines WHERE name LIKE 'code-health:%'").get()).toEqual({ n: 0 })
    const st = ch.codeHealthStatus(r)
    expect(st.enabled).toBe(false)
    expect(st.routine_id).toBeNull()
    expect(st.next_run_at).toBeNull()
    expect(st.cadence).toBe('weekly')
  })

  it('the boot resync creates nothing when no job was ever switched on', () => {
    repo()
    expect(ch.resyncCodeHealthRoutines()).toEqual({ synced: 0, disabled: 0 })
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM routines WHERE name LIKE 'code-health:%'").get()).toEqual({ n: 0 })
  })
})

describe('switching it on and off', () => {
  it('on → one enabled AI routine with a PR-only task brief; off → disabled, kept', () => {
    const r = repo()
    const on = ch.setCodeHealthJob(r, { enabled: true }, ADMIN)
    expect(on.ok).toBe(true)
    if (!on.ok) return
    expect(on.status.enabled).toBe(true)
    expect(on.status.next_run_at).not.toBeNull()
    const rt = routineOf(on.status.routine_id)
    expect(rt.name).toBe(`code-health:${r.id}`)
    expect(rt.enabled).toBe(1)
    expect(rt.kind).toBe('ai')
    expect(rt.max_queue_depth).toBe(1)
    expect(rt.cron_expr).toBe(ch.codeHealthCron(r.id, 'weekly'))
    const tpl = JSON.parse(rt.objective_template)
    expect(tpl).toMatchObject({ type: 'task', create_pr: true, project: 'widget', workspace: r.workspace, assigned_user_id: 1 })
    expect(tpl.title).toBe('Code health — widget')
    expect(tpl.description).toContain('acme/widget')
    expect(tpl.description).toContain('do not merge, do not deploy')
    // The brief must not trip the money-path gate, or auto-merge could never fire.
    expect(isMoneyPath(tpl)).toBe(false)

    const off = ch.setCodeHealthJob(r, { enabled: false }, ADMIN)
    expect(off.ok && off.status.enabled).toBe(false)
    expect(routineOf(rt.id).enabled).toBe(0)
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM routines WHERE name LIKE 'code-health:%'").get()).toEqual({ n: 1 })
  })

  it('daily cadence changes the cron; a bad cadence is refused', () => {
    const r = repo()
    const res = ch.setCodeHealthJob(r, { enabled: true, cadence: 'daily' }, ADMIN)
    expect(res.ok).toBe(true)
    if (res.ok) expect(routineOf(res.status.routine_id).cron_expr).toBe(ch.codeHealthCron(r.id, 'daily'))
    expect(ch.setCodeHealthJob(r, { cadence: 'hourly' }, ADMIN)).toMatchObject({ ok: false, code: 'bad_cadence' })
  })

  it('a repo with no GitHub link cannot be switched on', () => {
    const r = repo(null)
    expect(ch.setCodeHealthJob(r, { enabled: true }, ADMIN)).toMatchObject({ ok: false, code: 'repo_not_linked' })
    expect(ch.codeHealthStatus(r).unavailable).toMatch(/GitHub/)
  })

  it('removing the repo switches its routine off; the boot resync does the same for a vanished repo', () => {
    const r = repo()
    const on = ch.setCodeHealthJob(r, { enabled: true }, ADMIN)
    const rid = on.ok ? on.status.routine_id : null
    ch.disableCodeHealthForRepo(r.id)
    expect(routineOf(rid).enabled).toBe(0)

    const r2 = createWorkspaceRepo({ workspace: ws(), name: 'gadget', github: 'acme/gadget', stack: [] })
    const on2 = ch.setCodeHealthJob(r2, { enabled: true }, ADMIN)
    getDb().prepare('DELETE FROM workspace_repos WHERE id = ?').run(r2.id)
    expect(ch.resyncCodeHealthRoutines().disabled).toBe(1)
    expect(routineOf(on2.ok ? on2.status.routine_id : null).enabled).toBe(0)
  })

  it('the boot resync refreshes the brief but leaves a paused routine paused', () => {
    const r = repo()
    const on = ch.setCodeHealthJob(r, { enabled: true }, ADMIN)
    const id = on.ok ? on.status.routine_id : null
    getDb().prepare("UPDATE routines SET enabled = 0, objective_template = '{}' WHERE id = ?").run(id)
    expect(ch.resyncCodeHealthRoutines().synced).toBe(1)
    const rt = routineOf(id)
    expect(rt.enabled).toBe(0)
    expect(JSON.parse(rt.objective_template).title).toBe('Code health — widget')
  })
})

describe('fire guard — one waiting PR per repo', () => {
  it('refuses while an earlier run sits in review with a PR, and that refusal is a benign skip', async () => {
    const r = repo()
    const on = ch.setCodeHealthJob(r, { enabled: true }, ADMIN)
    const rt = routineOf(on.ok ? on.status.routine_id : null)
    expect(ch.codeHealthFireRefusal(rt)).toBeNull()
    const card = getDb()
      .prepare("INSERT INTO objectives (title, workspace, status, routine_id, type, pr_number, pr_url) VALUES ('Code health — widget', ?, 'review', ?, 'task', 12, 'https://github.com/acme/widget/pull/12')")
      .run(r.workspace, rt.id).lastInsertRowid as number
    const why = ch.codeHealthFireRefusal(rt)
    expect(why).toBe(`code-health guard: card #${card} still has a PR waiting for a person`)
    const res = await fireRoutine(rt, 'cron')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe(why)
    expect(classifyAiFireResult(res)).toBe('neutral')
    getDb().prepare('DELETE FROM objectives WHERE id = ?').run(card)
  })

  it('refuses for a repo that is gone; ignores every other routine', () => {
    expect(ch.codeHealthFireRefusal({ id: 1, name: 'code-health:999999' })).toMatch(/no longer exists/)
    expect(ch.codeHealthFireRefusal({ id: 1, name: 'docs-breathe' })).toBeNull()
  })
})

describe('isCodeHealthCard / isCodeHealthPr', () => {
  it('recognises a run card and its merged PR (repo-scoped)', () => {
    const r = repo()
    const on = ch.setCodeHealthJob(r, { enabled: true }, ADMIN)
    const rid = on.ok ? on.status.routine_id : null
    const id = getDb()
      .prepare("INSERT INTO objectives (title, workspace, status, routine_id, type, pr_number, pr_url) VALUES ('x', ?, 'done', ?, 'task', 34, 'https://github.com/Acme/Widget/pull/34')")
      .run(r.workspace, rid).lastInsertRowid as number
    expect(ch.isCodeHealthCard({ routine_id: rid })).toBe(true)
    expect(ch.isCodeHealthCard({ routine_id: null })).toBe(false)
    expect(ch.isCodeHealthPr(getDb(), 'acme/widget', 34)).toBe(true)
    expect(ch.isCodeHealthPr(getDb(), 'acme/other', 34)).toBe(false)
    expect(ch.isCodeHealthPr(getDb(), 'acme/widget', 35)).toBe(false)
    getDb().prepare('DELETE FROM objectives WHERE id = ?').run(id)
  })
})

describe('lightweight-only auto-merge', () => {
  const limits = { maxFiles: 8, maxLines: 200 }
  const small = { additions: 20, deletions: 30, changedFiles: 2, files: ['src/a.ts', 'src/a.test.ts'] }

  it('a small PR is lightweight', () => {
    expect(ch.codeHealthMergeBlock(small, limits)).toBeNull()
  })

  it('blocks over the caps, on schema / dependency / CI paths, and when the size is unknown', () => {
    expect(ch.codeHealthMergeBlock({ ...small, additions: 150, deletions: 60 }, limits)).toMatch(/210 lines/)
    expect(ch.codeHealthMergeBlock({ ...small, changedFiles: 9 }, limits)).toMatch(/9 files/)
    expect(ch.codeHealthMergeBlock({ ...small, files: ['app/server/src/db/schema/core.ts'] }, limits)).toMatch(/schema/)
    expect(ch.codeHealthMergeBlock({ ...small, files: ['supabase/migrations/001.sql'] }, limits)).toMatch(/schema/)
    expect(ch.codeHealthMergeBlock({ ...small, files: ['package-lock.json'] }, limits)).toMatch(/dependency/)
    expect(ch.codeHealthMergeBlock({ ...small, files: ['Dockerfile'] }, limits)).toMatch(/dependency/)
    expect(ch.codeHealthMergeBlock({ ...small, files: ['.github/workflows/gate.yml'] }, limits)).toMatch(/CI config/)
    expect(ch.codeHealthMergeBlock(null, limits)).toMatch(/unreadable/)
  })

  it('caps come from settings when set and sane', () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('code_health_max_lines', '50')").run()
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('code_health_max_files', 'lots')").run()
    expect(ch.codeHealthLimits()).toEqual({ maxFiles: 8, maxLines: 50 })
  })

  it('decideAutoMerge skips a blocked code-health PR and merges a lightweight one', () => {
    const base = {
      enabled: true, hasPr: true, prNumber: 7, harnessStatus: 'success' as const,
      reviewVerdict: 'pass' as const, objectiveType: 'task',
    }
    expect(decideAutoMerge({ ...base, codeHealthBlock: 'code-health PR changes 900 lines (cap 200) — a person merges it' }))
      .toEqual({ action: 'skip', reason: 'code-health PR changes 900 lines (cap 200) — a person merges it' })
    expect(decideAutoMerge({ ...base, codeHealthBlock: null }).action).toBe('merge')
    expect(decideAutoMerge({ ...base, enabled: false, codeHealthBlock: null }).action).toBe('dry-run')
    // A failed independent review never merges, whatever the size.
    expect(decideAutoMerge({ ...base, reviewVerdict: 'fail', codeHealthBlock: null }).action).toBe('skip')
  })

  it('readPrSize parses gh output and fails closed on errors', async () => {
    const ok = await ch.readPrSize('acme/widget', 7, async () =>
      JSON.stringify({ additions: 3, deletions: 1, changedFiles: 1, files: [{ path: 'src/a.ts' }] }))
    expect(ok).toEqual({ additions: 3, deletions: 1, changedFiles: 1, files: ['src/a.ts'] })
    expect(await ch.readPrSize('acme/widget', 7, async () => { throw new Error('401') })).toBeNull()
    expect(await ch.readPrSize('acme/widget', 7, async () => '{}')).toBeNull()
  })
})

describe('the independent AI review always runs on a code-health PR', () => {
  const card = { type: 'task' as const, create_pr: true, delegate_mode: false, pr_number: 5, pr_url: 'https://github.com/acme/widget/pull/5', routine_id: 42 }
  const ctx = { redPath: false, filesKnown: true, uiTouched: false, hasDelegatorParent: false }

  it('without the flag a backend-only routine PR is green → done (the gap this closes)', () => {
    expect(decideWorkerEndRoute(card, ctx)).toMatchObject({ lane: 'green', status: 'done' })
  })

  it('with the flag it goes to ai_review', () => {
    expect(decideWorkerEndRoute(card, { ...ctx, alwaysReviewPr: true })).toEqual({ lane: 'yellow', status: 'ai_review', prLinked: true })
  })

  it('a run that opened no PR ("nothing to do") still completes as a job', () => {
    expect(decideWorkerEndRoute({ ...card, pr_number: null, pr_url: null }, { ...ctx, alwaysReviewPr: true }).status).toBe('done')
  })

  it('a refused / empty run is never auto-completed', () => {
    expect(decideWorkerEndRoute(card, { ...ctx, alwaysReviewPr: true, producedNothing: true }).status).toBe('review')
  })
})

describe('brief', () => {
  it('names the caps, the open-PR check and the Needs You route for bigger work', () => {
    const r = repo()
    const brief = ch.codeHealthBrief(getWorkspaceRepo(r.id)!, { maxFiles: 5, maxLines: 120 })
    expect(brief).toContain('at most 5 files and 120 changed lines')
    expect(brief).toContain('gh pr list --repo acme/widget --state open')
    expect(brief).toContain('needs_review')
    expect(brief).toContain('nothing to do')
  })
})
