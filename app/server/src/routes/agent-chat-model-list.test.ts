// One model list for every picker (obj 900863). Proves over HTTP, on a fresh DB
// that ran the real initDb seed, that the bot list's `models` (which every
// bot's "Default model" dropdown renders) is exactly the enabled registry that
// GET /api/models hands the card modal — same rows, same order — so no bot sees
// a provider-specific or stale subset, and a model switched off in
// Settings → Models disappears from every bot at once.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-model-list-900863-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-modellist-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-modellist-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: agentChat } = await import('./agent-chat.js')
const { default: models } = await import('./models.js')
const { setModelEnabled } = await import('../services/model-registry.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string

async function get(p: string, role = 'admin') {
  const token = jwt.sign({ id: 1, username: 'user1', role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const res = await fetch(`${baseUrl}${p}`, { headers: { Cookie: `token=${token}` } })
  return { status: res.status, json: (await res.json()) as Loose }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  for (const [slug, file] of [['operation-kit-dev', 'name: Operation Kit Dev\nmodel: claude-opus-5\nsystem_prompt: Dev.\n'], ['cto', 'name: CTO\nsystem_prompt: CTO.\n'], ['grokker', 'name: Grokker\nprovider: xai\nsystem_prompt: X.\n']]) {
    fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
    fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), file)
  }
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', agentChat)
  app.use('/api/models', models)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

describe('bot model list = the model registry (obj 900863)', () => {
  it('GET /agents carries the same enabled rows as GET /api/models, across every provider', async () => {
    const bots = await get('/api/agent-chat/agents')
    const registry = await get('/api/models')
    expect(bots.status).toBe(200)
    expect(registry.status).toBe(200)
    expect(bots.json.models.length).toBeGreaterThan(2)
    expect(bots.json.models).toEqual(registry.json.models)
    const engines = new Set((bots.json.models as Loose[]).map(m => m.engine))
    expect(engines.has('claude')).toBe(true)
    expect(engines.size).toBeGreaterThan(1) // not a Claude-only (or Opus-only) subset
    expect((bots.json.models as Loose[]).map(m => m.id)).toContain('claude-fable-5-2')
    // One install-wide list: the bots differ in model/provider, the list does not.
    expect((bots.json.agents as Loose[]).map(a => a.slug).sort()).toEqual(['cto', 'grokker', 'operation-kit-dev'])
  })

  it('is readable by a member too (the bot page is not admin-only)', async () => {
    const r = await get('/api/agent-chat/agents', 'member')
    expect(r.status).toBe(200)
    expect(r.json.models).toEqual((await get('/api/models', 'member')).json.models)
  })

  it('a model switched off in Settings → Models leaves every bot picker at once', async () => {
    const before = (await get('/api/agent-chat/agents')).json.models as Loose[]
    const victim = before.find(m => !m.is_default && !m.is_planner)!
    setModelEnabled(victim.id, false)
    try {
      const after = (await get('/api/agent-chat/agents')).json.models as Loose[]
      expect(after.map(m => m.id)).not.toContain(victim.id)
      expect(after).toEqual((await get('/api/models')).json.models)
    } finally {
      setModelEnabled(victim.id, true)
    }
  })
})
