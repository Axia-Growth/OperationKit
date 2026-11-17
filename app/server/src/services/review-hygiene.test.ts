import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initAuditSchema } from '../db/schema/audit.js'
import { logObjectiveAudit } from './objective-audit.js'
import {
  parkUnreviewed,
  readClosedOverReview,
  readReviewRunnerFailure,
  REVIEWER_RUNNER_FAILURE_KIND,
} from './review-hygiene.js'

// obj 900959 — review verdict hygiene.
//  1. A reviewer session that failed to start, died or ended without a verdict is
//     a RUNNER FAILURE: ai_review_verdict stays NULL ("not reviewed"), the card is
//     parked in review (never done), and the failure is recorded.
//  2. closed_over_review comes from the audit trail and is present only when a
//     card was closed while its verdict was not pass.
// No db/index.ts import: an in-memory database with just the tables involved.

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY, title TEXT, project TEXT, workspace TEXT, status TEXT,
      ai_review_verdict TEXT, ai_review_findings TEXT, ai_review_session_id TEXT,
      ai_review_iteration INTEGER DEFAULT 0, updated_at TEXT
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, workspace TEXT NOT NULL,
      objective_id INTEGER, session_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN ('session_start','session_end','progress','decision','blocker','file_change','milestone','error')),
      title TEXT NOT NULL, detail TEXT, metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  initAuditSchema(db)
})

interface Row {
  id: number; title: string; project: string; workspace: string; status: string
  ai_review_verdict: string | null; ai_review_findings: string | null
  ai_review_session_id: string | null; ai_review_iteration: number
}

function seed(over: Partial<Row> = {}): Row {
  const r: Row = {
    id: 900412, title: 'A card', project: 'operationkit', workspace: 'operationkit',
    status: 'ai_review', ai_review_verdict: null, ai_review_findings: null,
    ai_review_session_id: 'review-900412-1', ai_review_iteration: 1, ...over,
  }
  db.prepare(
    `INSERT INTO objectives (id, title, project, workspace, status, ai_review_verdict, ai_review_findings, ai_review_session_id, ai_review_iteration)
     VALUES (@id, @title, @project, @workspace, @status, @ai_review_verdict, @ai_review_findings, @ai_review_session_id, @ai_review_iteration)`,
  ).run(r)
  return r
}
const read = (id: number) => db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Row

/** Same contract as runMachineStatusUpdate: never writes over done / cancelled. */
const guardedUpdate = (sql: string, ...params: unknown[]) =>
  db.prepare(sql.replace('WHERE id = ?', "WHERE id = ? AND status NOT IN ('done','cancelled')")).run(...params)

function close(id: number, actor: string, reason?: string) {
  const before = read(id)
  db.prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(id)
  logObjectiveAudit(db, {
    objectiveId: id, eventType: 'status_change', fromStatus: before.status, toStatus: 'done',
    actor, pathway: 'public-patch-status', reason: reason ?? null,
  })
}

describe('a reviewer that gave no verdict is a runner failure, not a verdict', () => {
  it('reviewer failed to start: verdict and findings stay NULL, card parks in review, failure is recorded', () => {
    const obj = seed()
    const reason = parkUnreviewed({ db, update: guardedUpdate }, obj, { cause: 'no_output' })
    expect(reason).toMatch(/runner failure/)

    const after = read(obj.id)
    expect(after.ai_review_verdict).toBeNull()
    expect(after.ai_review_findings).toBeNull()
    expect(after.status).toBe('review') // never auto-closed as done

    const log = db.prepare('SELECT * FROM activity_log WHERE objective_id = ?').all(obj.id) as Record<string, string>[]
    expect(log).toHaveLength(1)
    expect(log[0].event_type).toBe('error')
    expect(log[0].title).toBe(REVIEWER_RUNNER_FAILURE_KIND)
    expect(log[0].session_id).toBe('review-900412-1')
    expect(JSON.parse(log[0].metadata)).toEqual({ kind: REVIEWER_RUNNER_FAILURE_KIND, cause: 'no_output', iteration: 1 })

    expect(readReviewRunnerFailure(db, after)).toMatchObject({ cause: 'no_output', reason })
  })

  it('reviewer died partway: partial output goes to the runner-failure record, not ai_review_findings', () => {
    const obj = seed()
    parkUnreviewed({ db, update: guardedUpdate }, obj, { cause: 'no_verdict', partial: 'I started checking the diff and then' })
    const after = read(obj.id)
    expect(after.ai_review_verdict).toBeNull()
    expect(after.ai_review_findings).toBeNull()
    const log = db.prepare('SELECT detail FROM activity_log WHERE objective_id = ?').get(obj.id) as { detail: string }
    expect(log.detail).toContain('I started checking the diff and then')
    expect(readReviewRunnerFailure(db, after)?.cause).toBe('no_verdict')
  })

  it('a stale verdict from an earlier round is cleared, not kept', () => {
    const obj = seed({ ai_review_verdict: 'fail', ai_review_findings: 'old findings' })
    parkUnreviewed({ db, update: guardedUpdate }, obj, { cause: 'no_output' })
    expect(read(obj.id).ai_review_verdict).toBeNull()
    expect(read(obj.id).ai_review_findings).toBeNull()
  })

  it('a card a person already closed is left alone and nothing is recorded', () => {
    const obj = seed({ status: 'done' })
    expect(parkUnreviewed({ db, update: guardedUpdate }, obj, { cause: 'no_output' })).toBeNull()
    expect(read(obj.id).status).toBe('done')
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_log').get()).toEqual({ n: 0 })
  })

  it('the failure stops showing once a later review runs or gives a verdict', () => {
    const obj = seed()
    parkUnreviewed({ db, update: guardedUpdate }, obj, { cause: 'no_output' })
    // a new reviewer session replaced the failed one
    expect(readReviewRunnerFailure(db, { ...read(obj.id), ai_review_session_id: 'review-900412-2' })).toBeNull()
    // a real verdict exists
    expect(readReviewRunnerFailure(db, { ...read(obj.id), ai_review_verdict: 'blocked' })).toBeNull()
    // a card that never had a reviewer
    expect(readReviewRunnerFailure(db, { id: obj.id, ai_review_verdict: null, ai_review_session_id: null })).toBeNull()
  })
})

describe('closed_over_review', () => {
  it('is present with verdict, who, reason and when for a card closed over a fail', () => {
    const obj = seed({ status: 'review', ai_review_verdict: 'fail' })
    close(obj.id, 'bot:Operation Kit Dev', 'Reviewer flagged a flaky screenshot; change verified by hand')
    const c = readClosedOverReview(db, read(obj.id))
    expect(c).toMatchObject({
      verdict: 'fail',
      by: 'bot:Operation Kit Dev',
      reason: 'Reviewer flagged a flaky screenshot; change verified by hand',
    })
    expect(c?.at).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })

  it('is present without a reason when a person closed over a blocked verdict', () => {
    const obj = seed({ status: 'review', ai_review_verdict: 'blocked' })
    close(obj.id, 'user')
    expect(readClosedOverReview(db, read(obj.id))).toMatchObject({ verdict: 'blocked', by: 'user', reason: null })
  })

  it('is present with a null verdict when an unreviewed card was closed with a stated override reason', () => {
    const obj = seed({ status: 'review', ai_review_verdict: null })
    close(obj.id, 'bot:Outside agent', 'Docs-only change')
    expect(readClosedOverReview(db, read(obj.id))).toMatchObject({ verdict: null, by: 'bot:Outside agent', reason: 'Docs-only change' })
  })

  it('uses the latest close when the card was closed more than once', () => {
    const obj = seed({ status: 'review', ai_review_verdict: 'fail' })
    close(obj.id, 'user')
    db.prepare("UPDATE objectives SET status = 'review' WHERE id = ?").run(obj.id)
    close(obj.id, 'bot:Second', 'second close')
    expect(readClosedOverReview(db, read(obj.id))).toMatchObject({ by: 'bot:Second', reason: 'second close' })
  })

  it('reads the status handler row, not the agent-key guard mirror written after it (obj 901230)', () => {
    const obj = seed({ status: 'review', ai_review_verdict: 'fail' })
    close(obj.id, 'bot:Outside agent', 'Merged by owner; reviewer was down')
    logObjectiveAudit(db, {
      objectiveId: obj.id, eventType: 'status_change', fromStatus: 'review', toStatus: 'done',
      actor: 'agent_key:7:Outside agent', pathway: `agent_api PATCH /api/objectives/${obj.id}/status`, reason: null,
    })
    expect(readClosedOverReview(db, read(obj.id))).toMatchObject({
      verdict: 'fail', by: 'bot:Outside agent', reason: 'Merged by owner; reviewer was down',
    })
  })

  it('is absent when the verdict is pass', () => {
    const obj = seed({ status: 'review', ai_review_verdict: 'pass' })
    close(obj.id, 'user')
    expect(readClosedOverReview(db, read(obj.id))).toBeNull()
  })

  it('is absent for an ordinary close of a card that was never reviewed', () => {
    const obj = seed({ status: 'review', ai_review_verdict: null })
    close(obj.id, 'user')
    expect(readClosedOverReview(db, read(obj.id))).toBeNull()
  })

  it('is absent while the card is not done, whatever the verdict', () => {
    const obj = seed({ status: 'review', ai_review_verdict: 'fail' })
    expect(readClosedOverReview(db, read(obj.id))).toBeNull()
    // an old close row does not count once the card is open again
    close(obj.id, 'user')
    db.prepare("UPDATE objectives SET status = 'working' WHERE id = ?").run(obj.id)
    expect(readClosedOverReview(db, read(obj.id))).toBeNull()
  })

  it('is absent when there is no close on the audit trail', () => {
    const obj = seed({ status: 'done', ai_review_verdict: 'blocked' })
    expect(readClosedOverReview(db, obj)).toBeNull()
  })
})
