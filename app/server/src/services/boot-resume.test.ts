import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// obj 901459 — after a restart, the boot sweep gives a card the restart cut off
// the live loop's ONE automatic resume (queued messages → unanswered owner
// message → abnormal-end retry). Guards: one resume per card per episode (the
// shared stall budget, never re-armed by a boot resume) and a cap per boot.

const TMP_DB = path.join(os.tmpdir(), `cc-boot-resume-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const br = await import('./boot-resume.js')
const ae = await import('./abnormal-end-retry.js')
const uf = await import('./unanswered-followup.js')
const reasons = await import('./session-start-reasons.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})
let tmp: string
beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM objectives').run()
  db.prepare("DELETE FROM settings WHERE key LIKE 'stall_watchdog%' OR key = 'boot_resume_max_per_boot'").run()
  delete process.env.CC_BOOT_RESUME_MAX
  uf.__resetUnansweredState()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-resume-'))
})
afterEach(() => {
  delete process.env.CC_BOOT_RESUME_MAX
  fs.rmSync(tmp, { recursive: true, force: true })
})

const J = (o: unknown) => JSON.stringify(o)
const toolTurn = (id: string) => J({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id: `t${id}`, name: 'Bash', input: {} }] } })
/** Killed by the restart mid-turn: work, then nothing. */
const KILLED = [J({ type: 'prompt', text: 'go' }), J({ type: 'system', subtype: 'init' }), toolTurn('m1'), toolTurn('m2')]
/** Finished its turn, then the owner wrote and the restart hit before any reply. */
const UNANSWERED = [
  J({ type: 'prompt', text: 'go' }), toolTurn('m1'), J({ type: 'result', subtype: 'success', result: 'done' }),
  J({ type: 'followup', text: 'also fix the footer', timestamp: '2026-11-18T10:00:00Z' }),
]
const CLEAN = [...KILLED, J({ type: 'result', subtype: 'success', result: 'done' })]

const row = (id: number) => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Record<string, unknown>

function seed(n = 1): Objective {
  const db = getDb()
  const r = db.prepare(
    `INSERT INTO objectives (title, agent_context, workspace, project, status, session_id)
     VALUES (?, 'cto', 'operationkit', 'operationkit', 'working', ?)`,
  ).run(`card ${n}`, `cc-boot-${n}-${Date.now()}`)
  return row(Number(r.lastInsertRowid)) as unknown as Objective
}

/**
 * Production-shaped deps: the real abnormal-end handler, the real unanswered
 * reader/resender over a transcript file, and the real session-start ledger, so
 * a resume is recorded with its reason exactly like a spawn records it.
 */
function harness(transcripts: Map<string, string[]>, queued = new Set<number>()) {
  const db = getDb()
  const calls = { abnormal: [] as number[], unanswered: [] as number[], queued: [] as number[], alerts: [] as number[] }
  const pathFor = (sid: string) => {
    const p = path.join(tmp, `${sid}.jsonl`)
    fs.writeFileSync(p, (transcripts.get(sid) ?? []).join('\n') + '\n')
    return p
  }
  const recordStart = (id: number, sid: string | null) =>
    reasons.logSessionStart(db, { objectiveId: id, sessionId: sid, kind: 'resume' })
  const deps = {
    db,
    log: () => {},
    hasQueued: (o: Objective) => queued.has(o.id),
    deliverQueued: (o: Objective) => {
      reasons.noteStartReason(o.id, br.BOOT_RESUME_START_REASON, 'state-poller', 'queued')
      recordStart(o.id, o.session_id)
      queued.delete(o.id)
      calls.queued.push(o.id)
      return true
    },
    hasUnanswered: (o: Objective) => uf.readUnansweredFollowUps(o, pathFor).length > 0,
    resendUnanswered: (o: Objective) => uf.resendUnanswered(o, uf.readUnansweredFollowUps(o, pathFor), {
      jsonlPathFor: pathFor,
      stamp: (m: string) => m,
      noteStart: (id: number) => reasons.noteStartReason(id, br.BOOT_RESUME_START_REASON, 'state-poller', 'unanswered'),
      deliver: (sid: string, _m: string, o: Objective) => { recordStart(o.id, sid); calls.unanswered.push(o.id); return sid },
    }),
    abnormalEnd: (o: Objective) => ae.handleAbnormalEnd(o, {
      db,
      now: () => Date.now(),
      readLines: (sid: string) => transcripts.get(sid) ?? [],
      resume: (obj: Objective) => { recordStart(obj.id, obj.session_id); calls.abnormal.push(obj.id) },
      noteStartReason: (id: number, d: string) => reasons.noteStartReason(id, ae.ABNORMAL_END_START_REASON, 'state-poller', d),
      notify: (r: { id: number }) => { calls.alerts.push(r.id) },
      broadcast: () => {},
    }),
  }
  return { deps, calls }
}

/** One boot of the sweep over every dead `working` card. */
function boot(deps: ReturnType<typeof harness>['deps']) {
  const budget = br.newBootResumeBudget(getDb())
  const cards = getDb().prepare("SELECT * FROM objectives WHERE status = 'working' ORDER BY id").all() as Objective[]
  return cards.map(c => br.bootResumeInterrupted(c, budget, deps))
}

describe('resolveBootResumeMax', () => {
  it('defaults to 5, reads the setting, env wins, junk falls back, 0 = off', () => {
    const db = getDb()
    expect(br.resolveBootResumeMax(db, {})).toBe(br.DEFAULT_BOOT_RESUME_MAX)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('boot_resume_max_per_boot', '2')").run()
    expect(br.resolveBootResumeMax(db, {})).toBe(2)
    expect(br.resolveBootResumeMax(db, { CC_BOOT_RESUME_MAX: '9' })).toBe(9)
    expect(br.resolveBootResumeMax(db, { CC_BOOT_RESUME_MAX: '0' })).toBe(0)
    expect(br.resolveBootResumeMax(db, { CC_BOOT_RESUME_MAX: '-3' })).toBe(br.DEFAULT_BOOT_RESUME_MAX)
    expect(br.resolveBootResumeMax(db, { CC_BOOT_RESUME_MAX: 'lots' })).toBe(br.DEFAULT_BOOT_RESUME_MAX)
  })
})

describe('a card killed mid-turn by a restart', () => {
  it('resumes ONCE on the first boot; a second restart does not loop it (flagged + blocked instead)', () => {
    const card = seed()
    const t = new Map([[card.session_id!, KILLED]])
    const h = harness(t)

    expect(boot(h.deps)).toEqual(['abnormal_end'])
    expect(h.calls.abnormal).toEqual([card.id])
    expect(row(card.id).status).toBe('working')
    expect(row(card.id).stall_restarts).toBe(1)
    expect(row(card.id).last_start_reason).toBe('abnormal_end_retry')

    // The resumed session is killed by the next restart too.
    expect(boot(h.deps)).toEqual(['none'])
    expect(h.calls.abnormal).toEqual([card.id]) // still exactly one resume
    expect(row(card.id).stall_restarts).toBe(1)
    expect(row(card.id).stalled_at).toBeTruthy()
    expect(row(card.id).ai_review_verdict).toBe('blocked')
    expect(h.calls.alerts).toEqual([card.id])

    // A third restart: still no resume.
    expect(boot(h.deps)).toEqual(['none'])
    expect(h.calls.abnormal).toHaveLength(1)
  })

  it('a card that finished cleanly is left to the normal routing', () => {
    const card = seed()
    const h = harness(new Map([[card.session_id!, CLEAN]]))
    expect(boot(h.deps)).toEqual(['none'])
    expect(row(card.id).stall_restarts).toBe(0)
  })
})

describe('an unanswered owner message at restart', () => {
  it('is re-sent once; a second restart does not re-send it again', () => {
    const card = seed()
    const h = harness(new Map([[card.session_id!, UNANSWERED]]))

    expect(boot(h.deps)).toEqual(['unanswered'])
    expect(h.calls.unanswered).toEqual([card.id])
    expect(row(card.id).stall_restarts).toBe(1)
    // A boot resume does NOT re-arm the shared budget (a plain follow_up start would).
    expect(row(card.id).last_start_reason).toBe('boot_resume')

    // In-memory retry state is gone after a restart; the durable budget still holds.
    uf.__resetUnansweredState()
    expect(boot(h.deps)).toEqual(['none'])
    expect(h.calls.unanswered).toEqual([card.id])
  })

  it('a person starting the card opens a new episode, so a later restart may resume it once more', () => {
    const card = seed()
    const h = harness(new Map([[card.session_id!, UNANSWERED]]))
    expect(boot(h.deps)).toEqual(['unanswered'])
    reasons.noteStartReason(card.id, 'follow_up', 'casey')
    reasons.logSessionStart(getDb(), { objectiveId: card.id, sessionId: card.session_id, kind: 'resume' })
    expect(row(card.id).stall_restarts).toBe(0)
    expect(boot(h.deps)).toEqual(['unanswered'])
    expect(h.calls.unanswered).toHaveLength(2)
  })
})

describe('messages queued mid-turn at restart', () => {
  it('are delivered once and spend the episode budget', () => {
    const card = seed()
    const h = harness(new Map([[card.session_id!, CLEAN]]), new Set([card.id]))
    expect(boot(h.deps)).toEqual(['queued'])
    expect(h.calls.queued).toEqual([card.id])
    expect(row(card.id).stall_restarts).toBe(1)
    expect(row(card.id).last_start_reason).toBe('boot_resume')
  })

  it('are not delivered when the episode budget is already spent', () => {
    const card = seed()
    getDb().prepare('UPDATE objectives SET stall_restarts = 1 WHERE id = ?').run(card.id)
    const h = harness(new Map([[card.session_id!, CLEAN]]), new Set([card.id]))
    expect(boot(h.deps)).toEqual(['none'])
    expect(h.calls.queued).toEqual([])
  })
})

describe('per-boot cap', () => {
  it('resumes at most the cap per boot and parks the rest untouched', () => {
    const cards = Array.from({ length: 7 }, (_, i) => seed(i + 1))
    const h = harness(new Map(cards.map(c => [c.session_id!, KILLED])))
    const out = boot(h.deps)
    expect(out.filter(o => o === 'abnormal_end')).toHaveLength(5)
    expect(out.slice(5)).toEqual(['capped', 'capped'])
    expect(h.calls.abnormal).toHaveLength(5)
    // The capped cards kept their budget (nothing was claimed or flagged).
    for (const c of cards.slice(5)) {
      expect(row(c.id).stall_restarts).toBe(0)
      expect(row(c.id).stalled_at).toBeFalsy()
    }
  })

  it('honours the setting and the env override; 0 turns boot resumes off', () => {
    const cards = Array.from({ length: 3 }, (_, i) => seed(i + 1))
    const h = harness(new Map(cards.map(c => [c.session_id!, KILLED])))
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('boot_resume_max_per_boot', '1')").run()
    expect(boot(h.deps)).toEqual(['abnormal_end', 'capped', 'capped'])

    process.env.CC_BOOT_RESUME_MAX = '0'
    const fresh = seed(9)
    const h2 = harness(new Map([[fresh.session_id!, KILLED]]))
    expect(boot(h2.deps).at(-1)).toBe('capped')
    expect(h2.calls.abnormal).toEqual([])
  })

  it('the stall watchdog kill switch turns boot resumes off too', () => {
    const card = seed()
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stall_watchdog_enabled', '0')").run()
    const h = harness(new Map([[card.session_id!, UNANSWERED]]))
    expect(boot(h.deps)).toEqual(['none'])
    expect(h.calls.unanswered).toEqual([])
  })
})

describe('guards', () => {
  it('skips delegators and cards that are not working', () => {
    const a = seed(1)
    getDb().prepare('UPDATE objectives SET delegate_mode = 1 WHERE id = ?').run(a.id)
    const h = harness(new Map([[a.session_id!, KILLED]]))
    const budget = br.newBootResumeBudget(getDb())
    expect(br.bootResumeInterrupted(row(a.id) as unknown as Objective, budget, h.deps)).toBe('none')
    expect(br.bootResumeInterrupted({ ...(row(a.id) as unknown as Objective), delegate_mode: false, status: 'review' } as Objective, budget, h.deps)).toBe('none')
    expect(budget.used).toBe(0)
  })

  it('a failed resend spends the budget, so it cannot loop across restarts', () => {
    const card = seed()
    const h = harness(new Map([[card.session_id!, UNANSWERED]]))
    const deps = { ...h.deps, resendUnanswered: () => false }
    expect(boot(deps)).toEqual(['none'])
    expect(row(card.id).stall_restarts).toBe(1)
    expect(boot(h.deps)).toEqual(['none'])
    expect(h.calls.unanswered).toEqual([])
  })
})
