// install/verify.sh check 8 used to fail on every re-run with "could not create the
// test card (409)": it posted the fixed title "Install check: say hello" and the
// board's duplicate-title guard refused the second one (cards #900022 / #900069,
// PR #628). This runs the card body that verify.sh REALLY sends (built by
// install/verify-lib.sh, in bash, exactly as verify.sh builds it) through the
// board's real guard, so a change to either side that brings the 409 back fails here.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const TMP_DB = path.join(os.tmpdir(), `cc-install-verify-card-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { findOpenDuplicate, normalizeTitle } = await import('./objective-dedupe.js')

const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../install')
const haveTools = ['bash', 'jq'].every((t) => spawnSync(t, ['--version']).status === 0)

interface CardBody { title: string; workspace: string; force: boolean; start: boolean; description: string }

/** One verify run's card body, built by install/verify-lib.sh in a fresh bash. */
function verifyCardBody(workspace: string): CardBody {
  const r = spawnSync('bash', ['-c', 'set -euo pipefail; source "$0/verify-lib.sh"; ok_verify_card_json "$1" "$(ok_verify_marker)"', INSTALL_DIR, workspace], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`verify-lib.sh failed: ${r.stderr}`)
  return JSON.parse(r.stdout) as CardBody
}

/** What POST /api/objectives does with a body (routes/objectives-crud.ts): 409 on an open twin unless force. */
function create(body: { title: string; workspace: string; force?: boolean }): number | 409 {
  const db = getDb()
  const dup = findOpenDuplicate(db, { title: body.title, workspace: body.workspace, windowHours: 24, excludeParentId: null })
  if (dup && body.force !== true) return 409
  const r = db
    .prepare(`INSERT INTO objectives (title, agent_context, workspace, status, created_at) VALUES (?, 'general', ?, 'working', datetime('now'))`)
    .run(body.title, body.workspace)
  return Number(r.lastInsertRowid)
}

describe.skipIf(!haveTools)('install/verify.sh test card vs the duplicate-title guard', () => {
  beforeAll(() => {
    if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
    initDb()
  })
  afterAll(() => {
    try { getDb().close() } catch { /* ignore */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP_DB + s)) fs.unlinkSync(TMP_DB + s)
  })
  beforeEach(() => { getDb().exec('DELETE FROM objectives') })

  it('the old fixed title is exactly what the guard refuses (the bug)', () => {
    expect(create({ title: 'Install check: say hello', workspace: 'acme' })).toBeTypeOf('number')
    expect(create({ title: 'Install check: say hello', workspace: 'acme' })).toBe(409)
  })

  it('a re-run is created while the first test card is still open', () => {
    const first = verifyCardBody('acme')
    const second = verifyCardBody('acme')
    expect(create(first)).toBeTypeOf('number')
    // Left open on purpose: a timed-out or crashed run whose card was not removed.
    expect(create(second)).toBeTypeOf('number')
  })

  it('each run is unique on its own, even without force', () => {
    const titles = Array.from({ length: 5 }, () => verifyCardBody('acme').title)
    expect(new Set(titles.map(normalizeTitle)).size).toBe(5)
    for (const title of titles) expect(create({ title, workspace: 'acme' })).toBeTypeOf('number')
  })

  it('and sends force:true as the second guard', () => {
    const body = verifyCardBody('acme')
    expect(body.force).toBe(true)
    expect(body.start).toBe(true)
    expect(body.workspace).toBe('acme')
  })
})
