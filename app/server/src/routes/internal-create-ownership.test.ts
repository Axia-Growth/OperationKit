/**
 * obj 900208 — children created through POST /api/internal/objectives act for
 * the parent's owner, so a fan-out / delegated coding child gets the same
 * GitHub connection instead of spawning ownerless (connector guard `no_owner`)
 * and asking for a GH_TOKEN secret.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-create-owner-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const { inheritedOwnership, jobReplyOwnership, workspaceFirstAdmin, NO_OWNERSHIP } = await import('../lib/objective-ownership.js')

let server: http.Server
let baseUrl: string

const OPERATOR = 501
const CASEY = 502
const ZOE = 503

async function create(items: unknown[]): Promise<number[]> {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  })
  const json = (await res.json()) as { objectives?: Array<{ id: number }>; error?: string }
  expect(res.status, json.error).toBe(201)
  return json.objectives!.map(o => o.id)
}

type OwnerRow = { created_by: number | null; assigned_user_id: number | null; agent_key_id: number | null; agent_key_label: string | null }
function ownerOf(id: number): OwnerRow {
  return getDb()
    .prepare('SELECT created_by, assigned_user_id, agent_key_id, agent_key_label FROM objectives WHERE id = ?')
    .get(id) as OwnerRow
}

function insertParent(over: Partial<OwnerRow> & { workspace?: string; routine_id?: number | null }): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, created_by, assigned_user_id, agent_key_id, agent_key_label, routine_id)
       VALUES (?, 'cto', ?, 'working', ?, ?, ?, ?, ?)`,
    )
    .run(
      `parent ${Math.random()}`,
      over.workspace ?? 'ws-a',
      over.created_by ?? null,
      over.assigned_user_id ?? null,
      over.agent_key_id ?? null,
      over.agent_key_label ?? null,
      over.routine_id ?? null,
    )
  return Number(r.lastInsertRowid)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(OPERATOR)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'casey', 'x', 'member')`).run(CASEY)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'zoe', 'x', 'member')`).run(ZOE)
  // Zoe is the workspace admin of ws-c (a workspace role, not a global one).
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'ws-c', 'admin')`).run(ZOE)
  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const addr = server.address()
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { fs.unlinkSync(TMP_DB) } catch { /* ignore */ }
})

describe('POST /api/internal/objectives — child ownership (obj 900208)', () => {
  it('a child inherits the parent owner, so it spawns with that person\'s connectors', async () => {
    const parent = insertParent({ created_by: OPERATOR })
    const [child] = await create([{ title: 'child of operator', workspace: 'ws-a', parent_id: parent }])
    expect(ownerOf(child)).toEqual({ created_by: OPERATOR, assigned_user_id: null, agent_key_id: null, agent_key_label: null })
  })

  it('keeps a delegated parent delegated (assigned ≠ creator is copied as-is)', async () => {
    const parent = insertParent({ created_by: OPERATOR, assigned_user_id: CASEY })
    const [child] = await create([{ title: 'delegated child', workspace: 'ws-a', parent_id: parent }])
    expect(ownerOf(child)).toMatchObject({ created_by: OPERATOR, assigned_user_id: CASEY })
  })

  it('carries the parent\'s agent key so a key cannot widen its connector reach by filing a child', async () => {
    const parent = insertParent({ created_by: OPERATOR, agent_key_id: 77, agent_key_label: 'cos-bot' })
    const [child] = await create([{ title: 'key child', workspace: 'ws-a', parent_id: parent }])
    expect(ownerOf(child)).toMatchObject({ created_by: OPERATOR, agent_key_id: 77, agent_key_label: 'cos-bot' })
  })

  it('a child filed into a DIFFERENT workspace stays ownerless (no token crosses workspaces)', async () => {
    const parent = insertParent({ created_by: OPERATOR, workspace: 'ws-a' })
    const [child] = await create([{ title: 'cross-ws child', workspace: 'ws-b', parent_id: parent }])
    expect(ownerOf(child)).toEqual(NO_OWNERSHIP)
  })

  it('top-level internal creates are unchanged (no caller identity to attribute)', async () => {
    const [top] = await create([{ title: 'top level', workspace: 'ws-a' }])
    expect(ownerOf(top)).toEqual(NO_OWNERSHIP)
  })

  it('an ownerless parent yields an ownerless child (no owner is invented)', async () => {
    const parent = insertParent({})
    const [child] = await create([{ title: 'orphan child', workspace: 'ws-a', parent_id: parent }])
    expect(ownerOf(child)).toEqual(NO_OWNERSHIP)
  })
})

describe('inheritedOwnership', () => {
  it('returns no ownership for a missing or invalid parent', () => {
    expect(inheritedOwnership(getDb(), null, 'ws-a')).toEqual(NO_OWNERSHIP)
    expect(inheritedOwnership(getDb(), 0, 'ws-a')).toEqual(NO_OWNERSHIP)
    expect(inheritedOwnership(getDb(), 99999999, 'ws-a')).toEqual(NO_OWNERSHIP)
  })
})

// obj 901458 — a card filed from a job's reply thread (source_job_id → origin
// job_reply) used to be ownerless, so its session had no GitHub login (#901381).
describe('POST /api/internal/objectives — job reply ownership (obj 901458)', () => {
  function routine(name: string, template: Record<string, unknown>): number {
    const r = getDb()
      .prepare('INSERT INTO routines (name, cron_expr, objective_template) VALUES (?, ?, ?)')
      .run(name, '0 9 * * *', JSON.stringify(template))
    return Number(r.lastInsertRowid)
  }

  it('takes the source job card\'s owner (same rule as a parent)', async () => {
    const job = insertParent({ created_by: OPERATOR, assigned_user_id: CASEY })
    const [card] = await create([{ title: 'reply of a delegated job', workspace: 'ws-a', source_job_id: job }])
    expect(ownerOf(card)).toEqual({ created_by: OPERATOR, assigned_user_id: CASEY, agent_key_id: null, agent_key_label: null })
    const origin = getDb().prepare('SELECT origin FROM objectives WHERE id = ?').get(card) as { origin: string }
    expect(origin.origin).toBe('job_reply')
  })

  it('an ownerless routine job gives the reply the routine\'s user', async () => {
    const rid = routine(`daily-report-${Math.random()}`, { title: 'Daily report', workspace: 'ws-a', assigned_user_id: CASEY })
    const job = insertParent({ routine_id: rid })
    const [card] = await create([{ title: 'reply of a routine job', workspace: 'ws-a', source_job_id: job }])
    expect(ownerOf(card)).toMatchObject({ created_by: CASEY, assigned_user_id: CASEY })
  })

  it('an ownerless job with no routine user falls back to the workspace\'s first admin', async () => {
    const job = insertParent({ workspace: 'ws-c' })
    const [card] = await create([{ title: 'reply in ws-c', workspace: 'ws-c', source_job_id: job }])
    expect(ownerOf(card)).toMatchObject({ created_by: ZOE, assigned_user_id: ZOE })
  })

  it('with no workspace admin, the first global admin owns it', async () => {
    const job = insertParent({ workspace: 'ws-a' })
    const [card] = await create([{ title: 'reply in ws-a, ownerless job', workspace: 'ws-a', source_job_id: job }])
    expect(ownerOf(card)).toMatchObject({ created_by: OPERATOR, assigned_user_id: OPERATOR })
  })

  it('a job in ANOTHER workspace does not hand its owner across; the card\'s workspace admin owns it', async () => {
    const job = insertParent({ created_by: CASEY, workspace: 'ws-a' })
    const [card] = await create([{ title: 'cross-ws reply', workspace: 'ws-c', source_job_id: job }])
    expect(ownerOf(card)).toMatchObject({ created_by: ZOE, assigned_user_id: ZOE })
  })

  it('a key-filed ownerless job keeps the key on the reply (connector limits are not widened)', async () => {
    const job = insertParent({ agent_key_id: 88, agent_key_label: 'cos-bot' })
    const [card] = await create([{ title: 'reply of a key job', workspace: 'ws-a', source_job_id: job }])
    expect(ownerOf(card)).toEqual({ created_by: OPERATOR, assigned_user_id: OPERATOR, agent_key_id: 88, agent_key_label: 'cos-bot' })
  })

  it('a parent owner still wins over the job fallback', async () => {
    const parent = insertParent({ created_by: CASEY })
    const job = insertParent({ created_by: OPERATOR })
    const [card] = await create([{ title: 'child + job', workspace: 'ws-a', parent_id: parent, source_job_id: job }])
    expect(ownerOf(card)).toMatchObject({ created_by: CASEY, assigned_user_id: null })
  })
})

describe('jobReplyOwnership', () => {
  it('a High Agency wake job gives the reply the admin who switched the wake on', () => {
    const db = getDb()
    const rid = Number(
      db.prepare('INSERT INTO routines (name, cron_expr, objective_template) VALUES (?, ?, ?)')
        .run('high-agency:test-bot', '0 2 * * *', JSON.stringify({ title: 'wake', workspace: 'ws-a' })).lastInsertRowid,
    )
    db.prepare('INSERT OR REPLACE INTO agent_chat_high_agency (slug, enabled, run_as_user_id, routine_id) VALUES (?, 1, ?, ?)')
      .run('test-bot', CASEY, rid)
    const wake = insertParent({ routine_id: rid })
    expect(jobReplyOwnership(db, wake, 'ws-a')).toMatchObject({ created_by: CASEY, assigned_user_id: CASEY, source: 'wake' })
  })

  it('reports where the owner came from', () => {
    const db = getDb()
    expect(jobReplyOwnership(db, insertParent({ created_by: CASEY }), 'ws-a').source).toBe('source_job')
    expect(jobReplyOwnership(db, insertParent({}), 'ws-c')).toMatchObject({ created_by: ZOE, source: 'workspace_admin' })
    expect(jobReplyOwnership(db, 99999999, 'ws-a')).toMatchObject({ created_by: OPERATOR, source: 'workspace_admin' })
  })

  it('workspaceFirstAdmin prefers the workspace admin over the first global admin', () => {
    expect(workspaceFirstAdmin(getDb(), 'ws-c')).toBe(ZOE)
    expect(workspaceFirstAdmin(getDb(), 'ws-a')).toBe(OPERATOR)
  })
})
