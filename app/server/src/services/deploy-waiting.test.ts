/**
 * obj 901389 — "merged, waiting for deploy": the list the owner reads on the
 * Jobs page and a Full access bot reads through `release_status`.
 *
 * Runs against a REAL throwaway git pair (an origin and a "live checkout" clone)
 * and a real SQLite DB, so the git plumbing is exercised, not just the parser.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deploy-waiting-'))
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-deploy-waiting'

const { initDb, getDb } = await import('../db/index.js')
const { collectDeployStatus, parseWaitingLog, prNumberFromSubject } = await import('./deploy-waiting.js')
const { isMigrationPath, migrationPaths } = await import('../lib/migration-paths.js')
const { createGrant, writeDelegationAudit } = await import('./delegated-approvals.js')
const { grantMergeReasonPrefix } = await import('./merge-deploy-gate.js')

const REPO = 'acme/app'
const ORIGIN = path.join(TMP, 'origin.git')
const WORK = path.join(TMP, 'work') // where "merges" are made and pushed
const LIVE = path.join(TMP, 'live') // the live checkout the server serves

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', env }).trim()

function commit(files: Record<string, string>, subject: string, when: string): string {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(WORK, rel)), { recursive: true })
    fs.writeFileSync(path.join(WORK, rel), text)
  }
  git(WORK, 'add', '-A')
  execFileSync('git', ['-C', WORK, 'commit', '-q', '-m', subject], { env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } })
  git(WORK, 'push', '-q', 'origin', 'HEAD:main')
  return git(WORK, 'rev-parse', 'HEAD')
}

const T0 = '2026-11-18T10:00:00Z'
const T1 = '2026-11-18T11:00:00Z'
const T2 = '2026-11-18T12:00:00Z'

beforeAll(() => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', ORIGIN], { env })
  execFileSync('git', ['clone', '-q', ORIGIN, WORK], { env })
  git(WORK, 'checkout', '-q', '-b', 'main')
  commit({ 'README.md': 'hello' }, 'Initial (#100)', T0)
  execFileSync('git', ['clone', '-q', '-b', 'main', ORIGIN, LIVE], { env })
})

afterAll(() => {
  try { getDb().close() } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  for (const t of ['delegation_grants', 'delegation_audit', 'changelog_entries', 'objectives']) getDb().prepare(`DELETE FROM ${t}`).run()
})

describe('pure pieces', () => {
  it('reads PR numbers from squash and merge-commit subjects', () => {
    expect(prNumberFromSubject('Add a field to Settings (#885)')).toBe(885)
    expect(prNumberFromSubject('Merge pull request #12 from acme/x')).toBe(12)
    expect(prNumberFromSubject('Fix (#1) the thing')).toBeNull()
    expect(prNumberFromSubject('no number')).toBeNull()
  })

  it('flags schema and migration paths, not tests', () => {
    expect(isMigrationPath('app/server/src/db/schema/flow.ts')).toBe(true)
    expect(isMigrationPath('app/server/src/db/index.ts')).toBe(true)
    expect(isMigrationPath('supabase/migrations/20261118_add.sql')).toBe(true)
    expect(isMigrationPath('migrations/001.sql')).toBe(true)
    expect(isMigrationPath('app/server/src/db/index.test.ts')).toBe(false)
    expect(isMigrationPath('app/server/src/routes/db.ts')).toBe(false)
    expect(isMigrationPath('docs/migrations.md')).toBe(false)
    expect(migrationPaths(['a.ts', 'app/server/src/db/x.ts', 'app/server/src/db/x.ts'])).toEqual(['app/server/src/db/x.ts'])
  })

  it('parses the git log format', () => {
    const raw = '\x1eabc1234\x1f2026-11-18T12:00:00+00:00\x1fSchema (#2)\n\napp/server/src/db/a.ts\nb.ts\n\x1edef5678\x1f2026-11-18T11:00:00+00:00\x1fUI (#1)\n\nc.tsx\n'
    expect(parseWaitingLog(raw)).toEqual([
      { sha: 'abc1234', committed_at: '2026-11-18T12:00:00+00:00', subject: 'Schema (#2)', files: ['app/server/src/db/a.ts', 'b.ts'] },
      { sha: 'def5678', committed_at: '2026-11-18T11:00:00+00:00', subject: 'UI (#1)', files: ['c.tsx'] },
    ])
  })
})

describe('against a real live checkout', () => {
  it('nothing waiting: at origin/main and the server started after the last merge → live', () => {
    const st = collectDeployStatus(getDb(), { repoDir: LIVE, repo: REPO, now: new Date(T1), startedAt: new Date('2026-11-18T10:30:00Z') })
    expect(st).toMatchObject({ ok: true, checkout_at_origin_main: true, behind: 0, waiting: [], server_started_after_last_merge: true, live: true })
    expect(st.summary).toMatch(/Everything merged to main is live/)
  })

  it('at origin/main but the server started BEFORE the last merge → not live (needs a restart)', () => {
    const st = collectDeployStatus(getDb(), { repoDir: LIVE, repo: REPO, now: new Date(T1), startedAt: new Date('2026-11-18T09:00:00Z') })
    expect(st).toMatchObject({ ok: true, checkout_at_origin_main: true, waiting: [], server_started_after_last_merge: false, live: false })
    expect(st.summary).toMatch(/started before the last merge/)
  })

  it('two PRs waiting, one with a migration: PR, title, card, who merged, migration flag', () => {
    const db = getDb()
    // PR 101: a person merged it (from the merged-PR webhook's merged_by).
    commit({ 'app/client/src/Thing.tsx': 'x' }, 'Show the thing (#101)', T1)
    db.prepare(`INSERT INTO changelog_entries (repo, pr_number, pr_url, platform, merged_at, title_eng, merged_by) VALUES (?, 101, ?, 'CC', ?, 'Show the thing', 'operator')`)
      .run(REPO, `https://github.com/${REPO}/pull/101`, T1)
    // PR 102: Operation Kit Dev merged it under merge grant #N, card 777, and it changes the schema.
    commit({ 'app/server/src/db/schema/things.ts': 'create table', 'app/server/src/db/schema/things.test.ts': 't' }, 'Add things table (#102)', T2)
    db.prepare(`INSERT INTO objectives (id, title, status, workspace, pr_number, pr_url) VALUES (777, 'Things table', 'done', 'operationkit', 102, ?)`).run(`https://github.com/${REPO}/pull/102`)
    const g = createGrant(db, { grantor: { id: 1, username: 'operator' }, botName: 'Operation Kit Dev', agentSlug: 'operation-kit-dev', workspace: 'operationkit', actions: ['merge'], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), allowedWorkspaces: ['operationkit'] })
    writeDelegationAudit(db, { event: 'approval_used', grant_id: g.id, objective_id: 777, workspace: 'operationkit', bot_name: 'Operation Kit Dev', action: 'merge', reason: `${grantMergeReasonPrefix(REPO, 102)}at abc; green` })
    git(LIVE, 'fetch', '-q', 'origin', 'main') // what the drift guard does every 60 s

    const st = collectDeployStatus(db, { repoDir: LIVE, repo: REPO, now: new Date('2026-11-18T13:00:00Z'), startedAt: new Date('2026-11-18T10:30:00Z') })
    expect(st.ok).toBe(true)
    expect(st.checkout_at_origin_main).toBe(false)
    expect(st.behind).toBe(2)
    expect(st.live).toBe(false)
    expect(st.server_started_after_last_merge).toBe(false)
    expect(st.migrations_waiting).toBe(1)
    expect(st.summary).toBe('2 merged pull requests are waiting for a deploy (1 with a database migration).')
    expect(st.waiting.map(w => ({ pr: w.pr_number, title: w.title, card: w.card_id, by: w.merged_by_label, migration: w.migration, paths: w.migration_paths }))).toEqual([
      { pr: 102, title: 'Add things table', card: 777, by: `Operation Kit Dev (bot) under grant #${g.id}`, migration: true, paths: ['app/server/src/db/schema/things.ts'] },
      { pr: 101, title: 'Show the thing', card: null, by: 'operator', migration: false, paths: [] },
    ])
    expect(st.waiting[0].pr_url).toBe(`https://github.com/${REPO}/pull/102`)

    // Deploying (fast-forward + restart) clears it.
    git(LIVE, 'merge', '-q', '--ff-only', 'origin/main')
    const after = collectDeployStatus(db, { repoDir: LIVE, repo: REPO, now: new Date('2026-11-18T13:05:00Z'), startedAt: new Date('2026-11-18T13:04:00Z') })
    expect(after).toMatchObject({ checkout_at_origin_main: true, waiting: [], live: true })
  })

  it('an unreadable checkout is "unknown", never "live"', () => {
    const st = collectDeployStatus(getDb(), { repoDir: path.join(TMP, 'nope'), repo: REPO })
    expect(st).toMatchObject({ ok: false, live: false, waiting: [] })
    expect(st.summary).toMatch(/unknown/)
  })
})
