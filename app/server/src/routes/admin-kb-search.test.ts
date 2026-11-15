/**
 * obj 900816 — /api/admin/kb-search (provider settings, status, backfill) and the
 * `mode` param on /api/docs/search.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt'

const TMP_DB = path.join(os.tmpdir(), `cc-kb-search-${process.pid}-${Date.now()}.db`)
const KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kb-search-root-'))
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-kb-search-xx'
process.env.SECOND_BRAIN_ROOT = KB

const { initDb, getDb } = await import('../db/index.js')
const { default: adminKbRouter } = await import('./admin-kb-search.js')
const { default: docsRouter } = await import('./docs.js')
const { setProviderOverride } = await import('../services/kb-semantic/service.js')

let server: http.Server
let baseUrl: string
let cookie: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', bcrypt.hashSync('pw', 4), 'admin')
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin', adminKbRouter)
  app.use('/api/docs', docsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  setProviderOverride(undefined)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  fs.rmSync(KB, { recursive: true, force: true })
})

const put = (body: unknown) => fetch(`${baseUrl}/api/admin/kb-search/settings`, {
  method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

describe('GET /api/admin/kb-search', () => {
  it('reports the local offline default, index stats and no job yet', async () => {
    const res = await fetch(`${baseUrl}/api/admin/kb-search`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, any>
    expect(body.config).toMatchObject({ provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, model_id: 'local:Xenova/all-MiniLM-L6-v2:384' })
    expect(body.index).toMatchObject({ docs: 0, chunks: 0 })
    expect(body.job).toBeNull()
    expect(body.providers.openai.apiKeySecret).toBe('OPENAI_API_KEY')
  })
})

describe('PUT /api/admin/kb-search/settings', () => {
  it('rejects an unknown provider', async () => {
    expect((await put({ provider: 'pinecone' })).status).toBe(400)
  })

  it('takes a secret NAME and refuses something shaped like a pasted key', async () => {
    const pasted = ['sk', 'proj', 'A'.repeat(40)].join('-')
    const bad = await put({ provider: 'openai', api_key_secret: pasted })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).not.toContain(pasted)
    expect((await put({ provider: 'openai', base_url: 'ftp://x' })).status).toBe(400)
    expect((await put({ provider: 'openai', dimensions: 'lots' })).status).toBe(400)
  })

  it('saves an API provider; status shows the key NAME and a boolean, never a value', async () => {
    process.env.KB_TEST_EMBED_KEY = 'value-that-must-not-leak'
    const res = await put({ provider: 'openai', model: 'text-embedding-3-small', base_url: 'https://example.invalid/v1', api_key_secret: 'KB_TEST_EMBED_KEY', dimensions: 256 })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('value-that-must-not-leak')
    const body = JSON.parse(text)
    expect(body.config).toMatchObject({ provider: 'openai', api_key_secret: 'KB_TEST_EMBED_KEY', api_key_configured: true, dimensions: 256 })
    delete process.env.KB_TEST_EMBED_KEY
    const after = await (await fetch(`${baseUrl}/api/admin/kb-search`, { headers: { Cookie: cookie } })).json() as Record<string, any>
    expect(after.config.api_key_configured).toBe(false)
    expect(after.availability).toMatchObject({ available: false })
    expect(after.availability.reason).toContain('KB_TEST_EMBED_KEY')
  })

  it('can switch semantic search off and back to local', async () => {
    const off = await (await put({ provider: 'off' })).json() as Record<string, any>
    expect(off.config.provider).toBe('off')
    expect(off.availability.available).toBe(false)
    const local = await (await put({ provider: 'local' })).json() as Record<string, any>
    expect(local.config.provider).toBe('local')
  })
})

describe('POST /api/admin/kb-search/backfill + cancel', () => {
  it('runs a backfill job and records it', async () => {
    setProviderOverride({
      config: { provider: 'local', model: 'test', baseUrl: '', apiKeySecret: '', dimensions: 4 },
      modelId: 'test:route:4',
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    })
    fs.writeFileSync(path.join(KB, 'note.md'), '# Note\nhello world')
    const res = await fetch(`${baseUrl}/api/admin/kb-search/backfill`, { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(202)
    let job: Record<string, any> | null = null
    for (let i = 0; i < 50; i++) {
      const s = await (await fetch(`${baseUrl}/api/admin/kb-search`, { headers: { Cookie: cookie } })).json() as Record<string, any>
      job = s.job
      if (job && job.status !== 'running') break
      await new Promise(r => setTimeout(r, 20))
    }
    expect(job).toMatchObject({ status: 'done', total: 1, embedded: 1, trigger: 'manual' })
    const cancel = await (await fetch(`${baseUrl}/api/admin/kb-search/cancel`, { method: 'POST', headers: { Cookie: cookie } })).json() as Record<string, any>
    expect(cancel.cancelled).toBe(false)
  })
})

describe('GET /api/docs/search mode', () => {
  it('rejects an unknown mode', async () => {
    const res = await fetch(`${baseUrl}/api/docs/search?q=hello&mode=vector`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(400)
  })

  it('returns mode, mode_used and scored hits', async () => {
    const res = await fetch(`${baseUrl}/api/docs/search?q=hello&mode=hybrid`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, any>
    expect(body.mode).toBe('hybrid')
    expect(['hybrid', 'keyword']).toContain(body.mode_used)
    expect(body.results[0]).toMatchObject({ path: path.join(fs.realpathSync(KB), 'note.md') })
    expect(typeof body.results[0].score).toBe('number')
  })
})
