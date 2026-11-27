import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// End to end over real SQLite + real HTTP with a stubbed AI: browse the wiki,
// file an answer back, import the sample chats (pick some, run, pause), run
// the cleanup, rebuild — and the raw originals never change.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kbwiki-'))
const TMP_DB = path.join(TMP, 'test.db')
const KB = path.join(TMP, 'kb')
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-kbwiki'
process.env.AI_WORKSPACE_DIR = path.join(TMP, 'ai-workspace')

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace, updateWorkspace } = await import('../services/workspaces.js')
const { PACK_ID } = await import('../services/doc-ingest/service.js')
const { settingKey } = await import('../services/starter-packs.js')
const { FOLDER_FOR } = await import('../services/doc-ingest/notes.js')
const { setWikiLlmForTests } = await import('../services/kb-wiki/llm.js')
const { compileWiki } = await import('../services/kb-wiki/wiki.js')
const { whenImportsIdle } = await import('../services/kb-wiki/imports.js')
const { stopWikiLintScheduler } = await import('../services/kb-wiki/scheduler.js')
const { default: kbWikiRouter, internalKbWikiRouter, nextLintRun } = await import('./kb-wiki.js')
const { default: docsRouter } = await import('./docs.js')
const { runTool } = await import('../services/agent-chat/tools.js')

const WS = 'fernleaf'
const PERSON = FOLDER_FOR.person
const ORG = FOLDER_FOR.organization
const ROSA = `${PERSON}/rosa-delgado.md`
const SHOP = `${ORG}/fernleaf-garden-supply.md`

let server: http.Server
let base: string
let proxied: http.Server
let proxiedBase: string
const cookie = (role: 'admin' | 'member', id: number) => `token=${jwt.sign({ id, username: `u${id}`, role }, 'test-secret-kbwiki', { expiresIn: '1h' })}`
const ADMIN = cookie('admin', 1)
const MEMBER = cookie('member', 2)
const OUTSIDER = cookie('member', 99)

const sha = (abs: string) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
function rawShas(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else out[path.relative(KB, abs)] = sha(abs)
    }
  }
  for (const d of ['raw', 'sources/files']) if (fs.existsSync(path.join(KB, d))) walk(path.join(KB, d))
  return out
}

// The AI: answers every conversation in a batch like the real extractor would.
let gate: Promise<void> | null = null
setWikiLlmForTests(async (system, prompt) => {
  if (gate) await gate
  // obj 901746: the answer check. Anything about Antarctica is not on any page.
  if (system.startsWith('You check whether an answer is supported')) {
    return prompt.includes('Antarctica')
      ? JSON.stringify({ unsupported: [{ claim: 'Fernleaf ships to Antarctica', page: SHOP, why: 'The page only says it is an independent garden centre.' }] })
      : '{"unsupported":[]}'
  }
  const convs = [...prompt.matchAll(/=== CONVERSATION (c\d+) ===\nKind: .*\nTitle: (.*)/g)].map(([, key, title]) => ({
    key, skip: false, title, summary: `About ${title}.`, decisions: [], todos: [],
    entities: [{ type: 'person', name: 'Sam Okafor', facts: [{ fact: `Talked about ${title}`, where: 'message 1, You' }] }],
  }))
  if (convs.length) return JSON.stringify({ conversations: convs })
  return JSON.stringify({ contradictions: [] })
})

function writeKb(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(KB, rel)), { recursive: true })
  fs.writeFileSync(path.join(KB, rel), text)
}

const json = (cookieHeader: string) => ({ cookie: cookieHeader, 'Content-Type': 'application/json' })
async function get<T = Record<string, unknown>>(url: string, who = ADMIN): Promise<{ status: number; body: T }> {
  const r = await fetch(`${base}${url}`, { headers: { cookie: who } })
  return { status: r.status, body: await r.json() as T }
}
async function send<T = Record<string, unknown>>(method: string, url: string, body: unknown, who = ADMIN): Promise<{ status: number; body: T }> {
  const r = await fetch(`${base}${url}`, { method, headers: json(who), body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() as T }
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  createWorkspace({ slug: WS, name: 'Fernleaf', vault_path: KB })
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'u2', 'x', 'member')
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (2, ?, 'member')`).run(WS)

  writeKb(ROSA, '---\ntitle: Rosa Delgado\ntype: person\nupdated: 2026-10-01\ngenerated_by: document-ingest\n---\n# Rosa Delgado\n\nOwner of the garden centre.\n')
  writeKb(SHOP, `---\ntitle: Fernleaf Garden Supply\ntype: organization\nupdated: 2026-10-01\n---\n# Fernleaf Garden Supply\n\nIndependent garden centre run by [[${PERSON}/rosa-delgado|Rosa Delgado]].\n`)
  writeKb('raw/notes/original.txt', 'Untouched original.\n')
  writeKb('sources/files/price-list.md', '# A raw original that happens to be markdown\n')
  compileWiki(KB)

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/internal/kb-wiki', internalKbWikiRouter)
  app.use('/api/kb-wiki', kbWikiRouter)
  app.use('/api/docs', docsRouter)
  await new Promise<void>(r => { server = app.listen(0, () => r()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  // Same internal router behind a proxy that says the caller is remote.
  const remote = express()
  remote.set('trust proxy', true)
  remote.use(express.json())
  remote.use('/api/internal/kb-wiki', internalKbWikiRouter)
  await new Promise<void>(r => { proxied = remote.listen(0, () => r()) })
  proxiedBase = `http://127.0.0.1:${(proxied.address() as { port: number }).port}`
})

afterAll(async () => {
  setWikiLlmForTests(null)
  stopWikiLintScheduler()
  await whenImportsIdle(KB)
  await new Promise<void>(r => server.close(() => r()))
  await new Promise<void>(r => proxied.close(() => r()))
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('kb-wiki routes', () => {
  let before: Record<string, string>

  it('is off until the knowledge base is switched on', async () => {
    expect((await get(`/api/kb-wiki/pages?workspace=${WS}`)).status).toBe(404)
    getDb().prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(settingKey(PACK_ID))
    before = rawShas()
    expect(Object.keys(before)).toHaveLength(2)
  })

  it('needs login and workspace membership', async () => {
    expect((await fetch(`${base}/api/kb-wiki/pages?workspace=${WS}`)).status).toBe(401)
    expect((await get(`/api/kb-wiki/pages?workspace=${WS}`, OUTSIDER)).status).toBe(403)
    expect((await get('/api/kb-wiki/pages?workspace=nope', MEMBER)).status).toBe(404)
    expect((await get('/api/kb-wiki/pages', MEMBER)).status).toBe(400)
  })

  it('lists pages with counts and the index/log names', async () => {
    const r = await get<{ pages: Array<{ rel: string; title: string; kind: string }>; counts: Record<string, number>; index: string; log: string }>(`/api/kb-wiki/pages?workspace=${WS}`, MEMBER)
    expect(r.status).toBe(200)
    expect(r.body.pages.map(p => p.rel).sort()).toEqual([SHOP, ROSA].sort())
    expect(r.body.pages.find(p => p.rel === ROSA)).toMatchObject({ title: 'Rosa Delgado', kind: 'person' })
    expect(r.body.counts).toMatchObject({ person: 1, organization: 1 })
    expect(r.body.index).toBe('index.md')
    expect(r.body.log).toBe('log.md')
  })

  it('reads one page with backlinks; protected, missing and escaping paths are 404', async () => {
    const r = await get<{ rel: string; title: string; content: string; backlinks: Array<{ rel: string }> }>(`/api/kb-wiki/page?workspace=${WS}&path=${ROSA}`, MEMBER)
    expect(r.status).toBe(200)
    expect(r.body.title).toBe('Rosa Delgado')
    expect(r.body.backlinks.map(b => b.rel)).toEqual([SHOP])
    expect((await get(`/api/kb-wiki/page?workspace=${WS}&path=index.md`, MEMBER)).body.content).toContain('generated_by: kb-wiki')
    for (const bad of ['sources/files/price-list.md', 'raw/notes/original.txt', 'raw/x.md', '.kb-wiki/lint-last.json',
      '../../etc/passwd.md', `${PERSON}/../../../etc/passwd.md`, '/etc/passwd.md', `${PERSON}/nobody.md`, `${PERSON}/rosa-delgado.txt`]) {
      const t = await get(`/api/kb-wiki/page?workspace=${WS}&path=${encodeURIComponent(bad)}`, MEMBER)
      expect(t.status, bad).toBe(404)
      expect(typeof (t.body as { error: unknown }).error).toBe('string')
    }
  })

  let answerRel = ''
  it('files an answer: the page exists and the page it used links back to it', async () => {
    expect((await send('POST', '/api/kb-wiki/answers', { workspace: WS, question: '', answer: 'x' }, MEMBER)).status).toBe(400)
    const r = await send<{ rel: string; title: string; check: { status: string } }>('POST', '/api/kb-wiki/answers', {
      workspace: WS, question: 'Who owns Fernleaf?', answer: `Rosa Delgado owns it [[${ROSA}]].`, sources: [ROSA, 'raw/notes/original.txt', 'nope/x.md'],
    }, MEMBER)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.check.status).toBe('passed') // obj 901746: the AI read Rosa's page next to the answer
    answerRel = r.body.rel
    expect(answerRel).toMatch(/^answers\/\d{4}-\d{2}-\d{2}-who-owns-fernleaf\.md$/)
    expect(r.body.title).toBe('Who owns Fernleaf?')
    const page = fs.readFileSync(path.join(KB, answerRel), 'utf8')
    expect(page).toContain('filed_by: u2')
    expect(page).not.toContain('raw/notes')
    const used = await get<{ backlinks: Array<{ rel: string }> }>(`/api/kb-wiki/page?workspace=${WS}&path=${ROSA}`, MEMBER)
    expect(used.body.backlinks.map(b => b.rel)).toContain(answerRel)
    const pages = await get<{ counts: Record<string, number> }>(`/api/kb-wiki/pages?workspace=${WS}`, MEMBER)
    expect(pages.body.counts.answer).toBe(1)
  })

  it('an answer its pages do not back up is saved but held; a member lists it and a person approves or keeps it out (obj 901746)', async () => {
    const r = await send<{ rel: string; check: { status: string; kind: string; reason: string; unsupported: unknown[] } }>('POST', '/api/kb-wiki/answers', {
      workspace: WS, question: 'Where does Fernleaf ship?', answer: `Fernleaf ships to Antarctica [[${SHOP}]].`, sources: [SHOP],
    }, MEMBER)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.check).toMatchObject({ status: 'held', kind: 'ungrounded' })
    expect(r.body.check.reason).toContain('Fernleaf ships to Antarctica')
    const wrong = await send<{ rel: string; check: { status: string; reason: string } }>('POST', '/api/kb-wiki/answers', {
      workspace: WS, question: 'Who delivers compost?', answer: 'Greenway [[organizations/greenway-growers.md]].', sources: [],
    }, MEMBER)
    expect(wrong.body.check).toMatchObject({ status: 'held' })
    expect(wrong.body.check.reason).toContain('not a page in Context')

    const held = await get<{ answers: Array<{ rel: string; kind: string; reason: string }> }>(`/api/kb-wiki/answers/held?workspace=${WS}`, MEMBER)
    expect(held.body.answers.map(a => a.rel).sort()).toEqual([r.body.rel, wrong.body.rel].sort())
    expect((await get(`/api/kb-wiki/answers/held?workspace=${WS}`, OUTSIDER)).status).toBe(403)

    expect((await send('POST', '/api/kb-wiki/answers/review', { workspace: WS, rel: r.body.rel, decision: 'maybe' }, MEMBER)).status).toBe(400)
    expect((await send('POST', '/api/kb-wiki/answers/review', { workspace: WS, rel: r.body.rel, decision: 'approve' }, OUTSIDER)).status).toBe(403)
    expect((await send('POST', '/api/kb-wiki/answers/review', { workspace: WS, rel: ROSA, decision: 'approve' }, MEMBER)).status).toBe(400)
    const ok = await send<{ status: string }>('POST', '/api/kb-wiki/answers/review', { workspace: WS, rel: r.body.rel, decision: 'approve' }, MEMBER)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.status).toBe('reviewed')
    expect(fs.readFileSync(path.join(KB, r.body.rel), 'utf8')).toContain('reviewed_by: u2')
    expect((await send('POST', '/api/kb-wiki/answers/review', { workspace: WS, rel: wrong.body.rel, decision: 'keep_out' }, MEMBER)).status).toBe(200)
    expect((await get<{ answers: unknown[] }>(`/api/kb-wiki/answers/held?workspace=${WS}`, MEMBER)).body.answers).toEqual([])
    // Tidy up so the page counts below stay as they were.
    fs.rmSync(path.join(KB, r.body.rel)); fs.rmSync(path.join(KB, wrong.body.rel)); compileWiki(KB)
  })

  it('internal answers route: localhost only, no login', async () => {
    const r = await fetch(`${base}/api/internal/kb-wiki/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: WS, question: 'What does Fernleaf sell?', answer: 'Plants.', sources: [SHOP], filed_by: 'card 42' }) })
    const body = await r.json() as { rel: string }
    expect(r.status, JSON.stringify(body)).toBe(201)
    expect(fs.readFileSync(path.join(KB, body.rel), 'utf8')).toContain('card 42')
    const remote = await fetch(`${proxiedBase}/api/internal/kb-wiki/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ workspace: WS, question: 'q', answer: 'a' }) })
    expect(remote.status).toBe(403)
    const unknown = await fetch(`${base}/api/internal/kb-wiki/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: 'nope', question: 'q', answer: 'a' }) })
    expect(unknown.status).toBe(404)
  })

  interface Job { id: string; kind: string; status: string; raw_files: string[]; counts: { total: number; selected: number; done: number; skipped: number; queued: number }; items?: unknown }
  interface Item { key: string; title: string; selected: boolean; status: string; source_note?: string; pages?: string[] }
  let jobs: Job[] = []

  it('sample import: pick chats with a filter, start, wait → pages made, raw untouched', async () => {
    const r = await send<{ jobs: Job[] }>('POST', `/api/kb-wiki/imports/samples?workspace=${WS}`, {}, MEMBER)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    jobs = r.body.jobs
    expect(jobs.map(j => j.kind).sort()).toEqual(['chatgpt-export', 'claude-export', 'transcripts'])
    expect(jobs.every(j => j.status === 'review' && j.items === undefined)).toBe(true)
    for (const j of jobs) for (const raw of j.raw_files) expect(fs.existsSync(path.join(KB, raw)), raw).toBe(true)

    const listed = await get<{ imports: Job[]; working: boolean }>(`/api/kb-wiki/imports?workspace=${WS}`, MEMBER)
    expect(listed.body.imports).toHaveLength(3)
    expect(listed.body.imports[0].items).toBeUndefined()

    const claude = jobs.find(j => j.kind === 'claude-export')!
    const all = await get<{ items: Item[]; total: number }>(`/api/kb-wiki/imports/${claude.id}/items?workspace=${WS}&limit=2`, MEMBER)
    expect(all.status).toBe(200)
    expect(all.body.items).toHaveLength(2)
    expect(all.body.total).toBe(claude.counts.total)
    expect((await get(`/api/kb-wiki/imports/${claude.id}/items?workspace=${WS}&status=bogus`, MEMBER)).status).toBe(400)
    expect((await get(`/api/kb-wiki/imports/nope-123/items?workspace=${WS}`, MEMBER)).status).toBe(404)

    // Untick everything, then tick only what matches the first chat's title.
    const off = await send<{ counts: { selected: number } }>('POST', `/api/kb-wiki/imports/${claude.id}/select`, { workspace: WS, all_matching: {}, selected: false }, MEMBER)
    expect(off.body.counts.selected).toBe(0)
    const q = all.body.items[0].title
    const on = await send<{ counts: { selected: number } }>('POST', `/api/kb-wiki/imports/${claude.id}/select`, { workspace: WS, all_matching: { q }, selected: true }, MEMBER)
    expect(on.status).toBe(200)
    const picked = on.body.counts.selected
    expect(picked).toBeGreaterThanOrEqual(1)
    expect(picked).toBeLessThan(claude.counts.total)

    const start = await send<{ job: Job }>('POST', `/api/kb-wiki/imports/${claude.id}/start`, { workspace: WS }, MEMBER)
    expect(start.status, JSON.stringify(start.body)).toBe(200)
    expect(start.body.job.status).toBe('running')
    await whenImportsIdle(KB)

    const after = (await get<{ imports: Job[] }>(`/api/kb-wiki/imports?workspace=${WS}`, MEMBER)).body.imports.find(j => j.id === claude.id)!
    expect(after.status).toBe('done')
    expect(after.counts.done).toBe(picked)
    const done = (await get<{ items: Item[] }>(`/api/kb-wiki/imports/${claude.id}/items?workspace=${WS}&status=done`, MEMBER)).body.items
    expect(done).toHaveLength(picked)
    for (const it of done) expect(fs.existsSync(path.join(KB, it.source_note!)), it.source_note).toBe(true)
    expect(fs.existsSync(path.join(KB, `${PERSON}/sam-okafor.md`))).toBe(true)
    const pages = await get<{ pages: Array<{ rel: string }> }>(`/api/kb-wiki/pages?workspace=${WS}`, MEMBER)
    expect(pages.body.pages.map(p => p.rel)).toContain(`${PERSON}/sam-okafor.md`)

    // Starting again with nothing new ticked is a plain 409.
    const again = await send<{ error: string }>('POST', `/api/kb-wiki/imports/${claude.id}/start`, { workspace: WS }, MEMBER)
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already been imported/)

    const now = rawShas()
    for (const [rel, h] of Object.entries(before)) expect(now[rel], rel).toBe(h)
    before = now
  })

  it('pause stops a running import; cancel keeps the raw upload', async () => {
    const chatgpt = jobs.find(j => j.kind === 'chatgpt-export')!
    let release!: () => void
    gate = new Promise<void>(r => { release = r })
    try {
      const start = await send<{ job: Job }>('POST', `/api/kb-wiki/imports/${chatgpt.id}/start`, { workspace: WS }, MEMBER)
      expect(start.body.job.status).toBe('running')
      const pause = await send<{ job: Job }>('POST', `/api/kb-wiki/imports/${chatgpt.id}/pause`, { workspace: WS }, MEMBER)
      expect(pause.status).toBe(200)
      expect(pause.body.job.status).toBe('paused')
    } finally {
      release()
      gate = null
    }
    await whenImportsIdle(KB)
    const after = (await get<{ imports: Job[] }>(`/api/kb-wiki/imports?workspace=${WS}`, MEMBER)).body.imports.find(j => j.id === chatgpt.id)!
    expect(['paused', 'done']).toContain(after.status)

    const cancel = await send<{ job: Job }>('POST', `/api/kb-wiki/imports/${jobs.find(j => j.kind === 'transcripts')!.id}/cancel`, { workspace: WS }, MEMBER)
    expect(cancel.body.job.status).toBe('cancelled')
    for (const raw of chatgpt.raw_files) expect(fs.existsSync(path.join(KB, raw))).toBe(true)
  })

  it('rejects an upload that is not a chat export or transcript', async () => {
    const fd = new FormData()
    fd.append('files', new Blob(['just some bytes']), 'mystery.bin')
    const r = await fetch(`${base}/api/kb-wiki/imports?workspace=${WS}`, { method: 'POST', headers: { cookie: MEMBER }, body: fd })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toMatch(/mystery\.bin/)
  })

  it('uploads a transcript as a new import in review', async () => {
    const fd = new FormData()
    fd.append('files', new Blob(['WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Rosa Delgado>Let us order more compost.\n']), 'call-2026-10-05-ops.vtt')
    const r = await fetch(`${base}/api/kb-wiki/imports?workspace=${WS}`, { method: 'POST', headers: { cookie: MEMBER }, body: fd })
    const body = await r.json() as { jobs: Job[] }
    expect(r.status, JSON.stringify(body)).toBe(201)
    expect(body.jobs[0]).toMatchObject({ kind: 'transcripts', status: 'review' })
  })

  it('cleanup: run now, read the report; settings are admin-only', async () => {
    const empty = await get<{ report: unknown; settings: { lint_schedule: string } }>(`/api/kb-wiki/lint?workspace=${WS}`, MEMBER)
    expect(empty.status).toBe(200)
    expect(empty.body.report).toBeNull()
    expect(empty.body.settings.lint_schedule).toBe('nightly')

    const run = await send<{ report: { ran_at: string; fixed: unknown[]; needs_human: unknown[] } }>('POST', `/api/kb-wiki/lint/run?workspace=${WS}`, {}, MEMBER)
    expect(run.status, JSON.stringify(run.body)).toBe(200)
    expect(run.body.report.ran_at).toBeTruthy()
    expect(Array.isArray(run.body.report.needs_human)).toBe(true)
    const last = await get<{ report: { ran_at: string }; next_run: string | null }>(`/api/kb-wiki/lint?workspace=${WS}`, MEMBER)
    expect(last.body.report.ran_at).toBe(run.body.report.ran_at)
    expect(typeof last.body.next_run).toBe('string')
    expect(fs.existsSync(path.join(KB, 'lint-report.md'))).toBe(true)

    expect((await send('PUT', '/api/kb-wiki/lint/settings', { lint_schedule: 'weekly' }, MEMBER)).status).toBe(403)
    const bad = await send<{ error: string }>('PUT', '/api/kb-wiki/lint/settings', { lint_hour_utc: 30 }, ADMIN)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/0 to 23/)
    const ok = await send<{ settings: { lint_schedule: string; lint_hour_utc: number } }>('PUT', '/api/kb-wiki/lint/settings', { lint_schedule: 'weekly', lint_hour_utc: 5 }, ADMIN)
    expect(ok.status).toBe(200)
    expect(ok.body.settings).toMatchObject({ lint_schedule: 'weekly', lint_hour_utc: 5 })

    const now = rawShas()
    for (const [rel, h] of Object.entries(before)) expect(now[rel], rel).toBe(h)
  })

  it('curator (obj 901768): off by default, proposes without editing, procedure pages need an admin in the browser to sign off', async () => {
    writeKb('topics/how-to-repot.md', '---\ntitle: How to repot a fern\ntype: topic\nupdated: 2026-10-01\n---\n# How to repot a fern\n\nUse the 20 cm pots.\n')
    writeKb('.kb-wiki/flags.jsonl', [
      JSON.stringify({ schema: 'kb-flag/1', id: 'f-pots', kind: 'outdated', page: 'topics/how-to-repot.md', detail: 'We switched to 25 cm pots in November.' }),
      JSON.stringify({ schema: 'kb-flag/1', id: 'f-shop', kind: 'wrong', page: SHOP, detail: 'Opening hours changed to 8-6.' }),
    ].join('\n') + '\n')
    const before = fs.readFileSync(path.join(KB, 'topics/how-to-repot.md'), 'utf8')

    const empty = await get<{ enabled: boolean; open: unknown[] }>(`/api/kb-wiki/curator?workspace=${WS}`, MEMBER)
    expect(empty.status).toBe(200)
    expect(empty.body.enabled).toBe(false)
    expect(empty.body.open).toEqual([])

    const run = await send<{ proposed: number }>('POST', `/api/kb-wiki/curator/run?workspace=${WS}`, {}, MEMBER)
    expect(run.status, JSON.stringify(run.body)).toBe(200)
    expect(run.body.proposed).toBeGreaterThan(0)
    expect(fs.readFileSync(path.join(KB, 'topics/how-to-repot.md'), 'utf8')).toBe(before)

    const list = await get<{ open: Array<{ id: string; pages: string[]; procedure: boolean }> }>(`/api/kb-wiki/curator?workspace=${WS}`, MEMBER)
    const p = list.body.open.find(x => x.pages[0] === 'topics/how-to-repot.md')!
    expect(p.procedure).toBe(true)
    const accept = `/api/kb-wiki/curator/proposals/${p.id}/accept`
    expect((await send<{ code: string }>('POST', accept, { workspace: WS, sign_off: true }, MEMBER)).body.code).toBe('procedure_needs_admin')
    const bearer = await fetch(`${base}${accept}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN.slice('token='.length)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: WS, sign_off: true }),
    })
    expect(bearer.status).toBe(403)
    expect((await send<{ code: string }>('POST', accept, { workspace: WS }, ADMIN)).body.code).toBe('procedure_needs_sign_off')
    expect(fs.readFileSync(path.join(KB, 'topics/how-to-repot.md'), 'utf8')).toBe(before)
    const ok = await send<{ proposal: { status: string; signed_off: boolean } }>('POST', accept, { workspace: WS, sign_off: true }, ADMIN)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.proposal).toMatchObject({ status: 'accepted', signed_off: true })
    expect(fs.readFileSync(path.join(KB, 'topics/how-to-repot.md'), 'utf8')).toContain('25 cm pots')
    expect((await send('POST', accept, { workspace: WS, sign_off: true }, ADMIN)).status).toBe(409)

    // A legacy per-user API key (what outside bots use) is not a person deciding, even on a domain page.
    const { mintApiKey, hashApiKey } = await import('../lib/api-keys.js')
    const legacy = mintApiKey()
    getDb().prepare('UPDATE users SET api_token_hash = ? WHERE id = 2').run(hashApiKey(legacy))
    const shop = list.body.open.find(x => x.pages[0] === SHOP)!
    const asKey = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { authorization: `Bearer ${legacy}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    for (const url of [`/api/kb-wiki/curator/proposals/${shop.id}/accept`, `/api/kb-wiki/curator/proposals/${shop.id}/reject`, '/api/kb-wiki/curator/accept-light']) {
      const r = await asKey(url, { workspace: WS })
      expect(r.status, url).toBe(403)
      expect((await r.json() as { code: string }).code).toBe('not_a_person')
    }
    // The same member signed in through the browser may accept it.
    expect((await send('POST', `/api/kb-wiki/curator/proposals/${shop.id}/accept`, { workspace: WS }, MEMBER)).status).toBe(200)

    expect((await get(`/api/kb-wiki/curator?workspace=${WS}`, OUTSIDER)).status).toBe(403)
    expect((await send('PUT', '/api/kb-wiki/lint/settings', { curator_enabled: true }, MEMBER)).status).toBe(403)
    const on = await send<{ settings: { curator_enabled: boolean } }>('PUT', '/api/kb-wiki/lint/settings', { curator_enabled: true, curator_ai_drafts: 0 }, ADMIN)
    expect(on.body.settings).toMatchObject({ curator_enabled: true, curator_ai_drafts: 0 })
    await send('PUT', '/api/kb-wiki/lint/settings', { curator_enabled: false }, ADMIN)
  })

  it('nextLintRun: off → null, nightly → the next slot, weekly → a week after the last run', () => {
    const now = new Date('2026-10-31T10:00:00Z')
    expect(nextLintRun(null, { lint_schedule: 'off', lint_hour_utc: 3 }, now)).toBeNull()
    expect(nextLintRun('2026-10-31T03:05:00Z', { lint_schedule: 'nightly', lint_hour_utc: 3 }, now)).toBe('2026-11-01T03:00:00.000Z')
    expect(nextLintRun('2026-10-30T03:05:00Z', { lint_schedule: 'nightly', lint_hour_utc: 12 }, now)).toBe('2026-10-31T12:00:00.000Z')
    expect(nextLintRun('2026-10-28T00:00:00Z', { lint_schedule: 'weekly', lint_hour_utc: 3 }, now)).toBe('2026-11-04T00:00:00.000Z')
  })

  it('agents can read the wiki through the docs routes and file answers from chat', async () => {
    updateWorkspace(WS, { doc_read_roots: [KB] })
    for (const rel of ['index.md', ROSA]) {
      const r = await get<{ content: string }>(`/api/docs/file?path=${encodeURIComponent(path.join(KB, rel))}`, MEMBER)
      expect(r.status, rel).toBe(200)
      expect(r.body.content).toContain(rel === 'index.md' ? 'generated_by: kb-wiki' : 'Rosa Delgado')
    }
    const agent = { slug: 'librarian', tools: ['file_answer', 'read_file'], knowledge_folders: ['.'] } as unknown as Parameters<typeof runTool>[0]['agent']
    // obj 900797: a bot works only in workspaces it is granted.
    const { grantBotWorkspace } = await import('../services/agent-chat/bot-workspaces.js')
    grantBotWorkspace('librarian', WS, 'admin')
    const ctx = { userId: 2, username: 'u2', workspace: WS, agent, kbRoot: KB, connectors: {} } as Parameters<typeof runTool>[0]
    const out = runTool(ctx, 'file_answer', { question: 'Who supplies compost?', answer: 'Greenway Growers.', sources: [SHOP] })
    expect(out.summary).toMatch(/^Saved the answer to the wiki as answers\//)
    const saved = (out.result as { saved: string }).saved
    expect(fs.readFileSync(path.join(KB, saved), 'utf8')).toContain('librarian')
    expect(String((runTool(ctx, 'read_file', { path: 'index.md' }).result as { content: string }).content)).toContain('Who supplies compost?')
  })

  it('a bot cannot release a held answer by rewriting the file; a person in the editor can (obj 901746)', async () => {
    const { checkAndFileAnswer } = await import('../services/kb-wiki/answers.js')
    const held = await checkAndFileAnswer(KB, { question: 'Does Fernleaf ship to Antarctica?', answer: `Yes, Fernleaf ships to Antarctica [[${SHOP}]].`, sources: [SHOP] },
      async () => '{"unsupported":[{"claim":"Fernleaf ships to Antarctica","why":"The page does not say so."}]}')
    expect(held.check.status).toBe('held')
    const agent = { slug: 'librarian', tools: ['write_doc', 'read_file'], knowledge_folders: ['.'] } as unknown as Parameters<typeof runTool>[0]['agent']
    const ctx = { userId: 2, username: 'u2', workspace: WS, agent, kbRoot: KB, connectors: {} } as Parameters<typeof runTool>[0]
    const text = fs.readFileSync(path.join(KB, held.rel), 'utf8')
    expect(() => runTool(ctx, 'write_doc', { path: held.rel, content: text.replace('answer_check: held', 'answer_check: passed') })).toThrow('until a person reviews it')
    expect(fs.readFileSync(path.join(KB, held.rel), 'utf8')).toContain('answer_check: held')
    // Editing the text while keeping the hold is fine.
    expect(runTool(ctx, 'write_doc', { path: held.rel, content: `${text}\nA note.\n` }).summary).toContain('Saved')
    // A person signed in to the app is reviewing when they edit it themselves.
    updateWorkspace(WS, { doc_write_roots: [KB] } as Parameters<typeof updateWorkspace>[1])
    const put = await send('PUT', '/api/docs/file', { path: path.join(KB, held.rel), content: text.replace('answer_check: held', 'answer_check: reviewed') }, ADMIN)
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    fs.rmSync(path.join(KB, held.rel)); compileWiki(KB)
  })

  it('rebuild is admin-only, needs confirm, sets pages aside and keeps raw + answers', async () => {
    expect((await send('POST', `/api/kb-wiki/rebuild?workspace=${WS}`, { confirm: true }, MEMBER)).status).toBe(403)
    expect((await send('POST', `/api/kb-wiki/rebuild?workspace=${WS}`, {}, ADMIN)).status).toBe(400)
    const r = await send<{ moved: number; trash: string; importsRequeued: number }>('POST', `/api/kb-wiki/rebuild?workspace=${WS}`, { confirm: true }, ADMIN)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.moved).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(KB, r.body.trash, ROSA))).toBe(true)
    expect(fs.existsSync(path.join(KB, answerRel))).toBe(true)
    await whenImportsIdle(KB)
    const now = rawShas()
    for (const [rel, h] of Object.entries(before)) expect(now[rel], rel).toBe(h)
  })
})
