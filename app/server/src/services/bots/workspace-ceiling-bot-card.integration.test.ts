/**
 * obj 901371 — a WORKSPACE wall-clock ceiling is enough for a bot-filed card.
 *
 * The owner of an install chose one number for a workspace
 * (`settings.job_wallclock_ceiling_ms:<workspace>` = 30 minutes) so that cards
 * a bot files from chat stop coming back as a per-card "set a time limit"
 * decision. This suite pins that end to end against a real migrated SQLite
 * database and the real modules the runtime calls:
 *
 *   1. no ceiling anywhere         → the card is filed but NOT cleared to start
 *   2. workspace ceiling set       → the same request is cleared to start, with
 *                                    the workspace's number and no per-card row
 *   3. the runner honours it       → running on at 29 min, stopped at 30 min
 *   4. time is cumulative          → a retry under a new session cannot reset it
 *   5. it is per workspace         → another workspace is still refused
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ws-ceiling-bot-card-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-901371'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP
process.env.KNOWLEDGE_BASE_DIR = path.join(TMP, 'kb')

vi.mock('../../ws/index.js', () => ({ broadcast: vi.fn(), broadcastToObjective: vi.fn() }))
vi.mock('../notifier.js', () => ({ sendTelegram: vi.fn(), insertAlert: vi.fn() }))
vi.mock('../session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))

// The tmux killer is the one side effect not performed for real.
const killedTmux: string[] = []
vi.mock('../session-control.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, killTmuxByName: (name: string) => { killedTmux.push(name); return true } }
})

const { getDb, initDb } = await import('../../db/index.js')
const { createBotJob, getJobOrigin } = await import('./bot-jobs.js')
const { enforceRunningCeiling } = await import('../poller-loop.js')
const { resolveConfiguredCeiling, getObservedSessionMs } = await import('../job-accounting.js')
const { recordSessionSpawn } = await import('../session-spawn-clock.js')

const PERSON = 9713
const WS = 'your-org'
const OTHER_WS = 'operationkit'
const AGENT = 'gtm-engineer' // a chat bot outside the built-in registry
const MIN = 60 * 1000
const THIRTY_MIN = 30 * MIN

beforeAll(() => {
  initDb()
  const db = getDb()
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, 'ws-ceiling-person', 'x', 'member')").run(PERSON)
  db.prepare('INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(PERSON, WS)
  db.prepare('INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(PERSON, OTHER_WS)
})

afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  killedTmux.length = 0
  getDb()
    .prepare("DELETE FROM settings WHERE key LIKE 'job_cost_ceiling_usd%' OR key LIKE 'job_wallclock_ceiling_ms%' OR key LIKE 'job_ceiling_policy%' OR key = 'job_ceiling_guard_enabled'")
    .run()
})

function setWorkspaceCeiling(workspace: string, ms: number): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`job_wallclock_ceiling_ms:${workspace}`, String(ms))
}

let seq = 0
/** File a card exactly as the chat `create_objective` tool does. */
function fileFromChat(workspace: string) {
  const n = ++seq
  const r = createBotJob(getDb(), {
    userId: PERSON,
    agentSlug: AGENT,
    ownerBot: null,
    chatBot: { name: 'GTM Engineer', ownerBot: null },
    workspace,
    title: `Pull email and SMS stats ${n}-${Date.now()}`,
    description: 'Read-only stats pull.',
    idempotencyKey: `idem-901371-${n}-${Date.now()}`,
  })
  if (!r.ok) throw new Error(`createBotJob refused: ${r.error}`)
  return r
}

/** Put the filed card into `working` under a session that started `ms` ago. */
function runFor(objectiveId: number, sessionId: string, ms: number) {
  const db = getDb()
  db.prepare("UPDATE objectives SET status = 'working', session_id = ? WHERE id = ?").run(sessionId, objectiveId)
  db.prepare('INSERT INTO session_leases (lease_key, objective_id, session_id, tmux_name) VALUES (?, ?, ?, ?)').run(
    `obj:${objectiveId}:${sessionId}`, objectiveId, sessionId, sessionId,
  )
  recordSessionSpawn(db, sessionId, Date.now() - ms)
}

function card(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as {
    status: string; session_id: string | null; ai_review_verdict: string | null
    ai_review_findings: string | null; has_blockers: number; workspace: string
  }
}
const row = (id: number) => card(id) as never

describe('a bot-filed card under a workspace wall-clock ceiling (obj 901371)', () => {
  it('with NO ceiling anywhere the card is filed but not cleared to start', () => {
    const r = fileFromChat(WS)
    expect(r.start.allowed).toBe(false)
    expect(r.start.code).toBe('auto_start_no_ceiling')
    expect(getJobOrigin(getDb(), r.objectiveId)!.start_mode).toBe('manual')
  })

  it('with the workspace ceiling set it is cleared to start under that ceiling — no per-card ceiling is written', () => {
    setWorkspaceCeiling(WS, THIRTY_MIN)
    const r = fileFromChat(WS)

    expect(r.start.allowed).toBe(true)
    expect(r.start.mode).toBe('auto')
    expect(r.start.ceiling).toMatchObject({ wallclockMs: THIRTY_MIN, costUsd: null, source: `workspace:${WS}` })
    expect(r.start.enforcement).toEqual({ wallclock: 'enforced', cost: 'unset' })
    expect(getJobOrigin(getDb(), r.objectiveId)!.start_mode).toBe('auto')

    // The number comes from the workspace row, not from anything pinned on the card.
    const pinned = getDb()
      .prepare('SELECT wallclock_ceiling_ms, cost_ceiling_usd FROM objective_job_accounting WHERE objective_id = ?')
      .get(r.objectiveId) as { wallclock_ceiling_ms: number | null; cost_ceiling_usd: number | null } | undefined
    expect(pinned?.wallclock_ceiling_ms ?? null).toBeNull()
    expect(pinned?.cost_ceiling_usd ?? null).toBeNull()
    expect(resolveConfiguredCeiling(getDb(), r.objectiveId, WS).wallclockMs).toBe(THIRTY_MIN)
  })

  it('the runner lets it run at 29 minutes and stops it at 30', async () => {
    setWorkspaceCeiling(WS, THIRTY_MIN)
    const under = fileFromChat(WS)
    runFor(under.objectiveId, `cc-${under.objectiveId}-s1`, 29 * MIN)
    expect(await enforceRunningCeiling(row(under.objectiveId))).toBe(false)
    expect(card(under.objectiveId).status).toBe('working')
    expect(killedTmux).toEqual([])

    const over = fileFromChat(WS)
    const sid = `cc-${over.objectiveId}-s1`
    runFor(over.objectiveId, sid, THIRTY_MIN + 5_000)
    expect(await enforceRunningCeiling(row(over.objectiveId))).toBe(true)

    const c = card(over.objectiveId)
    expect(c.status).toBe('review') // blocked for a person, never auto-done
    expect(c.ai_review_verdict).toBe('blocked')
    expect(c.has_blockers).toBe(1)
    expect(c.ai_review_findings).toContain('Wall-clock ceiling reached')
    expect(c.ai_review_findings).toContain('1800s ceiling')
    expect(c.ai_review_findings).toContain(`workspace:${WS}`)
    expect(c.session_id).toBeNull()
    expect(killedTmux).toEqual([sid])
  })

  it('time is counted across every attempt — a retry under a new session cannot reset the 30 minutes', async () => {
    setWorkspaceCeiling(WS, THIRTY_MIN)
    const r = fileFromChat(WS)
    const id = r.objectiveId

    runFor(id, `cc-${id}-s1`, 20 * MIN) // first attempt: 20 minutes, then it dies
    expect(await enforceRunningCeiling(row(id))).toBe(false)

    // The first worker is gone and its lease released, as the dead-session path leaves it.
    getDb().prepare("UPDATE session_leases SET released_at = datetime('now') WHERE objective_id = ?").run(id)

    runFor(id, `cc-${id}-s2`, 11 * MIN) // retry: 11 more minutes → 31 in total
    expect(await enforceRunningCeiling(row(id))).toBe(true)
    expect(getObservedSessionMs(getDb(), id)).toBeGreaterThanOrEqual(31 * MIN)
    expect(card(id).status).toBe('review')
    expect(killedTmux).toEqual([`cc-${id}-s2`])
  })

  it('the ceiling belongs to its workspace only — another workspace is still refused', () => {
    setWorkspaceCeiling(WS, THIRTY_MIN)
    const other = fileFromChat(OTHER_WS)
    expect(other.start.allowed).toBe(false)
    expect(other.start.code).toBe('auto_start_no_ceiling')
    expect(resolveConfiguredCeiling(getDb(), other.objectiveId, OTHER_WS).source).toBe('none')
  })
})
