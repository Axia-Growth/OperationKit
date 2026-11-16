// obj 900957 (audit finding 3). POST /api/internal/objectives accepts owner_bot.
//
// Before: the route refused owner_bot as an unsupported field, so a card filed
// by a High Agency wake (or by a card session on a bot's behalf) could not be
// owned by that bot. The wake brief put the bot's slug in agent_context instead,
// which the workspace agent-pool gate refuses when the pool does not list it.
//
// Proved here, over the real express route:
//   - owner_bot is stored and returned (registry bot, chat bot by name or slug)
//   - absent / null / blank = unowned, as on the public route
//   - a name no bot answers to is a 400 that lists the known bots; nothing is written
//   - a bad shape is the shared validateOwnerBot error
//   - a pooled workspace + a wake-linked item with the wake's bot as owner is
//     accepted and worked by the workspace's normal agent
//   - a wake cannot name ANOTHER bot as the owner

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-create-owner-bot-test-${process.pid}-${Date.now()}.db`)
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-create-owner-bot-agents-'))
process.env.DB_PATH = TMP_DB
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { grantBotWorkspace } = await import('../services/agent-chat/bot-workspaces.js')
const { buildHighAgencyBrief } = await import('../services/agent-chat/high-agency.js')

const POOLED = 'pooled-co'
let server: http.Server
let baseUrl: string
let wakeCard = 0

async function create(items: unknown[]) {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

type Row = { owner_bot: string | null; agent_context: string; workspace: string; source_job_id: number | null }
const rowOf = (id: number) =>
  getDb().prepare('SELECT owner_bot, agent_context, workspace, source_job_id FROM objectives WHERE id = ?').get(id) as Row
const first = (json: Record<string, unknown>) => (json.objectives as Array<{ id: number; title: string; owner_bot?: string }>)[0]
const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n

function writeBot(slug: string, yaml: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), yaml)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  // Two chat bots that are NOT in the bot registry.
  writeBot('ops-lead', 'name: Ops Lead\nsystem_prompt: You own operations.\n')
  writeBot('sdr', 'name: SDR\nsystem_prompt: You own outbound pipeline.\n')
  // A workspace whose agent pool does NOT list the bot.
  createWorkspace({ slug: POOLED, name: 'Pooled Co', default_agent_pool: ['general'] })
  grantBotWorkspace('ops-lead', POOLED, 'test')
  grantBotWorkspace('sdr', POOLED, 'test')
  // The ops-lead bot's High Agency wake card: a card fired by its wake routine.
  const routine = db
    .prepare(`INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth) VALUES ('high-agency:ops-lead', '5 7 * * *', '{}', 1, 1)`)
    .run()
  wakeCard = Number(
    db
      .prepare(`INSERT INTO objectives (title, description, agent_context, workspace, routine_id, status) VALUES ('High Agency wake', '', 'ops-lead', ?, ?, 'working')`)
      .run(POOLED, routine.lastInsertRowid).lastInsertRowid,
  )

  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const addr = server.address()
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      resolve()
    })
  })
})

afterAll(() => {
  try { server?.close() } catch { /* ignore */ }
  try { getDb().close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${TMP_DB}${suffix}`, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

describe('POST /api/internal/objectives: owner_bot is stored and returned', () => {
  it('a registry bot: stored trimmed, returned on the created item and on the card', async () => {
    const r = await create([{ title: 'Owned by a registry bot', owner_bot: '  Operation Kit  ' }])
    expect(r.status).toBe(201)
    expect(first(r.json).owner_bot).toBe('Operation Kit')
    expect(rowOf(first(r.json).id).owner_bot).toBe('Operation Kit')
    const got = await fetch(`${baseUrl}/api/internal/objectives/${first(r.json).id}`)
    expect(((await got.json()) as { owner_bot: string }).owner_bot).toBe('Operation Kit')
  })

  it('a chat bot installed here, by name or by slug', async () => {
    const byName = await create([{ title: 'Owned by a chat bot (name)', owner_bot: 'Ops Lead' }])
    expect(byName.status).toBe(201)
    expect(rowOf(first(byName.json).id).owner_bot).toBe('Ops Lead')
    const bySlug = await create([{ title: 'Owned by a chat bot (slug)', owner_bot: 'ops-lead' }])
    expect(bySlug.status).toBe(201)
    expect(rowOf(first(bySlug.json).id).owner_bot).toBe('ops-lead')
  })

  it('absent, null or blank leaves the card unowned and adds nothing to the response item', async () => {
    const r = await create([
      { title: 'No owner field' },
      { title: 'Null owner', owner_bot: null },
      { title: 'Blank owner', owner_bot: '   ' },
    ])
    expect(r.status).toBe(201)
    for (const o of r.json.objectives as Array<{ id: number; owner_bot?: string }>) {
      expect(o).not.toHaveProperty('owner_bot')
      expect(rowOf(o.id).owner_bot).toBeNull()
    }
  })
})

describe('POST /api/internal/objectives: an owner_bot it cannot honour is refused', () => {
  it('an unknown bot is a 400 that names the known bots, and the whole batch is refused', async () => {
    const before = count()
    const r = await create([{ title: 'Fine' }, { title: 'Typo owner', owner_bot: 'Ops Leed' }])
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/Item 1: Unknown owner_bot "Ops Leed"\. Known bots: /)
    expect(r.json.error).toContain('Operation Kit') // a registry bot
    expect(r.json.error).toContain('Ops Lead') // a chat bot installed here
    expect(r.json.known_bots).toEqual(expect.arrayContaining(['Operation Kit', 'Ops Lead', 'SDR']))
    expect(count()).toBe(before)
  })

  it('a bad shape is the shared validateOwnerBot error', async () => {
    const before = count()
    const notString = await create([{ title: 'Bad owner type', owner_bot: 42 }])
    expect(notString.status).toBe(400)
    expect(notString.json.error).toMatch(/owner_bot must be a string or null/)
    const unsafe = await create([{ title: 'Bad owner chars', owner_bot: '<script>' }])
    expect(unsafe.status).toBe(400)
    expect(unsafe.json.error).toMatch(/owner_bot may contain only/)
    expect(count()).toBe(before)
  })
})

describe('a High Agency wake files a card its bot owns', () => {
  it('pooled workspace + wake-linked item + the wake bot as owner: accepted, worked by the normal agent', async () => {
    const r = await create([{ title: 'Wake project', workspace: POOLED, type: 'task', owner_bot: 'Ops Lead', source_job_id: wakeCard }])
    expect(r.status).toBe(201)
    expect(rowOf(first(r.json).id)).toEqual({ owner_bot: 'Ops Lead', agent_context: 'general', workspace: POOLED, source_job_id: wakeCard })
  })

  it("the wake brief's file-your-project command is exactly that request", async () => {
    const agent = { slug: 'ops-lead', name: 'Ops Lead', description: '', system_prompt: 'You own operations.', knowledge_folders: [] as string[] }
    const brief = buildHighAgencyBrief(agent, { level: 3, workspace: POOLED, allow_cards: true, allow_workflows: false }, 'Operator')
    const cmd = brief.split('\n').find(l => l.includes("-d '[{\"title\":\"<project>\""))
    expect(cmd).toBeDefined()
    expect(cmd).toContain('"owner_bot":"Ops Lead"')
    expect(cmd).not.toContain('agent_context')
    // Run the brief's own JSON through the route, with the shell's $CC_OBJECTIVE_ID filled in.
    const json = cmd!.slice(cmd!.indexOf("'[") + 1, cmd!.lastIndexOf("]'") + 1).replace(`'"$CC_OBJECTIVE_ID"'`, String(wakeCard))
    const r = await create(JSON.parse(json))
    expect(r.status).toBe(201)
    expect(rowOf(first(r.json).id)).toEqual({ owner_bot: 'Ops Lead', agent_context: 'general', workspace: POOLED, source_job_id: wakeCard })
  })

  it('a wake cannot name another bot as the owner', async () => {
    const before = count()
    for (const other of ['SDR', 'Operation Kit']) {
      const r = await create([{ title: `Wake project for ${other}`, workspace: POOLED, owner_bot: other, source_job_id: wakeCard }])
      expect(r.status).toBe(403)
      expect(r.json.error).toMatch(/is not bot 'ops-lead'/)
    }
    expect(count()).toBe(before)
  })
})
