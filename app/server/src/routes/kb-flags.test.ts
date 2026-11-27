import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Knowledge-gap flags (obj 901767), end to end over real SQLite + real HTTP:
// a worker files with its session token, a person/agent files with login,
// the queue lists them oldest first, the same defect dedupes, only a person
// closes one — and filing never changes a page in the knowledge base.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kbflags-'))
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.JWT_SECRET = 'test-secret-kbflags'
process.env.AI_WORKSPACE_DIR = path.join(TMP, 'ai-workspace')
const KB = path.join(TMP, 'kb')

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { default: kbFlagsRouter } = await import('./kb-flags.js')
const { runTool, toolSpecsFor } = await import('../services/agent-chat/tools.js')
const { listKbFlags } = await import('../services/kb-wiki/flags.js')
const { requiredScope } = await import('../middleware/agent-key-guard.js')
const { buildKbFlagBlock } = await import('../services/kb-flag-prompt.js')

const WS = 'fernleaf'
const OTHER = 'otherws'
const PAGE = 'organizations/acme.md'
let server: http.Server
let base: string
let cardId = 0
let otherWsCard = 0
let sameWsCard2 = 0

const cookie = (role: 'admin' | 'member', id: number) => `token=${jwt.sign({ id, username: `u${id}`, role }, 'test-secret-kbflags', { expiresIn: '1h' })}`
const ADMIN = cookie('admin', 1)
const MEMBER = cookie('member', 2)
const OUTSIDER = cookie('member', 99)
const worker = (objectiveId: number, workspace = WS, readOnly = false) => mintSessionToken({ objectiveId, workspace, actingUserId: 1, ...(readOnly ? { readOnly } : {}) })

type Res<T = Record<string, unknown>> = { status: number; body: T }
async function call<T = Record<string, unknown>>(method: string, url: string, body: unknown, headers: Record<string, string>): Promise<Res<T>> {
  const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json() as T }
}
const asCookie = (c: string) => ({ cookie: c })
const asToken = (t: string) => ({ 'X-CC-Session-Token': t })

function kbHash(): string {
  const h = crypto.createHash('sha256')
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else h.update(abs).update(fs.readFileSync(abs))
    }
  }
  walk(KB)
  return h.digest('hex')
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  createWorkspace({ slug: WS, name: 'Fernleaf', vault_path: KB })
  createWorkspace({ slug: OTHER, name: 'Other', vault_path: path.join(TMP, 'kb2') })
  db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'u1', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'u2', 'x', 'member')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(99, 'u99', 'x', 'member')
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (2, ?, 'member')`).run(WS)
  const ins = db.prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES (?, 'general', ?, 1, 'working')`)
  cardId = Number(ins.run('Write the Acme proposal', WS).lastInsertRowid)
  sameWsCard2 = Number(ins.run('Another card', WS).lastInsertRowid)
  otherWsCard = Number(ins.run('Elsewhere', OTHER).lastInsertRowid)

  fs.mkdirSync(path.join(KB, 'organizations'), { recursive: true })
  fs.writeFileSync(path.join(KB, PAGE), '---\ntitle: Acme\n---\n# Acme\n\nBilling contact: Dana.\n')

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/kb-wiki/flags', kbFlagsRouter)
  await new Promise<void>(r => { server = app.listen(0, () => r()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('knowledge-gap flags (obj 901767)', () => {
  it('a worker files a flag mid-task with its session token; workspace and card come from the token; no page changes', async () => {
    const before = kbHash()
    const r = await call<{ flag: Record<string, unknown>; reused: boolean }>('POST', '/api/kb-wiki/flags', {
      kind: 'wrong', subject: 'Acme billing contact', page: PAGE,
      detail: 'Page says Dana; the latest invoice thread is signed by Lee.', suggested_fix: 'Billing contact: Lee Park',
    }, asToken(worker(cardId)))
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.reused).toBe(false)
    expect(r.body.flag).toMatchObject({
      workspace: WS, kind: 'wrong', subject: 'Acme billing contact', page: PAGE, objective_id: cardId,
      suggested_fix: 'Billing contact: Lee Park', source: 'worker', filed_by: `card #${cardId} worker`, status: 'open', seen_count: 1,
    })
    expect(kbHash()).toBe(before)
    expect(fs.readFileSync(path.join(KB, PAGE), 'utf8')).toContain('Billing contact: Dana.')
  })

  it('filing the same open defect again bumps seen_count instead of stacking a row', async () => {
    const r = await call<{ flag: { id: number; seen_count: number }; reused: boolean }>('POST', '/api/kb-wiki/flags', {
      kind: 'wrong', subject: '  acme   Billing contact ', page: PAGE, detail: 'Seen again on another card.',
    }, asToken(worker(cardId)))
    expect(r.status).toBe(200)
    expect(r.body.reused).toBe(true)
    expect(r.body.flag.seen_count).toBe(2)
    expect(listKbFlags(getDb(), WS).flags).toHaveLength(1)
  })

  it('a worker cannot file into another workspace or link another card', async () => {
    expect((await call('POST', `/api/kb-wiki/flags?workspace=${OTHER}`, { kind: 'missing', subject: 'x', detail: 'y' }, asToken(worker(cardId)))).status).toBe(403)
    expect((await call('POST', '/api/kb-wiki/flags', { kind: 'missing', subject: 'x', detail: 'y', objective_id: sameWsCard2 }, asToken(worker(cardId)))).status).toBe(403)
    // A token whose workspace no longer matches the live card is refused.
    expect((await call('POST', '/api/kb-wiki/flags', { kind: 'missing', subject: 'x', detail: 'y' }, asToken(worker(cardId, OTHER)))).status).toBe(403)
    expect((await call('POST', '/api/kb-wiki/flags', { kind: 'missing', subject: 'x', detail: 'y' }, asToken('ccst_forged.abc'))).status).toBe(401)
  })

  it('a reviewer token files as source=reviewer', async () => {
    const r = await call<{ flag: { source: string } }>('POST', '/api/kb-wiki/flags', { kind: 'stale', subject: 'Pricing page', detail: 'Still lists 2025 prices.' }, asToken(worker(cardId, WS, true)))
    expect(r.status).toBe(201)
    expect(r.body.flag.source).toBe('reviewer')
  })

  it('validation errors are a 400 listing every problem', async () => {
    const r = await call<{ error: string; errors: string[] }>('POST', `/api/kb-wiki/flags?workspace=${WS}`, { kind: 'bogus', page: '../etc/passwd' }, asCookie(MEMBER))
    expect(r.status).toBe(400)
    expect(r.body.errors.join(' ')).toMatch(/kind must be/)
    expect(r.body.errors.join(' ')).toMatch(/subject is required/)
    expect(r.body.errors.join(' ')).toMatch(/detail is required/)
    expect(r.body.errors.join(' ')).toMatch(/knowledge-base-relative/)
  })

  it('a person files with login; a linked card must be in the same workspace; outsiders are refused', async () => {
    const ok = await call<{ flag: { source: string; filed_by: string; objective_id: number } }>('POST', '/api/kb-wiki/flags', {
      workspace: WS, kind: 'missing', subject: 'Who owns the Leeds account', detail: 'No page names an owner.', objective_id: sameWsCard2,
    }, asCookie(MEMBER))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.flag).toMatchObject({ source: 'person', filed_by: 'u2', objective_id: sameWsCard2 })
    expect((await call('POST', '/api/kb-wiki/flags', { workspace: WS, kind: 'missing', subject: 'a', detail: 'b', objective_id: otherWsCard }, asCookie(MEMBER))).status).toBe(404)
    expect((await call('POST', '/api/kb-wiki/flags', { workspace: WS, kind: 'missing', subject: 'a', detail: 'b' }, asCookie(OUTSIDER))).status).toBe(403)
    expect((await call('POST', '/api/kb-wiki/flags', { kind: 'missing', subject: 'a', detail: 'b' }, asCookie(MEMBER))).status).toBe(400)
    expect((await call('POST', '/api/kb-wiki/flags', { workspace: WS, kind: 'missing', subject: 'a', detail: 'b' }, {})).status).toBe(401)
  })

  it('lists the open queue oldest first, with filters and a curator cursor', async () => {
    const all = await call<{ flags: Array<{ id: number; kind: string }>; total: number; open: number }>('GET', `/api/kb-wiki/flags?workspace=${WS}`, undefined, asCookie(MEMBER))
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(3)
    expect(all.body.open).toBe(3)
    const ids = all.body.flags.map(f => f.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    const wrong = await call<{ flags: unknown[] }>('GET', `/api/kb-wiki/flags?workspace=${WS}&kind=wrong`, undefined, asCookie(MEMBER))
    expect(wrong.body.flags).toHaveLength(1)
    const after = await call<{ flags: Array<{ id: number }> }>('GET', `/api/kb-wiki/flags?workspace=${WS}&after_id=${ids[0]}`, undefined, asCookie(MEMBER))
    expect(after.body.flags.map(f => f.id)).toEqual(ids.slice(1))
    const mine = await call<{ flags: unknown[] }>('GET', `/api/kb-wiki/flags?workspace=${WS}&objective_id=${cardId}`, undefined, asCookie(MEMBER))
    expect(mine.body.flags).toHaveLength(2)
    // A worker reads its own workspace's queue without naming it.
    const viaToken = await call<{ total: number }>('GET', '/api/kb-wiki/flags', undefined, asToken(worker(cardId)))
    expect(viaToken.body.total).toBe(3)
    expect((await call('GET', `/api/kb-wiki/flags?workspace=${WS}&status=nope`, undefined, asCookie(MEMBER))).status).toBe(400)
    expect((await call('GET', `/api/kb-wiki/flags?workspace=${WS}`, undefined, asCookie(OUTSIDER))).status).toBe(403)
  })

  it('a person closes a flag; a worker token cannot; a closed flag leaves the open queue and a new report opens a fresh row', async () => {
    const [first] = listKbFlags(getDb(), WS).flags
    expect((await call('POST', `/api/kb-wiki/flags/${first.id}/status`, { status: 'resolved' }, asToken(worker(cardId)))).status).toBe(403)
    expect((await call('POST', `/api/kb-wiki/flags/${first.id}/status`, { workspace: OTHER, status: 'resolved' }, asCookie(ADMIN))).status).toBe(404)
    expect((await call('POST', `/api/kb-wiki/flags/${first.id}/status`, { workspace: WS, status: 'maybe' }, asCookie(MEMBER))).status).toBe(400)
    const done = await call<{ flag: { status: string; resolved_by: string; resolution_note: string } }>('POST', `/api/kb-wiki/flags/${first.id}/status`, { workspace: WS, status: 'resolved', note: 'Updated the page.' }, asCookie(MEMBER))
    expect(done.status).toBe(200)
    expect(done.body.flag).toMatchObject({ status: 'resolved', resolved_by: 'u2', resolution_note: 'Updated the page.' })
    expect(listKbFlags(getDb(), WS).flags.map(f => f.id)).not.toContain(first.id)
    expect(listKbFlags(getDb(), WS, { status: 'resolved' }).flags.map(f => f.id)).toEqual([first.id])
    const again = await call<{ reused: boolean; flag: { id: number } }>('POST', '/api/kb-wiki/flags', { kind: first.kind, subject: first.subject, page: first.page, detail: 'Wrong again.' }, asToken(worker(cardId)))
    expect(again.status).toBe(201)
    expect(again.body.flag.id).not.toBe(first.id)
  })

  it('a chat bot that can read the knowledge base files a flag with flag_knowledge; no page changes', async () => {
    const { grantBotWorkspace } = await import('../services/agent-chat/bot-workspaces.js')
    grantBotWorkspace('librarian', WS, 'admin')
    const agent = { slug: 'librarian', tools: ['search'], knowledge_folders: ['.'] } as unknown as Parameters<typeof runTool>[0]['agent']
    expect(toolSpecsFor(agent).map(s => s.function.name)).toContain('flag_knowledge')
    // The admin (user 1) sees the card; the bot is not granted the other workspace, so that card is refused.
    const ctx = { userId: 1, username: 'u1', workspace: WS, agent, kbRoot: KB, connectors: {} } as Parameters<typeof runTool>[0]
    const before = kbHash()
    const out = runTool(ctx, 'flag_knowledge', { kind: 'stale', subject: 'Acme office address', page: PAGE, detail: 'They moved in October.', card_id: cardId })
    const res = out.result as { flag_id: number; reused: boolean }
    expect(res.reused).toBe(false)
    const row = listKbFlags(getDb(), WS, { status: 'all' }).flags.find(f => f.id === res.flag_id)!
    expect(row).toMatchObject({ source: 'bot', kind: 'stale', objective_id: cardId, filed_by: 'u1 (chat: librarian)' })
    expect(kbHash()).toBe(before)
    expect(() => runTool(ctx, 'flag_knowledge', { kind: 'stale', subject: 'x', detail: 'y', card_id: otherWsCard })).toThrow(/not on a board you can see|another workspace/)
    expect(() => runTool(ctx, 'flag_knowledge', { kind: 'nope', subject: 'x', detail: 'y' })).toThrow(/kind must be/)
    const noRead = { slug: 'mailer', tools: ['email'], knowledge_folders: [] } as unknown as Parameters<typeof runTool>[0]['agent']
    expect(toolSpecsFor(noRead).map(s => s.function.name)).not.toContain('flag_knowledge')
  })

  it('agent keys: reading the queue needs vault:read, filing and closing need vault:write', () => {
    expect(requiredScope('GET', '/api/kb-wiki/flags', {})).toEqual({ kind: 'scope', scope: 'vault:read' })
    expect(requiredScope('POST', '/api/kb-wiki/flags', {})).toEqual({ kind: 'scope', scope: 'vault:write' })
    expect(requiredScope('POST', '/api/kb-wiki/flags/12/status', {})).toEqual({ kind: 'scope', scope: 'vault:write' })
    expect(requiredScope('DELETE', '/api/kb-wiki/flags/12', {})).toEqual({ kind: 'off_surface' })
  })

  it('the worker prompt tells a session to flag, not rewrite, using its own token', () => {
    const text = buildKbFlagBlock().join('\n')
    expect(text).toContain('/api/kb-wiki/flags')
    expect(text).toContain('X-CC-Session-Token: $CC_SESSION_TOKEN')
    expect(text).toMatch(/Do not quietly rewrite/)
  })
})
