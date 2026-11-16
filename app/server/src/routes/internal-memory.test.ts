import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express, { Router } from 'express'

// obj 900955 — a sandboxed card has no mount of its objective-memory folder, so it
// writes ARTIFACT.md, its scratch and live/ files through
// PUT /api/internal/objectives/:id/memory/file with its OWN session token.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-internal-memory-'))
const MEM = path.join(TMP, 'memory')
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-internal-memory'
process.env.TRANSCRIPT_DIR = TMP
process.env.OBJECTIVE_MEMORY_ROOT = MEM

const { getDb, initDb } = await import('../db/index.js')
const { registerInternalMemoryRoutes } = await import('./internal-memory.js')
const { registerInternalProgressRoutes } = await import('./internal-progress.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { MAX_WRITE_BYTES } = await import('../services/live-artifacts.js')

let server: http.Server
let baseUrl: string
let card: number
let other: number
let token: string
let otherToken: string

function insertCard(title: string): number {
  return Number(
    getDb().prepare("INSERT INTO objectives (title, workspace, status) VALUES (?, 'ws-a', 'working')").run(title).lastInsertRowid,
  )
}

async function call(p: string, init: RequestInit = {}, tok?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (tok) headers['X-CC-Session-Token'] = tok
  const res = await fetch(`${baseUrl}/api/internal${p}`, { ...init, headers })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function put(id: number, body: unknown, tok?: string) {
  return call(`/objectives/${id}/memory/file`, { method: 'PUT', body: JSON.stringify(body) }, tok)
}

function outside(): string[] {
  return fs.readdirSync(TMP).filter(n => n !== 'memory' && !n.startsWith('db.sqlite'))
}

beforeAll(async () => {
  initDb()
  card = insertCard('sandboxed card')
  other = insertCard('another card')
  token = mintSessionToken({ objectiveId: card, workspace: 'ws-a', actingUserId: null })
  otherToken = mintSessionToken({ objectiveId: other, workspace: 'ws-a', actingUserId: null })

  const router = Router()
  registerInternalProgressRoutes(router)
  registerInternalMemoryRoutes(router)
  const app = express()
  app.use(express.json({ limit: '2mb' })) // same limit as index.ts
  app.use('/api/internal', router)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('PUT /api/internal/objectives/:id/memory/file', () => {
  it("the card's own token writes ARTIFACT.md, and the existing artifacts route reads it back", async () => {
    const w = await put(card, { path: 'ARTIFACT.md', content: '# Delivered\nPR 1\n' }, token)
    expect(w.status).toBe(200)
    expect(w.json).toMatchObject({ ok: true, objective_id: card, path: 'ARTIFACT.md', size: 17 })
    expect(fs.readFileSync(path.join(MEM, String(card), 'ARTIFACT.md'), 'utf8')).toBe('# Delivered\nPR 1\n')

    const r = await call(`/objectives/${card}/artifacts/file?path=ARTIFACT.md`)
    expect(r.status).toBe(200)
    expect(r.json.content).toBe('# Delivered\nPR 1\n')
  })

  it('a second write replaces the file and leaves no temp file behind', async () => {
    expect((await put(card, { path: 'ARTIFACT.md', content: 'v2\n' }, token)).status).toBe(200)
    expect(fs.readFileSync(path.join(MEM, String(card), 'ARTIFACT.md'), 'utf8')).toBe('v2\n')
    expect(fs.readdirSync(path.join(MEM, String(card)))).toEqual(['ARTIFACT.md'])
  })

  it('writes a live/ file that the artifacts listing shows', async () => {
    expect((await put(card, { path: 'live/partial.csv', content: 'a,b\n1,2\n' }, token)).status).toBe(200)
    const list = await call(`/objectives/${card}/artifacts`)
    expect(list.json.entries.map((e: { path: string }) => e.path)).toEqual(['ARTIFACT.md', 'live/partial.csv'])
  })

  it('writes the scratch file; only the owning token reads it back, and the artifacts route still masks it', async () => {
    expect((await put(card, { path: 'NOTES.md', content: 'restart state\n' }, token)).status).toBe(200)
    const own = await call(`/objectives/${card}/memory/file?path=NOTES.md`, {}, token)
    expect(own.status).toBe(200)
    expect(own.json.content).toBe('restart state\n')
    expect((await call(`/objectives/${card}/memory/file?path=NOTES.md`, {}, otherToken)).status).toBe(403)
    expect((await call(`/objectives/${card}/memory/file?path=NOTES.md`)).status).toBe(401)
    expect((await call(`/objectives/${card}/artifacts/file?path=NOTES.md`)).status).toBe(403)
    const list = await call(`/objectives/${card}/artifacts`)
    expect(list.json.entries.map((e: { path: string }) => e.path)).not.toContain('NOTES.md')
  })

  it("another card's token is a 403 and writes nothing", async () => {
    const r = await put(card, { path: 'ARTIFACT.md', content: 'hijacked' }, otherToken)
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('not_own_card')
    expect(fs.readFileSync(path.join(MEM, String(card), 'ARTIFACT.md'), 'utf8')).toBe('v2\n')
  })

  it('no token is a 401 even from localhost, and a bad token is a 401', async () => {
    expect((await put(card, { path: 'ARTIFACT.md', content: 'x' })).status).toBe(401)
    expect((await put(card, { path: 'ARTIFACT.md', content: 'x' }, 'ccs_forged.sig')).status).toBe(401)
    expect(fs.readFileSync(path.join(MEM, String(card), 'ARTIFACT.md'), 'utf8')).toBe('v2\n')
  })

  it.each([
    '../x',
    'NOTES.md/../../x',
    'live/../../x',
    'live/../ARTIFACT.md',
    '/etc/passwd',
    'live/a/b',
    'live/.hidden',
    'live/',
    'live\\x',
    './ARTIFACT.md',
    'ARTIFACT-W1.md',
    'work/out.txt',
    '',
  ])('path %j is a 400 and nothing is written outside the card folder', async p => {
    const r = await put(card, { path: p, content: 'x' }, token)
    expect(r.status).toBe(400)
    expect(outside()).toEqual([])
    expect(fs.readdirSync(MEM)).toEqual([String(card)])
  })

  it('non-string or binary content is a 400', async () => {
    expect((await put(card, { path: 'ARTIFACT.md', content: { a: 1 } }, token)).status).toBe(400)
    expect((await put(card, { path: 'ARTIFACT.md', content: 'a\u0000b' }, token)).status).toBe(400)
    expect((await put(card, { path: 'ARTIFACT.md' }, token)).status).toBe(400)
  })

  it('content over the size cap is a 413; content at the cap is accepted', async () => {
    const over = await put(card, { path: 'live/big.txt', content: 'x'.repeat(MAX_WRITE_BYTES + 1) }, token)
    expect(over.status).toBe(413)
    expect(fs.existsSync(path.join(MEM, String(card), 'live', 'big.txt'))).toBe(false)
    const at = await put(card, { path: 'live/big.txt', content: 'x'.repeat(MAX_WRITE_BYTES) }, token)
    expect(at.status).toBe(200)
  })

  it('never follows a symlink: a linked live/ folder or a linked target is refused', async () => {
    const elsewhere = path.join(TMP, 'elsewhere')
    fs.mkdirSync(elsewhere)
    const dir = path.join(MEM, String(other))
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(elsewhere, path.join(dir, 'live'))
    fs.symlinkSync(path.join(elsewhere, 'target.md'), path.join(dir, 'ARTIFACT.md'))
    expect((await put(other, { path: 'live/x.txt', content: 'x' }, otherToken)).status).toBe(400)
    expect((await put(other, { path: 'ARTIFACT.md', content: 'x' }, otherToken)).status).toBe(400)
    expect(fs.readdirSync(elsewhere)).toEqual([])
    fs.rmSync(elsewhere, { recursive: true })
  })
})
