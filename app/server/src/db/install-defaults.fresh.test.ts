/**
 * obj 900803 (white-label F2) — a FRESH install.
 *
 * A brand-new DB gets none of the original author's workspaces (Example, Weight
 * Supply, Operator, Example Five, Example3) or their repo / integration
 * rows, and none of the author's install defaults (CORS origin, preview
 * domain, harness repo, Assistant nudge ON). Its sibling,
 * install-defaults.existing.test.ts, proves an install that already existed
 * keeps all of them.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-install-fresh-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
for (const k of ['CORS_ORIGINS', 'CC_PREVIEW_DOMAIN', 'HARNESS_REPO', 'ASSISTANT_NUDGE_ENABLED', 'CC_PUBLIC_URL', 'APP_BASE_URL', 'OK_DOMAIN']) delete process.env[k]

const { initDb, getDb } = await import('./index.js')
const {
  LEGACY_INSTALL_DEFAULTS, LEGACY_DEFAULTS_MARKER, resolveCorsOrigins, resolvePreviewDomain,
  resolveHarnessRepo, assistantNudgeEnabled, resolveOwnerName,
} = await import('../lib/install-defaults.js')

const AUTHOR_WORKSPACES = ['example', 'example-project', 'operator', 'example5', 'example2']

afterAll(() => {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(`${TMP_DB}${s}`, { force: true })
})

describe('fresh scratch DB (obj 900803)', () => {
  it('boots with no author workspaces, repos or integrations', () => {
    expect(fs.existsSync(TMP_DB)).toBe(false)
    initDb()
    const db = getDb()
    const slugs = (db.prepare('SELECT slug FROM workspaces').all() as { slug: string }[]).map(r => r.slug)
    for (const s of AUTHOR_WORKSPACES) expect(slugs).not.toContain(s)
    expect(slugs).toEqual([])
    const vaults = db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE vault_path LIKE '/home/operator/%'").get() as { n: number }
    expect(vaults.n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM workspace_repos').get() as { n: number }).n).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS n FROM workspace_integrations WHERE kind = 'development'").get() as { n: number }).n).toBe(0)
  })

  it('gets none of the author install defaults — only the marker', () => {
    const db = getDb()
    for (const key of Object.keys(LEGACY_INSTALL_DEFAULTS)) {
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(key), key).toBeUndefined()
    }
    expect((db.prepare('SELECT value FROM settings WHERE key = ?').get(LEGACY_DEFAULTS_MARKER) as { value: string }).value).toBe('fresh')
  })

  it('resolves to neutral defaults: local dev CORS only, no preview host, no harness repo, Assistant off, "the owner"', () => {
    expect(resolveCorsOrigins()).toEqual(['http://localhost:5173', 'http://localhost:3002'])
    expect(resolvePreviewDomain()).toBeNull()
    expect(resolveHarnessRepo()).toBe('')
    expect(assistantNudgeEnabled()).toBe(false)
    expect(resolveOwnerName()).toBe('the owner')
  })

  it('a declared public URL becomes the CORS origin (no built-in domain)', () => {
    expect(resolveCorsOrigins({ CC_PUBLIC_URL: 'https://ops.example.test/app' } as NodeJS.ProcessEnv))
      .toEqual(['https://ops.example.test', 'http://localhost:5173', 'http://localhost:3002'])
  })

  it('a restart of the now-populated DB still does not pick the author defaults up', () => {
    getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('dana', 'x', 'admin')").run()
    getDb().prepare("INSERT INTO workspaces (slug, name) VALUES ('ops', 'Ops')").run()
    initDb() // second boot: the objectives table now exists, but the marker is already set
    const db = getDb()
    for (const key of Object.keys(LEGACY_INSTALL_DEFAULTS)) {
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(key), key).toBeUndefined()
    }
    const slugs = (db.prepare('SELECT slug FROM workspaces').all() as { slug: string }[]).map(r => r.slug)
    expect(slugs).toEqual(['ops'])
    expect(resolveOwnerName()).toBe('Dana')
  })
})
