/**
 * obj 901458 — a coding session that starts with no GitHub login says so at
 * start: one card line (activity_log, metadata.kind `github_unavailable_at_start`)
 * naming the reason, plus the plain prompt line from buildGithubAccessLines.
 * Before, such a session (e.g. an ownerless job reply, #901381) only found out
 * when `git push` failed.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-gh-start-note-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.CC_SESSION_KB_ACCESS = '0'

const { initDb, getDb } = await import('../db/index.js')
const tokens = await import('./user-github-tokens.js')
const {
  buildSpawnEnv,
  githubStartNote,
  noteGithubUnavailableAtStart,
  GITHUB_UNAVAILABLE_NOTE_KIND,
} = await import('./session-spawn-env.js')
const { buildGithubAccessLines } = await import('./session-trust-prompt.js')
const { setAccess } = await import('../connectors/access.js')

const OWNER = 21
const PAT = 'github_pat_11STARTNOTE_ownerSecret_0000'
function card(over: Partial<Objective> = {}): Objective {
  // A real row: the card note's objective_id is a foreign key.
  const id = Number(
    getDb().prepare(`INSERT INTO objectives (title, agent_context, workspace, status) VALUES (?, 'cto', 'ws-a', 'working')`)
      .run(`card ${Math.random()}`).lastInsertRowid,
  )
  return { id, workspace: 'ws-a', agent_context: 'cto', project: 'operationkit', created_by: OWNER, ...over } as Objective
}
function notes(objectiveId: number): Array<{ title: string; reason: string; kind: string; event_type: string }> {
  return (getDb()
    .prepare('SELECT title, event_type, metadata FROM activity_log WHERE objective_id = ? ORDER BY id')
    .all(objectiveId) as Array<{ title: string; event_type: string; metadata: string | null }>)
    .map(r => ({ title: r.title, event_type: r.event_type, ...(JSON.parse(r.metadata ?? '{}') as { reason: string; kind: string }) }))
    .filter(n => n.kind === GITHUB_UNAVAILABLE_NOTE_KIND)
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
beforeEach(() => {
  getDb().exec('DELETE FROM user_github_tokens; DELETE FROM users;')
  try { getDb().exec('DELETE FROM connector_access') } catch { /* lazy */ }
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'owner', 'x', 'member')`).run(OWNER)
})

describe('session start with no GitHub login (obj 901458)', () => {
  it('an ownerless coding card gets a card note naming no_owner at worker start', () => {
    const c = card({ created_by: null as unknown as number })
    const env = buildSpawnEnv({ objective: c, homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    const n = notes(c.id)
    expect(n).toHaveLength(1)
    expect(n[0].reason).toBe('no_owner')
    expect(n[0].title).toContain('no GitHub login (no_owner)')
    expect(n[0].title).toContain('has no owner')
    // and the prompt carries the same reason in one line
    const lines = buildGithubAccessLines(c, new Set())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('not available to this session')
    expect(lines[0]).toContain('has no owner')
  })

  it('an owner who has not connected GitHub is named as not_connected', () => {
    const c = card()
    buildSpawnEnv({ objective: c, homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(notes(c.id).map(n => n.reason)).toEqual(['not_connected'])
  })

  it('an owner access rule that excludes the card is named as access_rule (rules unchanged)', () => {
    tokens.upsert(OWNER, { rawToken: PAT, login: 'owner-gh', githubUserId: 1, email: '1+owner-gh@users.noreply.github.com', scopes: null, tokenType: 'pat_fine' })
    setAccess('github', OWNER, { agents: ['some-other-agent'], workspaces: null, allow_delegated: false })
    const c = card()
    const env = buildSpawnEnv({ objective: c, homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(notes(c.id).map(n => n.reason)).toEqual(['access_rule'])
  })

  it('a connected owner gets no note (the session has its login)', () => {
    tokens.upsert(OWNER, { rawToken: PAT, login: 'owner-gh', githubUserId: 1, email: '1+owner-gh@users.noreply.github.com', scopes: null, tokenType: 'pat_fine' })
    const c = card()
    const env = buildSpawnEnv({ objective: c, homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBe(PAT)
    expect(notes(c.id)).toEqual([])
  })

  it('a GH_TOKEN override in the env, or a card with no repo project, gets no note', () => {
    expect(githubStartNote(card({ created_by: null as unknown as number }), { GH_TOKEN: 'x' })).toBeNull()
    expect(githubStartNote(card({ created_by: null as unknown as number }), { GITHUB_TOKEN: 'x' })).toBeNull()
    expect(githubStartNote(card({ created_by: null as unknown as number, project: null as unknown as string }), {})).toBeNull()
  })

  it('only worker and follow-up starts write it (not planner, reviewer or arena)', () => {
    const c = card({ created_by: null as unknown as number })
    for (const kind of ['planner', 'reviewer', 'arena'] as const) {
      expect(noteGithubUnavailableAtStart(c, {}, kind)).toBe(false)
    }
    expect(notes(c.id)).toEqual([])
    expect(noteGithubUnavailableAtStart(c, {}, 'followup')).toBe(true)
    expect(notes(c.id)).toHaveLength(1)
  })

  it('a respawn with the same reason does not repeat the note; a new reason does', () => {
    const c = card({ created_by: null as unknown as number })
    expect(noteGithubUnavailableAtStart(c, {}, 'worker')).toBe(true)
    expect(noteGithubUnavailableAtStart(c, {}, 'followup')).toBe(false)
    expect(notes(c.id)).toHaveLength(1)
    const owned = { ...c, created_by: OWNER } as Objective
    expect(noteGithubUnavailableAtStart(owned, {}, 'followup')).toBe(true)
    expect(notes(c.id).map(n => n.reason)).toEqual(['no_owner', 'not_connected'])
  })
})
