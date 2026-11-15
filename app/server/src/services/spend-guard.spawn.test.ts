// obj 900909 — the REAL spawn and respawn entry points refuse a card over its
// cost ceiling before any side effect: `startSession`, `sendFollowUp` (respawn
// of a dead process) and `reopenObjective`. Spend is measured from the card's
// real transcripts (result events' total_cost_usd); spawn/seat layers are mocked
// so a refusal is provable as "spawnInTmux was never called".
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spend-guard-spawn-'))
const TRANSCRIPTS = path.join(TMP, 'transcripts')
const SEAT_HOME = path.join(TMP, 'seat-home')
const WORKDIR = path.join(TMP, 'workdir')
fs.mkdirSync(TRANSCRIPTS, { recursive: true })
fs.mkdirSync(WORKDIR, { recursive: true })
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.TRANSCRIPT_DIR = TRANSCRIPTS
delete process.env.OBJECTIVE_CEILING_NORMAL_USD

// Nothing here opens a terminal; keep the native module out of the import graph.
vi.mock('node-pty', () => ({ spawn: vi.fn(), default: { spawn: vi.fn() } }))

const spawnInTmux = vi.fn((_opts: Record<string, unknown>) => 'tmux-test')
vi.mock('./session-tmux.js', () => ({ spawnInTmux: (o: Record<string, unknown>) => spawnInTmux(o), invalidateSessionLivenessCache: () => {} }))

const SEAT = { id: 'seat-1', label: 'Seat 1', homeDir: SEAT_HOME, activeSessions: [] as string[] }
vi.mock('./account-router.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordSessionStart: () => {},
  enqueueSession: () => {},
  getAccountForSession: () => null,
  getRouterStatus: () => ({ accounts: [{ ...SEAT, available: true }], queue: [], earliestReset: null }),
  chooseFollowUpAccount: () => ({ account: SEAT, rerouted: false }),
  getAccountById: () => SEAT,
  seatCount: () => 1,
  pickAccount: () => SEAT,
}))
vi.mock('./seat-pool.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), seatKind: () => 'claude' }))
vi.mock('./seat-assign.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordSessionSeat: () => {},
  seatSignIn: () => ({ env: {}, mount: null }),
}))
vi.mock('./session-manager.js', () => {
  class BranchLeaseConflictError extends Error {}
  class SessionLeaseConflictError extends Error {}
  return {
    startSession: vi.fn(),
    ensureUser: () => {},
    ensureObjectiveMemoryDir: () => {},
    reapPredecessorSessions: () => {},
    emitSessionLeaseConflictWarning: () => {},
    generateSessionId: (o: { id: number }) => `cc-${o.id}-2000`,
    BranchLeaseConflictError,
    SessionLeaseConflictError,
  }
})
vi.mock('./prompt-builder.js', async () => {
  const hist = await import('./prompt-builder-history.js')
  return {
    buildPrompt: () => 'BASE PROMPT',
    buildObjectiveHistory: () => 'HISTORY',
    assembleFlattenedFollowUpPrompt: hist.assembleFlattenedFollowUpPrompt,
    resolveWorkdir: () => WORKDIR,
  }
})
vi.mock('./session-worktree.js', () => ({
  computeIsolation: () => null,
  ensureWorktree: () => null,
  ensureWorktreeHookAssets: () => undefined,
}))
vi.mock('./session-spawn-env.js', () => ({ buildSpawnEnv: () => ({}) }))
vi.mock('./session-control.js', () => ({ isSessionActive: () => false }))
vi.mock('./objective-session-claim.js', () => ({ claimObjectiveSession: () => ({ outcome: 'claimed' }) }))

const { initDb, getDb } = await import('../db/index.js')
const { sendFollowUp, reopenObjective } = await import('./session-followup.js')
const { startSession } = await import('./session-start.js')
const { SpendCeilingRefusedError } = await import('./spend-guard.js')
const { activeSessions } = await import('./session-registry.js')
const { setObjectiveCeiling } = await import('./job-accounting.js')
const { __resetTranscriptListCache } = await import('./session-usage.js')

function makeCard(effort = 'normal'): { id: number; sessionId: string; jsonl: string } {
  const db = getDb()
  const id = Number(
    db.prepare(
      `INSERT INTO objectives (title, description, status, workspace, agent_context, effort)
       VALUES ('Spend card', 'Do the thing.', 'working', 'operationkit', 'general', ?)`,
    ).run(effort).lastInsertRowid,
  )
  const sessionId = `cc-${id}-1000`
  const jsonl = path.join(TRANSCRIPTS, `${sessionId}.jsonl`)
  fs.writeFileSync(jsonl, JSON.stringify({ type: 'system', subtype: 'init', session_id: `conv-${id}` }) + '\n')
  db.prepare('UPDATE objectives SET session_id = ? WHERE id = ?').run(sessionId, id)
  return { id, sessionId, jsonl }
}

/** One finished turn costing `usd` (total_cost_usd is cumulative per Claude session). */
function spend(jsonl: string, cumulativeUsd: number): void {
  fs.appendFileSync(jsonl, JSON.stringify({ type: 'result', session_id: 'x', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: cumulativeUsd }) + '\n')
  __resetTranscriptListCache()
}

const objective = (id: number) => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never
const refusals = (id: number) =>
  getDb().prepare("SELECT detail FROM activity_log WHERE objective_id = ? AND metadata LIKE '%spend_guard_spawn_refused%'").all(id) as { detail: string }[]

beforeAll(() => { initDb() })
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }) })
beforeEach(() => {
  spawnInTmux.mockClear()
  activeSessions.clear()
})

describe('spawn and respawn are refused over the ceiling', () => {
  it('startSession refuses a card whose spend is at its per-effort default, before any side effect', async () => {
    const { id, jsonl } = makeCard('normal')
    spend(jsonl, 76)
    await expect(startSession(objective(id))).rejects.toBeInstanceOf(SpendCeilingRefusedError)
    await expect(startSession(objective(id))).rejects.toThrow(
      /^Start refused by the spend guard: this card has spent \$76\.00 against its \$75\.00 ceiling \(the default for normal effort\)/,
    )
    expect(spawnInTmux).not.toHaveBeenCalled()
    expect(refusals(id).length).toBeGreaterThan(0)
  })

  it('sendFollowUp refuses to respawn a dead session over an explicit ceiling', () => {
    const { id, sessionId, jsonl } = makeCard('ultracode')
    spend(jsonl, 12)
    setObjectiveCeiling(getDb(), id, { costUsd: 10 })
    let err: unknown
    try { sendFollowUp(sessionId, 'keep going', objective(id)) } catch (e) { err = e }
    expect(err).toBeInstanceOf(SpendCeilingRefusedError)
    expect((err as Error).message).toMatch(/^Respawn refused by the spend guard: this card has spent \$12\.00 against its \$10\.00 ceiling \(set on this card\)/)
    expect(spawnInTmux).not.toHaveBeenCalled()
    expect(refusals(id)).toHaveLength(1)
  })

  it('sendFollowUp respawns normally under the ceiling', () => {
    const { id, sessionId, jsonl } = makeCard('normal')
    spend(jsonl, 3)
    sendFollowUp(sessionId, 'keep going', objective(id))
    expect(spawnInTmux).toHaveBeenCalledTimes(1)
    expect(refusals(id)).toHaveLength(0)
  })

  it('reopenObjective refuses to respawn the last thread over the ceiling', async () => {
    const { id, sessionId, jsonl } = makeCard('high')
    spend(jsonl, 151)
    getDb().prepare(
      "INSERT INTO session_intel (session_id, objective_id, started_at, ended_at, total_cost_usd) VALUES (?, ?, datetime('now'), datetime('now'), 151)",
    ).run(sessionId, id)
    await expect(reopenObjective(objective(id))).rejects.toThrow(/^Respawn refused by the spend guard: this card has spent \$151\.00 against its \$150\.00 ceiling \(the default for high effort\)/)
    expect(spawnInTmux).not.toHaveBeenCalled()
  })

  it('the spawn kill switch lets an over-ceiling respawn through', () => {
    const { id, sessionId, jsonl } = makeCard('normal')
    spend(jsonl, 500)
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('spend_spawn_guard_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run()
    try {
      sendFollowUp(sessionId, 'keep going', objective(id))
      expect(spawnInTmux).toHaveBeenCalledTimes(1)
    } finally {
      getDb().prepare("DELETE FROM settings WHERE key = 'spend_spawn_guard_enabled'").run()
    }
  })
})
