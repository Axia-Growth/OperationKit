import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-preview-health-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-preview-health'

const { initDb, getDb } = await import('../db/index.js')
const { pickPreviewCanary, previewHostFor, derivePreviewStatus, PREVIEW_CANARY_PROJECT } = await import('./preview-health.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().exec('DELETE FROM objectives')
})

function insertObjective(over: {
  title?: string
  project?: string | null
  prNumber?: number | null
  status?: string
}): number {
  const info = getDb()
    .prepare(
      "INSERT INTO objectives (title, status, project, pr_number, updated_at) VALUES (?, ?, ?, ?, datetime('now', ?))",
    )
    .run(
      over.title ?? 'A PR objective',
      over.status ?? 'working',
      over.project ?? PREVIEW_CANARY_PROJECT,
      over.prNumber ?? null,
      '+0 seconds',
    )
  return Number(info.lastInsertRowid)
}

describe('pickPreviewCanary', () => {
  it('returns null when nothing is open against this repo', () => {
    expect(pickPreviewCanary(getDb())).toBeNull()
  })

  it('ignores objectives with no pr_number', () => {
    insertObjective({ prNumber: null })
    expect(pickPreviewCanary(getDb())).toBeNull()
  })

  it('ignores objectives from a different project', () => {
    insertObjective({ project: 'example-project-platform', prNumber: 42 })
    expect(pickPreviewCanary(getDb())).toBeNull()
  })

  it('ignores done/cancelled objectives', () => {
    insertObjective({ prNumber: 42, status: 'done' })
    insertObjective({ prNumber: 43, status: 'cancelled' })
    expect(pickPreviewCanary(getDb())).toBeNull()
  })

  it('picks the most recently updated eligible PR', () => {
    const olderId = insertObjective({ prNumber: 100, title: 'Older PR' })
    getDb().prepare("UPDATE objectives SET updated_at = datetime('now', '-1 hour') WHERE id = ?").run(olderId)
    const newerId = insertObjective({ prNumber: 200, title: 'Newer PR' })

    const canary = pickPreviewCanary(getDb())
    expect(canary?.objectiveId).toBe(newerId)
    expect(canary?.prNumber).toBe(200)
    expect(canary?.title).toBe('Newer PR')
  })
})

describe('previewHostFor', () => {
  // obj 900803: no built-in preview domain — CC_PREVIEW_DOMAIN env → settings → none.
  afterAll(() => { delete process.env.CC_PREVIEW_DOMAIN })

  it('builds the pr-N hostname under the configured preview domain', () => {
    process.env.CC_PREVIEW_DOMAIN = 'preview.example.test'
    expect(previewHostFor(586)).toBe('pr-586.preview.example.test')
  })

  it('reads the domain from settings when the env does not set it', () => {
    delete process.env.CC_PREVIEW_DOMAIN
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('install_preview_domain', 'ops.example.test')").run()
    expect(previewHostFor(7)).toBe('pr-7.ops.example.test')
    getDb().prepare("DELETE FROM settings WHERE key = 'install_preview_domain'").run()
  })

  it('is null when this install has no preview domain (fresh install)', () => {
    delete process.env.CC_PREVIEW_DOMAIN
    expect(previewHostFor(586)).toBeNull()
  })
})

describe('derivePreviewStatus', () => {
  const canary = { objectiveId: 1, prNumber: 586, title: 'x', updatedAt: 'now' }

  it('is unknown with no canary', () => {
    expect(derivePreviewStatus(null, { ok: true, httpCode: 200, ms: 10, error: null })).toBe('unknown')
  })

  it('is unknown with no probe result', () => {
    expect(derivePreviewStatus(canary, null)).toBe('unknown')
  })

  it('is up when the probe succeeds', () => {
    expect(derivePreviewStatus(canary, { ok: true, httpCode: 200, ms: 10, error: null })).toBe('up')
  })

  it('is down when the probe fails (TLS error or non-2xx)', () => {
    expect(derivePreviewStatus(canary, { ok: false, httpCode: null, ms: null, error: 'tlsv1 alert internal error' })).toBe(
      'down',
    )
  })
})
