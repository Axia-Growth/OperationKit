/**
 * obj 900870 — delete an ARCHIVED workspace so it leaves the archived list.
 *
 * Real SQLite via initDb() and the real admin router. Fictional slugs only;
 * no live workspace is touched.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// db/index.ts's import graph reaches node-pty; nothing here opens a terminal.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in this test') } }))

const TMP_DB = path.join(os.tmpdir(), `cc-wsdelete-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-wsdelete'

const { initDb, getDb } = await import('../db/index.js')
const { default: adminWorkspacesRouter } = await import('./admin-workspaces.js')
const { invalidateWorkspacesCache, listWorkspaces, getWorkspaceSlugs, canonicalWorkspaceSlug } =
  await import('../services/workspaces.js')

let server: http.Server
let baseUrl: string

function token(role: 'admin' | 'member'): string {
  return jwt.sign({ id: 1, username: 'tester', role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}
const ADMIN = () => `token=${token('admin')}`
const MEMBER = () => `token=${token('member')}`

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin/workspaces', adminWorkspacesRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  const db = getDb()
  db.exec("DELETE FROM secrets WHERE key LIKE 'TEST_900870_%'")
  db.exec("DELETE FROM workspaces WHERE slug IN ('acme','northwind','globex')")
  db.prepare("INSERT INTO workspaces (slug, name, archived) VALUES ('acme', 'Acme', 0)").run()
  db.prepare("INSERT INTO workspaces (slug, name, archived) VALUES ('northwind', 'Northwind', 1)").run()
  db.prepare("INSERT INTO workspaces (slug, name, archived) VALUES ('globex', 'Globex', 1)").run()
  invalidateWorkspacesCache()
})

async function req(method: string, p: string, body?: unknown, cookie: string | null = ADMIN()) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`${baseUrl}${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const slugsIn = (json: unknown) => (json as { slug: string }[]).map(w => w.slug)

describe('POST /api/admin/workspaces/:slug/delete (obj 900870)', () => {
  it('deletes an archived workspace, which then no longer appears in the admin list', async () => {
    const before = await req('GET', '/api/admin/workspaces')
    expect(slugsIn(before.json)).toContain('northwind')

    const del = await req('POST', '/api/admin/workspaces/northwind/delete', { confirm: 'northwind' })
    expect(del.status).toBe(200)
    expect(del.json).toMatchObject({ ok: true, slug: 'northwind', deleted: true })
    expect(typeof del.json.deleted_at).toBe('string')

    const after = await req('GET', '/api/admin/workspaces')
    expect(slugsIn(after.json)).not.toContain('northwind')
    // The other archived workspace and the active one are untouched.
    expect(slugsIn(after.json)).toEqual(expect.arrayContaining(['acme', 'globex']))
    expect(listWorkspaces({ includeArchived: true }).map(w => w.slug)).not.toContain('northwind')
  })

  it('refuses to delete an ACTIVE workspace (409) and leaves it listed and active', async () => {
    const res = await req('POST', '/api/admin/workspaces/acme/delete', { confirm: 'acme' })
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('not_archived')
    const row = getDb().prepare('SELECT archived, deleted_at FROM workspaces WHERE slug = ?').get('acme') as {
      archived: number; deleted_at: string | null
    }
    expect(row).toEqual({ archived: 0, deleted_at: null })
    expect(listWorkspaces().map(w => w.slug)).toContain('acme')
  })

  it('requires the slug typed back as confirm', async () => {
    for (const body of [undefined, {}, { confirm: 'acme' }, { confirm: true }]) {
      const res = await req('POST', '/api/admin/workspaces/northwind/delete', body)
      expect(res.status).toBe(400)
    }
    expect(slugsIn((await req('GET', '/api/admin/workspaces')).json)).toContain('northwind')
  })

  it('rejects a member (403) and an anonymous caller (401) — nothing is deleted', async () => {
    const member = await req('POST', '/api/admin/workspaces/northwind/delete', { confirm: 'northwind' }, MEMBER())
    expect(member.status).toBe(403)
    const anon = await req('POST', '/api/admin/workspaces/northwind/delete', { confirm: 'northwind' }, null)
    expect(anon.status).toBe(401)
    const memberUndo = await req('POST', '/api/admin/workspaces/northwind/undelete', undefined, MEMBER())
    expect(memberUndo.status).toBe(403)
    const row = getDb().prepare('SELECT deleted_at FROM workspaces WHERE slug = ?').get('northwind') as {
      deleted_at: string | null
    }
    expect(row.deleted_at).toBeNull()
  })

  it('404s an unknown or already-deleted workspace', async () => {
    expect((await req('POST', '/api/admin/workspaces/nope/delete', { confirm: 'nope' })).status).toBe(404)
    await req('POST', '/api/admin/workspaces/northwind/delete', { confirm: 'northwind' })
    expect((await req('POST', '/api/admin/workspaces/northwind/delete', { confirm: 'northwind' })).status).toBe(404)
  })

  it('is a soft delete: secrets (workspace + Shared) and the row survive, slug still resolves', async () => {
    const db = getDb()
    db.prepare(
      "INSERT INTO secrets (scope_type, workspace, key, value_encrypted) VALUES ('workspace', 'northwind', 'TEST_900870_WS', 'x')",
    ).run()
    db.prepare(
      "INSERT INTO secrets (scope_type, workspace, key, value_encrypted) VALUES ('global', '', 'TEST_900870_SHARED', 'x')",
    ).run()
    db.prepare(
      "INSERT INTO secrets (scope_type, workspace, key, value_encrypted) VALUES ('workspace', 'globex', 'TEST_900870_OTHER', 'x')",
    ).run()

    expect((await req('POST', '/api/admin/workspaces/northwind/delete', { confirm: 'northwind' })).status).toBe(200)

    const keys = (db.prepare("SELECT key FROM secrets WHERE key LIKE 'TEST_900870_%' ORDER BY key").all() as {
      key: string
    }[]).map(r => r.key)
    expect(keys).toEqual(['TEST_900870_OTHER', 'TEST_900870_SHARED', 'TEST_900870_WS'])
    expect(db.prepare('SELECT slug FROM workspaces WHERE slug = ?').get('northwind')).toBeTruthy()
    // Internal resolvers (doc-path attribution, merge redirects) still see it.
    expect(getWorkspaceSlugs({ includeArchived: true })).toContain('northwind')
    expect(canonicalWorkspaceSlug('northwind')).toBe('northwind')
  })

  it('undelete puts it back on the archived list (still archived); PATCH is refused while deleted', async () => {
    await req('POST', '/api/admin/workspaces/northwind/delete', { confirm: 'northwind' })

    // Hidden by default, findable with include_deleted=1.
    const withDeleted = await req('GET', '/api/admin/workspaces?include_deleted=1')
    expect(slugsIn(withDeleted.json)).toContain('northwind')

    // A stale tab's Restore cannot resurrect a deleted workspace.
    expect((await req('PATCH', '/api/admin/workspaces/northwind', { archived: false })).status).toBe(404)

    const undo = await req('POST', '/api/admin/workspaces/northwind/undelete')
    expect(undo.status).toBe(200)
    expect(undo.json).toMatchObject({ slug: 'northwind', archived: true, deleted_at: null })
    const list = await req('GET', '/api/admin/workspaces')
    expect(slugsIn(list.json)).toContain('northwind')
    expect((await req('POST', '/api/admin/workspaces/northwind/undelete')).status).toBe(404)
  })
})
