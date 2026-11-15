/**
 * obj 900803 (white-label F2) — an install that ALREADY EXISTED.
 *
 * Built from the checked-in production schema snapshot plus this install's own
 * workspace rows, then booted with the new code: every existing workspace row
 * is byte-for-byte untouched, and the old built-in defaults (CORS origin,
 * preview domain, harness repo, Assistant nudge ON) are carried over ONCE as
 * settings rows, so behaviour does not change. An operator's own setting is
 * never overwritten, and a later edit survives restarts.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

const SNAPSHOT = path.join(import.meta.dirname, '..', '__fixtures__', 'prod-schema-snapshot.sql')
const TMP_DB = path.join(os.tmpdir(), `cc-install-existing-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
for (const k of ['CORS_ORIGINS', 'CC_PREVIEW_DOMAIN', 'HARNESS_REPO', 'ASSISTANT_NUDGE_ENABLED', 'CC_PUBLIC_URL', 'APP_BASE_URL', 'OK_DOMAIN']) delete process.env[k]

afterAll(() => {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(`${TMP_DB}${s}`, { force: true })
})

// What this install has today (shape of the rows the old seed wrote, plus an
// admin edit to one of them and an operator-created workspace).
const EXISTING = [
  ['example', 'Example', 'Example', 'bg-blue-500/20 text-blue-400', '/home/operator/second-brain/workspaces/example', 1],
  ['example-project', 'Example Project', 'WS', 'bg-green-500/20 text-green-400', '/home/operator/second-brain/workspaces/example-project', 2],
  ['operator', 'Operator (edited)', 'ML', 'bg-purple-500/20 text-purple-400', '/home/operator/second-brain/workspaces/operator', 3],
  ['example2', 'Example3', 'EXAMPLE2', 'bg-emerald-500/20 text-emerald-400', null, 4],
  ['example5', 'Example Five', 'EXAMPLE5', 'bg-teal-500/20 text-teal-400', '/home/operator/second-brain/workspaces/example5', 5],
  ['operationkit', 'OperationKit', 'OK', null, '/home/operator/second-brain/workspaces/operationkit', 6],
] as const

function snapshotRows(db: Database.Database) {
  return {
    // The columns every version has (a later migration may ADD columns, e.g. merged_into).
    workspaces: db.prepare('SELECT slug, name, short_label, badge_color, vault_path, doc_read_roots, doc_write_roots, default_agent_pool, archived, sort_order, created_at, updated_at FROM workspaces ORDER BY slug').all(),
    repos: db.prepare('SELECT workspace, name, github, repo_path FROM workspace_repos ORDER BY id').all(),
  }
}

let before: ReturnType<typeof snapshotRows>

{
  const seed = new Database(TMP_DB)
  seed.exec(fs.readFileSync(SNAPSHOT, 'utf8'))
  const ins = seed.prepare('INSERT INTO workspaces (slug, name, short_label, badge_color, vault_path, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const w of EXISTING) ins.run(...w, '2026-01-01 00:00:00', '2026-02-02 00:00:00')
  seed.prepare("INSERT INTO workspace_repos (workspace, name, github, repo_path) VALUES ('example-project', 'example-project-platform', 'Example-Project/example-project-platform', '/home/operator/projects/example-project-platform')").run()
  seed.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', 'x', 'admin')").run()
  // The operator already pinned one of these by hand — it must survive.
  seed.prepare("INSERT INTO settings (key, value) VALUES ('install_harness_repo', 'Acme/own-fork')").run()
  seed.close()
}

const { initDb, getDb } = await import('./index.js')
const {
  LEGACY_INSTALL_DEFAULTS, LEGACY_DEFAULTS_MARKER, INSTALL_SETTING, resolveCorsOrigins, resolvePreviewDomain,
  resolveHarnessRepo, assistantNudgeEnabled, resolveOwnerName,
} = await import('../lib/install-defaults.js')

describe('existing install keeps its workspaces and its old defaults (obj 900803)', () => {
  it('boots over the prod-shaped DB', () => {
    const raw = new Database(TMP_DB)
    before = snapshotRows(raw)
    raw.close()
    expect(() => initDb()).not.toThrow()
  })

  it('leaves every existing workspace / repo row exactly as it was', () => {
    const after = snapshotRows(getDb())
    expect(after.workspaces).toEqual(before.workspaces)
    // The dev-registry seed only adds repo / integration rows to workspaces that
    // already exist (as it always did); it never creates a workspace.
    expect(after.repos.slice(0, before.repos.length)).toEqual(before.repos)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n).toBe(EXISTING.length)
  })

  it('carries the old built-in defaults over as settings (and keeps the operator value)', () => {
    const db = getDb()
    const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value
    expect(get(LEGACY_DEFAULTS_MARKER)).toBe('carried')
    expect(get(INSTALL_SETTING.corsOrigins)).toBe(LEGACY_INSTALL_DEFAULTS[INSTALL_SETTING.corsOrigins])
    expect(get(INSTALL_SETTING.previewDomain)).toBe(LEGACY_INSTALL_DEFAULTS[INSTALL_SETTING.previewDomain])
    expect(get(INSTALL_SETTING.assistantNudge)).toBe('1')
    expect(get(INSTALL_SETTING.ownerName)).toBe('Operator')
    expect(get(INSTALL_SETTING.harnessRepo)).toBe('Acme/own-fork') // not overwritten
  })

  it('so the resolved behaviour equals the pre-change defaults', () => {
    expect(resolveCorsOrigins()).toEqual(['https://cc.example.com', 'http://localhost:5173', 'http://localhost:3002'])
    expect(resolvePreviewDomain()).toBe('cc.example.com')
    expect(assistantNudgeEnabled()).toBe(true)
    expect(resolveHarnessRepo()).toBe('Acme/own-fork')
    // first admin here is a generic 'admin' account: the carried name wins
    expect(resolveOwnerName()).toBe('Operator')
  })

  it('env still wins over the carried settings', () => {
    expect(resolveCorsOrigins({ CORS_ORIGINS: 'https://x.test' } as NodeJS.ProcessEnv)).toEqual(['https://x.test'])
    expect(assistantNudgeEnabled({ ASSISTANT_NUDGE_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false)
    expect(resolveHarnessRepo({ HARNESS_REPO: 'Org/repo' } as NodeJS.ProcessEnv)).toBe('Org/repo')
  })

  it('runs once: an operator turning Assistant off is not undone by the next boot', () => {
    getDb().prepare("UPDATE settings SET value = '0' WHERE key = ?").run(INSTALL_SETTING.assistantNudge)
    initDb()
    expect(assistantNudgeEnabled()).toBe(false)
    expect(snapshotRows(getDb()).workspaces).toEqual(before.workspaces)
  })
})
