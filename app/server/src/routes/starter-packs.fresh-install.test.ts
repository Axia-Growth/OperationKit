import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 901032 (audit #901024): on an install that sets no path env vars,
// POST /api/starter-packs/:id/enable answered 500
// {"error":"ENOENT: no such file or directory, mkdir '/home/operator/ai-workspace/agents'"}.
// Here: an EMPTY data directory and an EMPTY home, no path env vars at all.
const LEGACY_HOME = '/home/operator' // config.ts LEGACY_APP_HOME; asserted equal below
const SKIP = fs.existsSync(LEGACY_HOME) // an operator host resolves to it on purpose

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pack-fresh-'))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME)
const SAVED: Record<string, string | undefined> = {}
for (const k of ['HOME', 'USER_HOME', 'PROJECTS_DIR', 'AI_WORKSPACE_DIR', 'SECOND_BRAIN_DIR', 'TRANSCRIPT_DIR', 'ASSISTANT_DIR']) {
  SAVED[k] = process.env[k]
  delete process.env[k]
}
process.env.HOME = HOME
process.env.DB_PATH = path.join(TMP, 'data', 'test.db')
fs.mkdirSync(path.dirname(process.env.DB_PATH))
process.env.JWT_SECRET = 'test-secret-pack-fresh-install'

const PACKS = path.join(TMP, 'packs')
fs.mkdirSync(path.join(PACKS, 'fresh-pack', 'agents'), { recursive: true })
fs.writeFileSync(path.join(PACKS, 'fresh-pack', 'pack.json'), JSON.stringify({
  id: 'fresh-pack', name: 'Fresh pack', agents: [{ slug: 'fresh-bot', label: 'Fresh bot' }],
}))
fs.writeFileSync(path.join(PACKS, 'fresh-pack', 'agents', 'fresh-bot.md'), '# Fresh bot\n')
process.env.STARTER_PACKS_DIR = PACKS

const cfg = await import('../config.js')
const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { settingKey } = await import('../services/starter-packs.js')
const { default: starterPacksRouter } = await import('./starter-packs.js')

const packOn = () => (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(settingKey('fresh-pack')) as { value?: string } | undefined)?.value

let server: http.Server
let base: string
const cookie = () => `token=${jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function enable(workspace: string) {
  const res = await fetch(`${base}/api/starter-packs/fresh-pack/enable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie() },
    body: JSON.stringify({ workspace }),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

beforeAll(async () => {
  if (SKIP) return
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`).run()
  createWorkspace({ slug: 'e2e-ws', name: 'E2E' })
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/starter-packs', starterPacksRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => {
  server?.close()
  try { getDb().close() } catch { /* not opened */ }
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe.skipIf(SKIP)('enabling a starter pack on a fresh install (obj 901032)', () => {
  it('the config defaults point into this install, not at another person\'s home', () => {
    expect(cfg.LEGACY_APP_HOME).toBe(LEGACY_HOME)
    expect(cfg.AGENTS_DIR).toBe(path.join(HOME, 'ai-workspace', 'agents'))
    expect(fs.existsSync(path.join(HOME, 'ai-workspace'))).toBe(false) // empty home: nothing made yet
  })

  it('a folder the server cannot make is a plain-language 500, never a raw ENOENT/ENOTDIR', async () => {
    // A FILE where the ai-workspace folder should be: mkdir of its agents folder fails.
    fs.writeFileSync(path.join(HOME, 'ai-workspace'), 'not a folder')
    try {
      const { status, json } = await enable('e2e-ws')
      expect(status).toBe(500)
      const msg = String(json.error)
      expect(msg).toMatch(/^Could not save the Fresh bot bot into its folder/)
      expect(msg).toMatch(/AI_WORKSPACE_DIR/)
      expect(msg).not.toMatch(/ENOENT|ENOTDIR|EEXIST|mkdir|no such file/)
      expect(packOn()).not.toBe('1') // never shows as on
    } finally {
      fs.rmSync(path.join(HOME, 'ai-workspace'), { force: true })
    }
  })

  it('returns 200 and creates the agents folder and the bot file', async () => {
    const { status, json } = await enable('e2e-ws')
    expect(status).toBe(200)
    expect(json.steps).toContain('copied agent persona fresh-bot.md')
    expect(fs.readFileSync(path.join(HOME, 'ai-workspace', 'agents', 'fresh-bot.md'), 'utf8')).toBe('# Fresh bot\n')
    expect(packOn()).toBe('1')
  })
})
