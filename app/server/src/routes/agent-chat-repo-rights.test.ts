/**
 * obj 901492 — the "GitHub repo rights" grant routes, over real HTTP against a
 * temp DB:
 *
 *   - OFF by default: a fresh install lists no repo;
 *   - only an admin signed in to the browser (cookie) can switch a repo on or
 *     off: a member, an agent API key and an admin's Bearer JWT are refused and
 *     nothing is written;
 *   - only Operation Kit Dev can hold it; a repo is one exact `owner/name`;
 *   - every change (and every refused change by an admin) is a dev_ops_audit
 *     row and a feed line;
 *   - the payload names the optional credential by NAME and says only whether
 *     one is stored: never a value.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

import { randomBytes } from 'crypto'

process.env.JWT_SECRET = 'test-secret-repo-rights-routes'
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-repo-rights-routes-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59949' // a dead port: nothing here may reach a live server
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-repo-rights-routes-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { repoGrantActive } = await import('../services/dev-ops/repo-grant.js')

const ADMIN = 1
const MEMBER = 2
const DEV = 'operation-kit-dev'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
let agentKey = ''

const tokenFor = (id: number, role: string) => jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, p: string, opts: { as?: number; role?: string; body?: unknown; bearer?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.as) headers.Cookie = `token=${tokenFor(opts.as, opts.role ?? 'member')}`
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}
const admin = (method: string, p: string, body?: unknown) => call(method, p, { as: ADMIN, role: 'admin', body })
const audit = () => getDb().prepare("SELECT * FROM dev_ops_audit WHERE action = 'repo_grant' ORDER BY id").all() as Loose[]
const grants = () => (getDb().prepare('SELECT COUNT(*) AS n FROM dev_ops_repo_grants').get() as { n: number }).n

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user1', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(MEMBER)
  for (const slug of [DEV, 'other-bot']) {
    fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
    fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${slug}\nsystem_prompt: You build.\ntools: [list_objectives]\n`)
  }
  const k = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'dev-bot' })
  if (!k.ok) throw new Error(k.error)
  agentKey = k.key.token
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM dev_ops_repo_grants').run()
  db.prepare('DELETE FROM dev_ops_audit').run()
})

describe('GitHub repo rights: the grant', () => {
  it('is off by default: no repo is listed and nothing is granted', async () => {
    const r = await admin('GET', `/agents/${DEV}/repo-rights`)
    expect(r.status).toBe(200)
    expect(r.json.repo_rights).toMatchObject({ eligible: true, repos: [], credential_name: 'DEV_BOT_GITHUB_TOKEN', credential_stored: false })
    expect(repoGrantActive(DEV, 'acme/app')).toBe(false)
  })

  it('an admin in the browser switches one repo on, then off; both are audited and in the feed', async () => {
    const on = await admin('PUT', `/agents/${DEV}/repo-rights`, { repo: 'Acme/App', enabled: true })
    expect(on.status).toBe(200)
    expect(on.json.repo_rights.repos.map((g: Loose) => g.repo)).toEqual(['acme/app'])
    expect(on.json.repo_rights.repos[0]).toMatchObject({ granted_by: ADMIN, granted_by_username: 'user1' })
    expect(repoGrantActive(DEV, 'acme/app')).toBe(true)
    expect(repoGrantActive(DEV, 'acme/other')).toBe(false)

    const off = await admin('PUT', `/agents/${DEV}/repo-rights`, { repo: 'acme/app', enabled: false })
    expect(off.json.repo_rights.repos).toEqual([])
    expect(repoGrantActive(DEV, 'acme/app')).toBe(false)
    expect(audit().map(a => [a.outcome, a.code, a.target, a.username])).toEqual([
      ['done', 'granted', 'acme/app', 'user1'],
      ['done', 'revoked', 'acme/app', 'user1'],
    ])
    const feed = getDb().prepare("SELECT title FROM activity_log WHERE json_extract(metadata, '$.kind') = 'dev_ops_repo_grant' ORDER BY id").all() as { title: string }[]
    expect(feed.map(f => f.title).join('\n')).toMatch(/switched on for acme\/app[\s\S]*switched off for acme\/app/)
  })

  it('a member, an agent API key and an admin Bearer token cannot change it; nothing is written', async () => {
    const body = { repo: 'acme/app', enabled: true }
    expect((await call('PUT', `/agents/${DEV}/repo-rights`, { as: MEMBER, role: 'member', body })).status).toBe(403)
    expect((await call('PUT', `/agents/${DEV}/repo-rights`, { bearer: agentKey, body })).status).toBe(403)
    expect((await call('PUT', `/agents/${DEV}/repo-rights`, { bearer: tokenFor(ADMIN, 'admin'), body })).status).toBe(403)
    expect((await call('PUT', `/agents/${DEV}/repo-rights`, { body })).status).toBe(401)
    expect(grants()).toBe(0)
    expect(repoGrantActive(DEV, 'acme/app')).toBe(false)
  })

  it('only Operation Kit Dev can hold it, and only one exact repo at a time', async () => {
    const other = await admin('PUT', '/agents/other-bot/repo-rights', { repo: 'acme/app', enabled: true })
    expect(other.status).toBe(400)
    expect(other.json.code).toBe('bot_not_eligible')
    for (const repo of ['acme/*', '*', 'acme', '../x', 'https://example.com/acme/app', 42, null]) {
      const r = await admin('PUT', `/agents/${DEV}/repo-rights`, { repo, enabled: true })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('bad_repo')
    }
    expect((await admin('PUT', `/agents/${DEV}/repo-rights`, { repo: 'acme/app', enabled: 'yes' })).status).toBe(400)
    expect(grants()).toBe(0)
    expect(audit().every(a => a.outcome === 'refused')).toBe(true)
    expect(audit().length).toBeGreaterThanOrEqual(8)
  })

  it('says whether the named credential is stored, and never returns a value', async () => {
    const fakeValue = 'envtok_9f8e7d6c5b4a39281706' // allow-listed fake in scripts/oss-gitleaks.toml
    const { setSecret } = await import('../services/secrets-store.js') as Loose
    setSecret({ scope: { scopeType: 'global' }, key: 'DEV_BOT_GITHUB_TOKEN', value: fakeValue, actorUserId: ADMIN })
    const r = await admin('GET', `/agents/${DEV}/repo-rights`)
    expect(r.json.repo_rights.credential_stored).toBe(true)
    expect(JSON.stringify(r.json)).not.toContain(fakeValue)
  })
})
