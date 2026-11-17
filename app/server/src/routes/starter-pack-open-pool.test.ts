import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 901196 (audit finding PA-1): an EMPTY workspace bot pool means "any bot".
// Enabling a starter pack used to write the pack's bot into it, CLOSING the
// workspace to every other bot: existing cards then failed to save with
// "Agent 'general' is not in workspace '<ws>' pool (allowed: kb-librarian)".
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pack-open-pool-'))
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.JWT_SECRET = 'test-secret-pack-open-pool'
process.env.AI_WORKSPACE_DIR = path.join(TMP, 'ai-workspace')

// A minimal pack: one bot, no setup route, no routines.
const PACKS = path.join(TMP, 'packs')
fs.mkdirSync(path.join(PACKS, 'pool-pack', 'agents'), { recursive: true })
fs.writeFileSync(path.join(PACKS, 'pool-pack', 'pack.json'), JSON.stringify({
  id: 'pool-pack', name: 'Pool pack', agents: [{ slug: 'pack-bot', label: 'Pack bot' }],
}))
fs.writeFileSync(path.join(PACKS, 'pool-pack', 'agents', 'pack-bot.md'), '# Pack bot\n')
process.env.STARTER_PACKS_DIR = PACKS

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace, getWorkspace } = await import('../services/workspaces.js')
const { enablePack } = await import('../services/starter-packs.js')
const { checkAgentInWorkspacePool } = await import('./objectives-helpers.js')
const { default: objectivesRouter } = await import('./objectives.js')

const AGENTS_DIR = path.join(TMP, 'agents')
let server: http.Server
let base: string

function adminCookie(): string {
  return `token=${jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}

async function put(id: number, body: unknown) {
  const res = await fetch(`${base}/api/objectives/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie() },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

function insertCard(workspace: string, agent: string): number {
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, description, agent_context, workspace, status, created_by)
     VALUES (?, '', ?, ?, 'queue', 1)`,
  ).run(`card in ${workspace}`, agent, workspace).lastInsertRowid)
}

beforeAll(async () => {
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`).run()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => {
  server?.close()
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('starter pack and the workspace bot pool (obj 901196)', () => {
  it('enabling a pack on an OPEN pool leaves it open, so every bot still passes', async () => {
    createWorkspace({ slug: 'open-ws', name: 'Open' })
    const res = await enablePack('pool-pack', { workspace: 'open-ws', agentsDir: AGENTS_DIR })
    expect(getWorkspace('open-ws')?.default_agent_pool).toEqual([])
    expect(res.steps.some(s => /left open/.test(s))).toBe(true)
    expect(checkAgentInWorkspacePool('open-ws', 'general')).toBeNull()
    expect(checkAgentInWorkspacePool('open-ws', 'pack-bot')).toBeNull()
  })

  it('enabling a pack on a CURATED pool adds the pack bot and keeps the rest', async () => {
    createWorkspace({ slug: 'curated-ws', name: 'Curated', default_agent_pool: ['general'] })
    await enablePack('pool-pack', { workspace: 'curated-ws', agentsDir: AGENTS_DIR })
    expect(getWorkspace('curated-ws')?.default_agent_pool).toEqual(['general', 'pack-bot'])
    expect(checkAgentInWorkspacePool('curated-ws', 'general')).toBeNull()
  })

  it('an existing card on an open-pool workspace still saves after the pack is enabled', async () => {
    createWorkspace({ slug: 'repro-ws', name: 'Repro' })
    const id = insertCard('repro-ws', 'general')
    await enablePack('pool-pack', { workspace: 'repro-ws', agentsDir: AGENTS_DIR })
    // The edit dialog re-sends workspace and agent on every save.
    const r = await put(id, { title: 'card in repro-ws', description: 'edited', workspace: 'repro-ws', agent_context: 'general' })
    expect(r.status).toBe(200)
  })

  it('a card whose bot was valid when filed stays editable after the pool is narrowed', async () => {
    // Installs where an older pack already closed the pool.
    createWorkspace({ slug: 'narrowed-ws', name: 'Narrowed' })
    const id = insertCard('narrowed-ws', 'general')
    getDb().prepare(`UPDATE workspaces SET default_agent_pool = '["pack-bot"]' WHERE slug = 'narrowed-ws'`).run()
    const { invalidateWorkspacesCache } = await import('../services/workspaces.js')
    invalidateWorkspacesCache()
    const r = await put(id, { title: 'card in narrowed-ws', description: 'edited', workspace: 'narrowed-ws', agent_context: 'general' })
    expect(r.status).toBe(200)
    expect(getDb().prepare('SELECT description FROM objectives WHERE id = ?').get(id)).toEqual({ description: 'edited' })
  })

  it('moving a card TO a bot outside a curated pool is still refused with the reason', async () => {
    const id = insertCard('narrowed-ws', 'pack-bot')
    const r = await put(id, { agent_context: 'general' })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/Agent 'general' is not in workspace 'narrowed-ws' pool \(allowed: pack-bot\)/)
  })
})
