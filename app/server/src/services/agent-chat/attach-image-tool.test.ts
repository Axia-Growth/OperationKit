// attach_image (obj 901028): a bot tool that attaches a screenshot to its own
// reply so it renders inline in chat — from a knowledge-base path, a card
// artifact (same person ∩ bot visibility get_objective enforces), or base64
// image data the tool generated itself. Reuses the attachments.ts validation
// (bytes decide the type, 5 MB cap) and live-artifacts.ts's traversal guard
// (NOTES.md masked, no escaping the card's objective-memory dir).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-attach-image-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-chat-attach-image-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-attach-image-kb-'))
const TMP_MEM = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-attach-image-mem-'))
process.env.OBJECTIVE_MEMORY_ROOT = TMP_MEM

const { initDb, getDb } = await import('../../db/index.js')
const { runTool, ToolUseError } = await import('./tools.js')
const { seedExistingBotsOnce } = await import('./bot-workspaces.js')
type Agent = import('./agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ALICE = 2
const BOB = 3
const GROWTH = 'growth'
const OTHER = 'other-co'

/** Smallest real PNG: 1×1 transparent. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const PNG_B64 = PNG.toString('base64')
const NOT_AN_IMAGE = Buffer.from('hello, not an image')

const agent: Agent = {
  slug: 'shot-bot',
  name: 'Shot Bot',
  description: '',
  avatar: '',
  colour: 'blue',
  system_prompt: '',
  knowledge_folders: ['shots'],
  tools: ['attach_image', 'get_objective'],
  model: null,
  provider: null,
  schedules: [],
  version: null,
  author: null,
  how_to_use: '',
  example_prompts: [],
  source: 'file',
  file: '/dev/null',
}

function ctx(userId: number, a: Agent = agent) {
  return { userId, username: `user${userId}`, workspace: GROWTH, agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } }
}

let growthCard: number
let otherCard: number

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`).run(ALICE, 'alice')
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`).run(BOB, 'bob')
  seedExistingBotsOnce(['shot-bot'])
  for (const ws of [GROWTH, OTHER]) db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(ws, ws)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(ALICE, GROWTH)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(BOB, OTHER)
  growthCard = Number(
    db.prepare(`INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id) VALUES ('growth card', '', ?, 'working', 'task', 'general', ?, ?)`)
      .run(GROWTH, ALICE, ALICE).lastInsertRowid,
  )
  otherCard = Number(
    db.prepare(`INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id) VALUES ('other card', '', ?, 'working', 'task', 'general', ?, ?)`)
      .run(OTHER, BOB, BOB).lastInsertRowid,
  )

  // Knowledge-base fixtures (a "shared notes" folder — no workspace row named
  // "shots", so the workspace wall does not apply; knowledge_folders alone decide).
  fs.mkdirSync(path.join(TMP_KB, 'shots'), { recursive: true })
  fs.writeFileSync(path.join(TMP_KB, 'shots', 'ok.png'), PNG)
  fs.writeFileSync(path.join(TMP_KB, 'shots', 'not-image.png'), NOT_AN_IMAGE)
  fs.writeFileSync(path.join(TMP_KB, 'secret.png'), PNG) // outside knowledge_folders

  // Card artifact fixtures.
  const growthMem = path.join(TMP_MEM, String(growthCard))
  fs.mkdirSync(path.join(growthMem, 'live'), { recursive: true })
  fs.writeFileSync(path.join(growthMem, 'live', 'screenshot.png'), PNG)
  fs.writeFileSync(path.join(growthMem, 'NOTES.md'), 'scratch\n')
  const otherMem = path.join(TMP_MEM, String(otherCard))
  fs.mkdirSync(path.join(otherMem, 'live'), { recursive: true })
  fs.writeFileSync(path.join(otherMem, 'live', 'screenshot.png'), PNG)
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
  fs.rmSync(TMP_MEM, { recursive: true, force: true })
})

describe('attach_image: source "kb"', () => {
  it('attaches a real PNG from a knowledge folder, with the bytes it validated', () => {
    const out = runTool(ctx(ALICE), 'attach_image', { source: 'kb', path: 'shots/ok.png', alt_text: 'a screenshot' })
    expect(out.images).toHaveLength(1)
    expect(out.images![0].media_type).toBe('image/png')
    expect(out.images![0].bytes.equals(PNG)).toBe(true)
    expect(out.images![0].alt_text).toBe('a screenshot')
    expect((out.result as Loose).media_type).toBe('image/png')
    expect(out.summary).toMatch(/Attached image/)
  })

  it('believes the bytes, not the extension: a mislabelled file is refused', () => {
    expect(() => runTool(ctx(ALICE), 'attach_image', { source: 'kb', path: 'shots/not-image.png' })).toThrow(/not a PNG, JPEG, GIF or WebP/)
  })

  it('outside the agent\'s knowledge folders is refused, same as read_file', () => {
    expect(() => runTool(ctx(ALICE), 'attach_image', { source: 'kb', path: 'secret.png' })).toThrow(ToolUseError)
  })

  it('a bot without the tool cannot call it', () => {
    const noTool: Agent = { ...agent, tools: ['get_objective'] }
    expect(() => runTool(ctx(ALICE, noTool), 'attach_image', { source: 'kb', path: 'shots/ok.png' })).toThrow(/not allowed/)
  })
})

describe('attach_image: source "card_artifact"', () => {
  it('attaches a screenshot from a card the person ∩ bot can see', () => {
    const out = runTool(ctx(ALICE), 'attach_image', { source: 'card_artifact', objective_id: growthCard, path: 'live/screenshot.png' })
    expect(out.images![0].bytes.equals(PNG)).toBe(true)
    expect(out.images![0].name).toBe('screenshot.png')
  })

  it('a card in a workspace the person cannot see reads as not found, same as get_objective', () => {
    expect(() => runTool(ctx(ALICE), 'attach_image', { source: 'card_artifact', objective_id: otherCard, path: 'live/screenshot.png' }))
      .toThrow(/not on a board you can see/)
  })

  it('NOTES.md is never served, even through this tool', () => {
    expect(() => runTool(ctx(ALICE), 'attach_image', { source: 'card_artifact', objective_id: growthCard, path: 'NOTES.md' })).toThrow(ToolUseError)
  })

  it('path traversal out of the card\'s memory dir is refused', () => {
    expect(() => runTool(ctx(ALICE), 'attach_image', { source: 'card_artifact', objective_id: growthCard, path: `../${otherCard}/live/screenshot.png` })).toThrow(ToolUseError)
  })

  it('objective_id is required and must be a real card number', () => {
    expect(() => runTool(ctx(ALICE), 'attach_image', { source: 'card_artifact', path: 'live/screenshot.png' })).toThrow(/objective_id/)
  })
})

describe('attach_image: source "data"', () => {
  it('attaches base64 bytes the tool generated itself (e.g. a chart)', () => {
    const out = runTool(ctx(ALICE), 'attach_image', { source: 'data', data: PNG_B64, path: 'chart.png', alt_text: 'spend by month' })
    expect(out.images![0].media_type).toBe('image/png')
    expect(out.images![0].name).toBe('chart.png')
    expect(out.images![0].alt_text).toBe('spend by month')
  })

  it('a non-image payload is rejected, not silently stored', () => {
    expect(() => runTool(ctx(ALICE), 'attach_image', { source: 'data', data: NOT_AN_IMAGE.toString('base64') })).toThrow(/not a PNG, JPEG, GIF or WebP/)
  })

  it('an oversized payload is rejected (same 5 MB cap a pasted chat image gets)', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]).toString('base64')
    expect(() => runTool(ctx(ALICE), 'attach_image', { source: 'data', data: huge })).toThrow(/too big/)
  })
})

it('an unknown source is refused with a clear message', () => {
  expect(() => runTool(ctx(ALICE), 'attach_image', { source: 'sandbox' })).toThrow(/source must be/)
})
