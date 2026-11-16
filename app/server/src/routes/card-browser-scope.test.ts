/**
 * Card browser session SCOPE (obj 901106, review of PR 823).
 *
 * The blocker the review found: a `ccb_` session carried the acting user's id,
 * so every route that checks `userHasWorkspace(req.user.id, …)`,
 * `getUserWorkspaces(req.user.id)` or `userOwnsObjective(req.user.id, …)` let it
 * read every workspace the acting user (usually Operator) belongs to.
 *
 * This suite mounts the REAL routers (auth, objectives, workspaces, docs, files,
 * secrets broker, secrets, connectors, agent chat, admin users, costs) behind
 * the real agent-key guard, mints a card browser session for a card in
 * workspace A, and proves — for a MEMBER acting user and for an ADMIN acting
 * user who is a member of A and B — that nothing in B is reachable, and that
 * everything outside the read allowlist is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-browser-scope-'))
const KB = path.join(TMP, 'kb')
const WS_A = 'alpha'
const WS_B = 'bravo'
const A_DIR = path.join(KB, 'workspaces', WS_A)
const B_DIR = path.join(KB, 'workspaces', WS_B)
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-card-browser-scope-xx'
process.env.SECOND_BRAIN_ROOT = KB

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace, invalidateWorkspacesCache } = await import('../services/workspaces.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { generateToken } = await import('../middleware/auth.js')
const { requireAuth } = await import('../middleware/auth.js')
const { requireWorkspaceAccess } = await import('../middleware/workspace.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { createCardBrowserSessionRouter } = await import('./card-browser-session.js')
const { default: authRouter } = await import('./auth.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: workspacesRouter } = await import('./workspaces.js')
const { default: docsRouter } = await import('./docs.js')
const { default: filesRouter } = await import('./files.js')
const { default: secretsBrokerRouter } = await import('./secrets-broker.js')
const { default: secretsRouter } = await import('./secrets.js')
const { default: connectorsRouter } = await import('./connectors.js')
const { default: agentChatRouter } = await import('./agent-chat.js')
const { default: adminUsersRouter } = await import('./admin-users.js')
const { default: costsRouter } = await import('./costs.js')
const lib = await import('../lib/card-browser-session.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN_ID = 1   // admin, member of A AND B (the review's "Operator" case)
const MEMBER_ID = 2  // member of A only, objective_visibility 'all'
const OWN_MEMBER_ID = 3  // member of A only, objective_visibility 'own' (the default)
let server: http.Server
let baseUrl: string
let cardForAdmin: number
let cardForMember: number
let cardForOwnMember: number
let bCardOwnedByAdmin: number
let aCardOwnedByAdmin: number

function write(p: string, body: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

async function call(method: string, p: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json, text }
}

function seedCard(workspace: string, createdBy: number, status = 'working'): number {
  return Number(getDb()
    .prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, assigned_user_id, status) VALUES (?, 'opkit-dev', ?, ?, ?, ?)`)
    .run(`card in ${workspace}`, workspace, createdBy, createdBy, status).lastInsertRowid)
}

async function ccbCookie(objectiveId: number, actingUserId: number): Promise<string> {
  const r = await call('POST', '/api/card-browser/session', {
    'X-CC-Session-Token': mintSessionToken({ objectiveId, workspace: WS_A, actingUserId }),
  })
  expect(r.status).toBe(200)
  const tok = (r.json.cookies as Loose[]).find(c => c.name === 'token')
  expect(String(tok.value).startsWith('ccb_')).toBe(true)
  return `token=${tok.value}`
}

beforeAll(async () => {
  write(path.join(A_DIR, 'alpha-note.md'), '# alpha note\nalpha-only-marker\n')
  write(path.join(B_DIR, 'bravo-note.md'), '# bravo note\nbravo-secret-marker\n')
  write(path.join(B_DIR, 'bravo-data.csv'), 'a,b\nbravo-secret-marker,1\n')

  initDb()
  const db = getDb()
  db.prepare('DELETE FROM workspaces').run()
  invalidateWorkspacesCache()
  createWorkspace({ slug: WS_A, name: 'Alpha', vault_path: A_DIR, doc_read_roots: [A_DIR], doc_write_roots: [A_DIR] })
  createWorkspace({ slug: WS_B, name: 'Bravo', vault_path: B_DIR, doc_read_roots: [B_DIR], doc_write_roots: [B_DIR] })

  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(ADMIN_ID)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'sam', 'x', 'member')`).run(MEMBER_ID)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'admin'), (?, ?, 'admin')`).run(ADMIN_ID, WS_A, ADMIN_ID, WS_B)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, ?, 'member', 'all')`).run(MEMBER_ID, WS_A)

  cardForAdmin = seedCard(WS_A, ADMIN_ID)
  cardForMember = seedCard(WS_A, MEMBER_ID)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'olly', 'x', 'member')`).run(OWN_MEMBER_ID)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, ?, 'member', 'own')`).run(OWN_MEMBER_ID, WS_A)
  cardForOwnMember = seedCard(WS_A, OWN_MEMBER_ID)
  bCardOwnedByAdmin = seedCard(WS_B, ADMIN_ID, 'queue')
  aCardOwnedByAdmin = seedCard(WS_A, ADMIN_ID, 'queue')

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/auth', authRouter)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/costs', costsRouter)
  app.use('/api/docs', docsRouter)
  app.use('/api/files', filesRouter)
  app.use('/api/card-browser', createCardBrowserSessionRouter({
    publicUrl: () => 'https://ai.example-install.test',
    exchange: async () => ({ status: 'not_configured', reason: 'unset' }),
  }))
  app.use('/api/secrets-broker', secretsBrokerRouter)
  app.use('/api/admin/users', adminUsersRouter)
  app.use('/api/workspaces', workspacesRouter)
  app.use('/api/agent-chat', agentChatRouter)
  app.use('/api/connectors', connectorsRouter)
  app.use('/api/secrets', secretsRouter)
  // A workspace-gated read that is NOT on the allowlist, to prove
  // requireWorkspaceAccess itself pins the card browser to A (defence in depth).
  app.get('/api/probe/ws', requireAuth, requireWorkspaceAccess, (_req, res) => { res.json({ ok: true }) })
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch {}
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('control: the acting admin\'s own login reaches workspace B (so the refusals below are the ccb scope, not the fixture)', () => {
  it('admin cookie lists the B card and reads it', async () => {
    const admin = `token=${generateToken({ id: ADMIN_ID, username: 'operator', role: 'admin', created_at: '' })}`
    const list = await call('GET', `/api/objectives?workspace=${WS_B}`, { Cookie: admin })
    expect(list.status).toBe(200)
    expect((list.json as Loose[]).map(o => o.id)).toContain(bCardOwnedByAdmin)
    expect((await call('GET', `/api/objectives/${bCardOwnedByAdmin}`, { Cookie: admin })).status).toBe(200)
    const doc = await call('GET', `/api/docs/file?path=${encodeURIComponent(path.join(B_DIR, 'bravo-note.md'))}`, { Cookie: admin })
    expect(doc.status).toBe(200)
  })
})

for (const who of ['member', 'admin'] as const) {
  describe(`ccb session for a card in workspace A, acting user = ${who}`, () => {
    let cookie: string
    const H = () => ({ Cookie: cookie })
    beforeAll(async () => {
      cookie = who === 'admin'
        ? await ccbCookie(cardForAdmin, ADMIN_ID)
        : await ccbCookie(cardForMember, MEMBER_ID)
    })

    it('the principal carries a synthetic id with no membership; /me shows ONE workspace, never the acting user', async () => {
      const me = await call('GET', '/api/auth/me', H())
      expect(me.status).toBe(200)
      expect(me.json.id).toBeLessThan(0)
      expect(me.json.id).not.toBe(ADMIN_ID)
      expect(me.json.id).not.toBe(MEMBER_ID)
      expect(me.json.role).toBe('member')
      expect(me.json.workspaces).toEqual([{ workspace: WS_A, role: 'member' }])
      expect(me.text).not.toContain('operator')
      expect(me.text).not.toContain('"sam"')
      const n = getDb().prepare('SELECT COUNT(*) AS n FROM user_workspaces WHERE user_id = ?').get(me.json.id) as { n: number }
      expect(n.n).toBe(0)
    })

    it('GET /api/objectives?workspace=B is refused or empty', async () => {
      const r = await call('GET', `/api/objectives?workspace=${WS_B}`, H())
      if (r.status === 200) expect(r.json).toEqual([])
      else expect(r.status).toBe(403)
    })

    it('GET /api/objectives?workspace=all and with no workspace never return a B card', async () => {
      for (const q of ['?workspace=all', '', `?workspaces=${WS_A},${WS_B}`]) {
        const r = await call('GET', `/api/objectives${q}`, H())
        expect([200, 403]).toContain(r.status)
        if (r.status === 200) {
          const ids = (r.json as Loose[]).map(o => o.id)
          expect(ids).not.toContain(bCardOwnedByAdmin)
          for (const o of r.json as Loose[]) expect(o.workspace).toBe(WS_A)
        }
      }
    })

    it('GET a single B objective the acting admin owns is refused', async () => {
      const r = await call('GET', `/api/objectives/${bCardOwnedByAdmin}`, H())
      expect([403, 404]).toContain(r.status)
      expect(r.text).not.toContain('card in bravo')
    })

    // obj 901145: the empty-list bug. The card browser must see the cards of its
    // OWN workspace (both acting users here see all of A), and nothing in B.
    it('lists its own workspace\'s cards and reads one, still nothing from B', async () => {
      for (const q of ['', '?workspace=all', `?workspace=${WS_A}`, `?workspaces=${WS_A},${WS_B}`]) {
        const r = await call('GET', `/api/objectives${q}`, H())
        expect(r.status, q).toBe(200)
        const ids = (r.json as Loose[]).map(o => o.id)
        expect(ids, q).toEqual(expect.arrayContaining([cardForAdmin, cardForMember, aCardOwnedByAdmin]))
        expect(ids, q).not.toContain(bCardOwnedByAdmin)
        for (const o of r.json as Loose[]) expect(o.workspace).toBe(WS_A)
      }
      const one = await call('GET', `/api/objectives/${aCardOwnedByAdmin}`, H())
      expect(one.status).toBe(200)
      expect(one.json.id).toBe(aCardOwnedByAdmin)
    })

    it('a bot-chat messages GET is refused (not on the allowlist)', async () => {
      for (const p of [
        `/api/agent-chat/agents/opkit-dev/messages?workspace=${WS_B}`,
        '/api/agent-chat/agents',
        '/api/agent-chat/bot-conversations',
      ]) {
        const r = await call('GET', p, H())
        expect(r.status).toBe(403)
        expect(r.json.code).toBe('card_browser_route_not_allowed')
      }
    })

    it('/api/docs in B is refused; the A note is readable', async () => {
      const bFile = await call('GET', `/api/docs/file?path=${encodeURIComponent(path.join(B_DIR, 'bravo-note.md'))}`, H())
      expect([403, 404]).toContain(bFile.status)
      expect(bFile.text).not.toContain('bravo-secret-marker')
      // Search is filtered to the card's read roots: refused, or no B hit.
      const bSearch = await call('GET', `/api/docs/search?q=bravo&workspace=${WS_B}&mode=keyword`, H())
      expect([200, 403]).toContain(bSearch.status)
      expect(bSearch.text).not.toContain('bravo-note')
      expect(bSearch.text).not.toContain('bravo-secret-marker')
      const tree = await call('GET', '/api/docs/tree', H())
      expect(tree.status).toBe(200)
      expect(tree.text).not.toContain('bravo-note')
      const aFile = await call('GET', `/api/docs/file?path=${encodeURIComponent(path.join(A_DIR, 'alpha-note.md'))}`, H())
      expect(aFile.status).toBe(200)
      expect(aFile.text).toContain('alpha-only-marker')
    })

    it('/api/files in B is refused', async () => {
      const s = await call('GET', `/api/files/search?q=bravo&workspace=${WS_B}`, H())
      expect(s.status).toBe(403)
      const st = await call('GET', `/api/files/stat?path=${encodeURIComponent(path.join(B_DIR, 'bravo-data.csv'))}`, H())
      expect([403, 404]).toContain(st.status)
      const dl = await call('GET', `/api/files/download?path=${encodeURIComponent(path.join(B_DIR, 'bravo-data.csv'))}`, H())
      expect([403, 404]).toContain(dl.status)
      expect(dl.text).not.toContain('bravo-secret-marker')
    })

    it('GET /api/workspaces lists only A', async () => {
      const r = await call('GET', '/api/workspaces', H())
      expect(r.status).toBe(200)
      expect((r.json as Loose[]).map(w => w.slug)).toEqual([WS_A])
    })

    it('requireWorkspaceAccess pins it to A even on a route that is not ccb-aware', async () => {
      // /api/probe/ws is not on the allowlist, so the allowlist refuses it first;
      // the middleware itself is exercised directly in the unit test below.
      const r = await call('GET', `/api/probe/ws?workspace=${WS_B}`, H())
      expect(r.status).toBe(403)
    })

    it('secrets broker, secrets, settings/connectors, users, api keys, agent keys and costs are all refused', async () => {
      for (const p of [
        '/api/secrets-broker/list',
        '/api/secrets',
        `/api/secrets?workspace=${WS_A}`,
        '/api/connectors',
        '/api/admin/users',
        '/api/auth/users',
        '/api/auth/api-key',
        '/api/auth/agent-keys',
        '/api/costs/summary',
      ]) {
        const r = await call('GET', p, H())
        expect(r.status, p).toBe(403)
        expect(r.json.code, p).toBe('card_browser_route_not_allowed')
      }
    })
  })
}

describe('ccb card list for a member with OWN visibility in A (obj 901145)', () => {
  it('sees only the A cards that member owns: the session narrows, never widens', async () => {
    const cookie = await ccbCookie(cardForOwnMember, OWN_MEMBER_ID)
    const r = await call('GET', '/api/objectives', { Cookie: cookie })
    expect(r.status).toBe(200)
    const ids = (r.json as Loose[]).map(o => o.id)
    expect(ids).toContain(cardForOwnMember)
    expect(ids).not.toContain(aCardOwnedByAdmin)
    expect(ids).not.toContain(bCardOwnedByAdmin)
    expect((await call('GET', `/api/objectives/${aCardOwnedByAdmin}`, { Cookie: cookie })).status).toBe(403)
    expect((await call('GET', `/api/objectives/${cardForOwnMember}`, { Cookie: cookie })).status).toBe(200)
  })
})

describe('ccb session respects the install\'s session KB switch (obj 901145)', () => {
  it('docs and files are refused while session_kb_access = 0, readable again when it is back on', async () => {
    const prev = process.env.CC_SESSION_KB_ACCESS
    delete process.env.CC_SESSION_KB_ACCESS
    const cookie = await ccbCookie(cardForAdmin, ADMIN_ID)
    const aNote = `/api/docs/file?path=${encodeURIComponent(path.join(A_DIR, 'alpha-note.md'))}`
    const db = getDb()
    try {
      db.prepare(`INSERT INTO settings (key, value) VALUES ('session_kb_access', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run()
      for (const p of [aNote, '/api/docs/tree', '/api/docs/search?q=alpha&mode=keyword', '/api/files/search?q=alpha']) {
        const r = await call('GET', p, { Cookie: cookie })
        expect(r.status, p).toBe(403)
        expect(r.json.code, p).toBe('session_kb_disabled')
        expect(r.text, p).not.toContain('alpha-only-marker')
      }
      // The board itself is not a KB read and stays available.
      expect((await call('GET', '/api/objectives', { Cookie: cookie })).status).toBe(200)
    } finally {
      db.prepare(`DELETE FROM settings WHERE key = 'session_kb_access'`).run()
      if (prev !== undefined) process.env.CC_SESSION_KB_ACCESS = prev
    }
    const back = await call('GET', aNote, { Cookie: cookie })
    expect(back.status).toBe(200)
    expect(back.text).toContain('alpha-only-marker')
  })
  it('the verdict refuses KB routes only when the flag is off', () => {
    expect(lib.cardBrowserRequestVerdict('GET', '/api/docs/tree', { kbAccess: false })).toMatchObject({ ok: false, code: 'session_kb_disabled' })
    expect(lib.cardBrowserRequestVerdict('GET', '/api/files/stat?path=x', { kbAccess: false })).toMatchObject({ ok: false, code: 'session_kb_disabled' })
    expect(lib.cardBrowserRequestVerdict('GET', '/api/objectives', { kbAccess: false })).toEqual({ ok: true })
    expect(lib.cardBrowserRequestVerdict('GET', '/api/docs/tree', { kbAccess: true })).toEqual({ ok: true })
  })
})

describe('requireWorkspaceAccess for a card browser principal (unit)', () => {
  function run(query: Record<string, string>) {
    let status = 200
    let nexted = false
    const req = { query, body: {}, user: { id: -5, role: 'member' }, cardBrowser: { workspace: WS_A } } as Loose
    const res = { status(s: number) { status = s; return this }, json() { return this } } as Loose
    requireWorkspaceAccess(req, res, () => { nexted = true })
    return { status, nexted }
  }
  it('allows only the card\'s own workspace by name; all/missing go to the handler with no memberships', () => {
    expect(run({ workspace: WS_A }).nexted).toBe(true)
    expect(run({ workspace: WS_B })).toEqual({ status: 403, nexted: false })
    expect(run({ workspace: 'all' }).nexted).toBe(true)
    expect(run({}).nexted).toBe(true)
  })
})

describe('route allowlist (unit)', () => {
  it('only the board-render reads pass; everything else is refused by name', () => {
    const ok = ['/api/auth/me', '/api/workspaces', '/api/objectives', '/api/objectives?workspace=alpha', '/api/objectives/12', '/api/docs/tree', '/api/docs/file?path=x', '/api/files/search?q=x']
    for (const p of ok) expect(lib.cardBrowserRequestVerdict('GET', p), p).toEqual({ ok: true })
    const refused = [
      '/api/secrets-broker/list', '/api/secrets', '/api/settings', '/api/admin/users', '/api/auth/api-key',
      '/api/auth/agent-keys', '/api/costs/summary', '/api/shell', '/api/briefing/briefing', '/api/mcp',
      '/api/agent-chat/agents/x/messages', '/api/objectives/12/output', '/api/objectives/search',
      '/api/internal/objectives', '/api/flows', '/api/decisions/queue', '/api/docs/file/../../etc',
    ]
    for (const p of refused) expect(lib.cardBrowserRequestVerdict('GET', p), p).toMatchObject({ ok: false, code: 'card_browser_route_not_allowed' })
    expect(lib.cardBrowserRequestVerdict('POST', '/api/objectives')).toMatchObject({ ok: false, code: 'card_browser_read_only' })
    expect(lib.cardBrowserRequestVerdict('POST', '/api/auth/logout')).toEqual({ ok: true })
  })
  it('trailing slashes are trimmed, and a hostile slash run stays fast (obj 901148)', () => {
    expect(lib.cardBrowserRequestVerdict('GET', '/api/objectives/12/')).toEqual({ ok: true })
    expect(lib.cardBrowserRequestVerdict('GET', '/api/auth/me///?x=1')).toEqual({ ok: true })
    expect(lib.cardBrowserRequestVerdict('GET', '/')).toMatchObject({ ok: false, code: 'card_browser_route_not_allowed' })
    const t0 = Date.now()
    expect(lib.cardBrowserRequestVerdict('GET', '/' + '/'.repeat(100_000) + 'x')).toMatchObject({ ok: false })
    expect(Date.now() - t0).toBeLessThan(500)
  })
  it('the synthetic id is negative, so it can never be a users.id', () => {
    expect(lib.cardBrowserSyntheticUserId(901106)).toBe(-901106)
    expect(lib.cardBrowserSyntheticUserId(0)).toBe(-1)
  })
})
