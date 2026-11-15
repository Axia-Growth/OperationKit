/**
 * obj 900948 (model defaults) — chat-filed cards were inserted with no model and
 * took the objectives.model column default 'claude-opus-4-8', while the registry
 * default was Opus 5.5 (#900940, #900936 ran on Opus 4.8 because of it).
 *
 * Real DB (temp file), real chat tool + registry. No network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

const TMP_DB = path.join(os.tmpdir(), `cc-chat-card-model-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-chat-card-model-xxxx'

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { grantBotWorkspace } = await import('../services/agent-chat/bot-workspaces.js')
const { runTool, chatCardModel } = await import('../services/agent-chat/tools.js')
const { workspaceFor } = await import('../services/agent-chat/engine.js')
const { parseAgentText, BUILTIN_DIR } = await import('../services/agent-chat/agent-defs.js')
const { getDefaultModelId, defaultModelIdIn, setDefaultModel, setModelEnabled } = await import('../services/model-registry.js')
const { SEED_DEFAULT_MODEL_ID } = await import('../lib/claude-model-catalog.js')
const { ensureAnchorCard } = await import('../services/kb-setup/questions.js')
type Agent = import('../services/agent-chat/agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const OK = 'operationkit'
const POOL = ['general', 'cto', 'coo', 'cfo', 'kb-librarian']
const DEV = 'operation-kit-dev'
const RETIRED = 'claude-opus-4-8'

const modelOf = (id: number) => (getDb().prepare('SELECT model FROM objectives WHERE id = ?').get(id) as { model: string }).model

function bot(over: Partial<Agent>): Agent {
  const file = path.join(BUILTIN_DIR, DEV, 'agent.md')
  const parsed = parseAgentText(fs.readFileSync(file, 'utf8'), file, DEV, 'builtin')
  if (!parsed.agent) throw new Error(`built-in ${DEV} did not parse`)
  return { ...parsed.agent, ...over }
}

const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-card-model-kb-'))
let n = 0
function fileCard(a: Agent): number {
  grantBotWorkspace(a.slug, OK, 'admin')
  const ctx = { userId: ADMIN, username: 'admin', workspace: workspaceFor(ADMIN, a.slug), agent: a, kbRoot: kb, connectors: { mail: null, calendar: null } }
  const out = runTool(ctx as Loose, 'create_objective', { title: `Card ${++n}`, description: `body ${n}` })
  return out.objective_id!
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO settings (key, value) VALUES ('duplicate_guard_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`).run()
  createWorkspace({ slug: OK, name: 'Operation Kit', default_agent_pool: POOL })
})

afterAll(() => {
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(kb, { recursive: true, force: true })
})

beforeEach(() => {
  // Every test starts on the seeded registry default.
  setDefaultModel(SEED_DEFAULT_MODEL_ID)
})

describe('chat create_objective: the card runs on the filing bot\'s model, else the registry default', () => {
  it('a fresh registry defaults to the seed default, not the retired Opus 4.8', () => {
    expect(getDefaultModelId()).toBe(SEED_DEFAULT_MODEL_ID)
    expect(getDefaultModelId()).not.toBe(RETIRED)
  })

  it('bot with an enabled board model → the card gets the bot\'s model (unregistered bot path)', () => {
    const id = fileCard(bot({ slug: 'dev-sonnet', name: 'Dev Sonnet', model: 'claude-sonnet-5' }))
    expect(modelOf(id)).toBe('claude-sonnet-5')
  })

  it('bot with an enabled board model → the card gets the bot\'s model (registered bot-job path)', () => {
    const id = fileCard(bot({ slug: 'your-org-cfo', name: 'CFO', model: 'claude-sonnet-5' }))
    expect(getDb().prepare('SELECT owner_bot FROM objectives WHERE id = ?').get(id)).toEqual({ owner_bot: 'Grok: CFO' })
    expect(modelOf(id)).toBe('claude-sonnet-5')
  })

  it('bot with no model → the registry default (both paths)', () => {
    expect(modelOf(fileCard(bot({ slug: 'dev-nomodel', name: 'Dev No Model', model: null })))).toBe(SEED_DEFAULT_MODEL_ID)
    expect(modelOf(fileCard(bot({ slug: 'your-org-cfo', name: 'CFO', model: null })))).toBe(SEED_DEFAULT_MODEL_ID)
  })

  it('bot with a chat-only or disabled model → the registry default', () => {
    expect(modelOf(fileCard(bot({ slug: 'dev-gpt', name: 'Dev GPT', model: 'gpt-5' })))).toBe(SEED_DEFAULT_MODEL_ID)
    setModelEnabled('claude-sonnet-5', false)
    try {
      expect(modelOf(fileCard(bot({ slug: 'dev-off', name: 'Dev Off', model: 'claude-sonnet-5' })))).toBe(SEED_DEFAULT_MODEL_ID)
    } finally {
      setModelEnabled('claude-sonnet-5', true)
    }
  })

  it('changing is_default changes the fallback for chat cards and for other insert paths', () => {
    setDefaultModel('claude-sonnet-5')
    expect(getDefaultModelId()).toBe('claude-sonnet-5')
    expect(chatCardModel({ model: null })).toBe('claude-sonnet-5')
    expect(modelOf(fileCard(bot({ slug: 'dev-follow', name: 'Dev Follow', model: null })))).toBe('claude-sonnet-5')
    // A non-chat insert path that used to rely on the column default.
    const anchor = ensureAnchorCard({ db: getDb(), workspace: OK, setupUrl: 'http://x', previousAnchor: null } as Loose, 1)
    expect(modelOf(anchor)).toBe('claude-sonnet-5')
  })

  it('Opus 4.8 is only ever chosen when it IS the default', () => {
    expect(modelOf(fileCard(bot({ slug: 'dev-a', name: 'Dev A', model: null })))).not.toBe(RETIRED)
    setDefaultModel(RETIRED)
    expect(getDefaultModelId()).toBe(RETIRED)
    expect(modelOf(fileCard(bot({ slug: 'dev-b', name: 'Dev B', model: null })))).toBe(RETIRED)
  })

  it('existing cards keep their model when the default changes', () => {
    const id = fileCard(bot({ slug: 'dev-keep', name: 'Dev Keep', model: null }))
    setDefaultModel('claude-sonnet-5')
    expect(modelOf(id)).toBe(SEED_DEFAULT_MODEL_ID)
  })
})

describe('registry fallback floor has no retired literal', () => {
  it('no default row → first enabled Claude row; no models table → seed default', () => {
    const db = new Database(':memory:')
    expect(defaultModelIdIn(db)).toBe(SEED_DEFAULT_MODEL_ID)
    db.exec(`CREATE TABLE models (id TEXT PRIMARY KEY, engine TEXT, enabled INTEGER, is_default INTEGER, sort_order INTEGER)`)
    db.exec(`INSERT INTO models VALUES ('${RETIRED}', 'claude', 1, 0, 10), ('claude-sonnet-5', 'claude', 1, 0, 2), ('gpt-5.5', 'codex', 1, 0, 1)`)
    expect(defaultModelIdIn(db)).toBe('claude-sonnet-5')
    db.exec(`UPDATE models SET is_default = 1 WHERE id = 'gpt-5.5'`)
    expect(defaultModelIdIn(db)).toBe('gpt-5.5')
    db.close()
  })

  it('a brand-new DB\'s objectives.model column default is the seed default, not Opus 4.8', () => {
    const col = (getDb().prepare('PRAGMA table_info(objectives)').all() as { name: string; dflt_value: string | null }[]).find(c => c.name === 'model')
    expect(col?.dflt_value).toBe(`'${SEED_DEFAULT_MODEL_ID}'`)
  })
})
