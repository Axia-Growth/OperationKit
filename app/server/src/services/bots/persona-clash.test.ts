/**
 * obj 901026 — an agents-table row that collides with a chat bot's slug is
 * found and can be archived (with a backup), one at a time, never the
 * default roster.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-persona-clash-${process.pid}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-persona-clash-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'

// An install-local chat bot called "operation-kit-dev" — the reported case.
fs.mkdirSync(path.join(TMP_AGENTS, 'operation-kit-dev'), { recursive: true })
fs.writeFileSync(
  path.join(TMP_AGENTS, 'operation-kit-dev', 'agent.yaml'),
  'name: Operation Kit Dev\ndescription: Builds things\ntools: []\nknowledge_folders: []\nsystem_prompt: You help.\n',
)

const { initDb, getDb } = await import('../../db/index.js')
const { createAgent, agentExists, getAgent } = await import('../agent-registry.js')
const { findPersonaBotClashes, archivePersonaClash, readPersonaClashBackups } = await import('./persona-clash.js')

beforeAll(() => { initDb() })
afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix) } catch { /* ignore */ }
  }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

describe('findPersonaBotClashes', () => {
  it('flags an accidental agents-table row for a chat bot slug, never the default roster', () => {
    createAgent({ slug: 'operation-kit-dev', label: 'Operation Kit Dev (accidental)' })
    const clashes = findPersonaBotClashes()
    expect(clashes.map(c => c.slug)).toContain('operation-kit-dev')
    expect(clashes.find(c => c.slug === 'operation-kit-dev')?.botName).toBe('Operation Kit Dev')
    // The default roster (cto/cmo/coo/cfo/general) is never listed, even though
    // some installs run chat bots under those very names.
    expect(clashes.map(c => c.slug)).not.toContain('cto')
    expect(clashes.map(c => c.slug)).not.toContain('general')
  })

  it('lists nothing once no agents-table row shares a bot slug', () => {
    expect(findPersonaBotClashes().map(c => c.slug)).not.toContain('kb-librarian')
  })
})

describe('archivePersonaClash', () => {
  it('backs up then archives the row; a second read sees it archived', () => {
    createAgent({ slug: 'ops-dup', label: 'Ops Dup' })
    const before = getAgent('ops-dup')
    const r = archivePersonaClash('ops-dup')
    expect(r).toEqual({ ok: true })
    expect(agentExists('ops-dup')).toBe(true) // archived, not deleted — still resolvable for historical cards
    expect(getAgent('ops-dup')?.archived).toBe(true)
    const backups = readPersonaClashBackups() as Array<{ slug: string }>
    expect(backups.some(b => b.slug === 'ops-dup')).toBe(true)
    expect(backups.find(b => b.slug === 'ops-dup')).toMatchObject(before ?? {})
  })

  it('refuses a default-roster slug outright, with no mutation', () => {
    const before = getAgent('general')
    const r = archivePersonaClash('general')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/default-roster persona/)
    expect(getAgent('general')).toEqual(before)
  })

  it('refuses an unknown slug', () => {
    expect(archivePersonaClash('not-a-real-slug')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refuses a slug with active non-terminal objectives, same as archiveAgent', () => {
    createAgent({ slug: 'ops-busy', label: 'Ops Busy' })
    getDb()
      .prepare(
        `INSERT INTO objectives (title, agent_context, workspace, type, status, model) VALUES ('Active work', 'ops-busy', 'default', 'task', 'working', 'm')`,
      )
      .run()
    const r = archivePersonaClash('ops-busy')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/active objective/)
    expect(getAgent('ops-busy')?.archived).toBe(false)
  })
})
