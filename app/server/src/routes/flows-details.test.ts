// obj 900868 — Notes + Tools on a workflow.
//   1. POST /api/flows (from a goal AND from JSON) stores optional notes + tools
//   2. PATCH /api/flows/:id edits them without creating a version
//   3. GET /api/flows and GET /api/flows/:id return them
//   4. bad input is a 400; cross-workspace PATCH is a 403; an agent key needs board:write
//   5. the builder brief carries them so the builder uses the owner's tools
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { FlowDefinition } from '../../../shared/flow/types.js'
import { parseFlowDetails, splitFlowTools, readFlowTools, FLOW_TOOLS_MAX } from '../../../shared/flow/details.js'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in flows tests') } }))

const TMP_DB = path.join(os.tmpdir(), `cc-flows-details-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-flows-details'
process.env.ALERTS_ENABLED = 'false'

const { initDb, getDb } = await import('../db/index.js')
const { default: flowsRouter } = await import('./flows.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { builderBrief } = await import('../services/flow-builder.js')

const ADMIN = { id: 601, username: 'owner', role: 'admin' as const }
const MEMBER_B = { id: 603, username: 'member-b', role: 'member' as const }
type Who = typeof ADMIN | typeof MEMBER_B
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl = ''

async function call(method: string, p: string, opts: { as?: Who; bearer?: string; body?: unknown } = {}): Promise<{ status: number; json: Loose }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.as) headers.Cookie = `token=${jwt.sign(opts.as, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: unknown = text
  try { json = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, json }
}

function flowDef(ws: string, slug: string): FlowDefinition {
  return {
    apiVersion: 'okflow/1', id: slug, name: `Flow ${slug}`, workspace: ws, version: 1,
    goal: { statement: 'rows are fetched', end_condition: { assert: [{ expr: 'len(steps.fetch.output.rows) > 0' }] } },
    nodes: [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'rows-list', effect: 'read', mock: { output: { rows: [{ id: 'x' }] } }, next: 'done' },
      { id: 'done', kind: 'end' },
    ],
  } as FlowDefinition
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  for (const u of [ADMIN, MEMBER_B]) db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)").run(u.id, u.username, u.role)
  db.prepare("INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, 'ws-b')").run(MEMBER_B.id)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/flows', flowsRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  try { fs.unlinkSync(TMP_DB) } catch { /* gone */ }
})

describe('shared helpers', () => {
  it('splits typed tools on lines and commas, trims and de-duplicates case-insensitively', () => {
    expect(splitFlowTools('HubSpot, Slack\n  hubspot \n\nGoogle  Sheets')).toEqual(['HubSpot', 'Slack', 'Google Sheets'])
  })
  it('parseFlowDetails: absent = unchanged, empty clears, wrong types are refused', () => {
    expect(parseFlowDetails({})).toEqual({ ok: true, value: {} })
    expect(parseFlowDetails({ notes: '  ', tools: [] })).toEqual({ ok: true, value: { notes: null, tools: [] } })
    expect(parseFlowDetails({ notes: 5 }).ok).toBe(false)
    expect(parseFlowDetails({ tools: 'Slack' }).ok).toBe(false)
    expect(parseFlowDetails({ tools: Array.from({ length: FLOW_TOOLS_MAX + 1 }, (_, i) => `t${i}`) }).ok).toBe(false)
    expect(parseFlowDetails({ tools: ['x'.repeat(81)] }).ok).toBe(false)
  })
  it('readFlowTools never throws on a malformed column', () => {
    expect(readFlowTools(null)).toEqual([])
    expect(readFlowTools('{not json')).toEqual([])
    expect(readFlowTools('{"a":1}')).toEqual([])
    expect(readFlowTools('["Slack", 3, "slack"]')).toEqual(['Slack'])
  })
})

describe('Notes + Tools on a workflow', () => {
  it('create from a goal stores them; list and detail return them', async () => {
    const r = await call('POST', '/api/flows', {
      as: ADMIN,
      body: { workspace: 'ws-a', goal: 'Sync yesterday\'s bookings to the CRM', notes: 'Skip test bookings.', tools: ['HubSpot', 'Slack', 'hubspot'] },
    })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    expect(r.json.flow).toMatchObject({ notes: 'Skip test bookings.', tools: ['HubSpot', 'Slack'] })
    const list = await call('GET', '/api/flows?workspace=ws-a', { as: ADMIN })
    expect(list.json.flows.find((f: Loose) => f.id === r.json.flow_id)).toMatchObject({ notes: 'Skip test bookings.', tools: ['HubSpot', 'Slack'] })
    // The builder card's brief tells the builder which tools the owner wants.
    const card = getDb().prepare('SELECT description FROM objectives WHERE id = ?').get(r.json.objective_id) as { description: string }
    expect(card.description).toContain('## Notes from the owner')
    expect(card.description).toContain('Skip test bookings.')
    expect(card.description).toContain('## Tools to use')
    expect(card.description).toContain('- HubSpot')
  })

  it('a workflow with neither field reads as notes null + tools []', async () => {
    const r = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef('ws-a', 'plain') } })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    expect(r.json.flow).toMatchObject({ notes: null, tools: [] })
  })

  it('create from JSON accepts them too', async () => {
    const r = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef('ws-a', 'json-made'), notes: 'n', tools: ['Airtable'] } })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    expect(r.json.flow).toMatchObject({ notes: 'n', tools: ['Airtable'] })
  })

  it('PATCH edits only the fields sent, clears with empty values, and never creates a version', async () => {
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef('ws-a', 'patched') } })
    const id = c.json.flow_id
    const versionsBefore = (getDb().prepare('SELECT COUNT(*) AS n FROM flow_versions WHERE flow_id = ?').get(id) as { n: number }).n

    let r = await call('PATCH', `/api/flows/${id}`, { as: ADMIN, body: { notes: 'Run after the 8am import.', tools: ['Slack', 'Google Sheets'] } })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.flow).toMatchObject({ notes: 'Run after the 8am import.', tools: ['Slack', 'Google Sheets'] })

    r = await call('PATCH', `/api/flows/${id}`, { as: ADMIN, body: { tools: ['Slack'] } })
    expect(r.json.flow).toMatchObject({ notes: 'Run after the 8am import.', tools: ['Slack'] })

    const detail = await call('GET', `/api/flows/${id}`, { as: ADMIN })
    expect(detail.json.flow).toMatchObject({ notes: 'Run after the 8am import.', tools: ['Slack'] })

    r = await call('PATCH', `/api/flows/${id}`, { as: ADMIN, body: { notes: '', tools: [] } })
    expect(r.json.flow).toMatchObject({ notes: null, tools: [] })

    const versionsAfter = (getDb().prepare('SELECT COUNT(*) AS n FROM flow_versions WHERE flow_id = ?').get(id) as { n: number }).n
    expect(versionsAfter).toBe(versionsBefore)
  })

  it('PATCH refuses bad input and an empty body', async () => {
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef('ws-a', 'bad-input') } })
    const id = c.json.flow_id
    expect((await call('PATCH', `/api/flows/${id}`, { as: ADMIN, body: {} })).status).toBe(400)
    expect((await call('PATCH', `/api/flows/${id}`, { as: ADMIN, body: { tools: 'Slack' } })).status).toBe(400)
    expect((await call('PATCH', `/api/flows/${id}`, { as: ADMIN, body: { notes: 'x'.repeat(4001) } })).status).toBe(400)
    expect((await call('PATCH', '/api/flows/999999', { as: ADMIN, body: { notes: 'x' } })).status).toBe(404)
  })

  it('PATCH is workspace-filtered: a member of another workspace gets a 403', async () => {
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef('ws-a', 'cross-ws') } })
    const r = await call('PATCH', `/api/flows/${c.json.flow_id}`, { as: MEMBER_B, body: { notes: 'mine now' } })
    expect(r.status).toBe(403)
    const row = getDb().prepare('SELECT notes FROM flow_definitions WHERE id = ?').get(c.json.flow_id) as { notes: string | null }
    expect(row.notes).toBeNull()
  })

  it('an agent key needs board:write to PATCH', async () => {
    const c = await call('POST', '/api/flows', { as: ADMIN, body: { definition: flowDef('ws-a', 'agent-key') } })
    const readOnly = createAgentKey(ADMIN, { label: 'reader', scopes: ['board:read'], workspaces: ['ws-a'] })
    const writer = createAgentKey(ADMIN, { label: 'writer', scopes: ['board:read', 'board:write'], workspaces: ['ws-a'] })
    if (!readOnly.ok || !writer.ok) throw new Error('key mint failed')
    expect((await call('PATCH', `/api/flows/${c.json.flow_id}`, { bearer: readOnly.key.token, body: { notes: 'x' } })).status).toBe(403)
    const ok = await call('PATCH', `/api/flows/${c.json.flow_id}`, { bearer: writer.key.token, body: { tools: ['Notion'] } })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.flow.tools).toEqual(['Notion'])
  })

  it('the builder brief omits both sections when none were given', () => {
    const brief = builderBrief({
      flowId: 1, slug: 's', name: 'n', workspace: 'ws-a', goal: 'g', endCondition: null, maxIterations: 3,
      tools: [], okit: 'unavailable', connectors: [], flowsEnabled: true,
    })
    expect(brief).not.toContain('## Notes from the owner')
    expect(brief).not.toContain('## Tools to use')
  })
})
