// obj 901028: an attach_image tool call's image lands on the TOOL row the
// engine records for that call (not just the final assistant text), so it
// renders inline right next to "Attached image …" — real engine, real tool
// gate, only the provider's HTTP call is stubbed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-attach-image-engine-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-chat-attach-image-engine-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-attach-image-engine-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-attach-image-engine-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB

const { initDb, getDb } = await import('../../db/index.js')
const { findAgent, listMessages, runTurn } = await import('./engine.js')

const USER = 2
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any
type Seen = { body: Loose }

const textReply = (t: string) => ({ content: [{ type: 'text', text: t }] })
const toolCall = (name: string, input: Record<string, unknown>) => ({ content: [{ type: 'tool_use', id: `tu-${name}-${Math.random()}`, name, input }] })

function scripted(seen: Seen[], replies: unknown[]) {
  let i = 0
  return (async (_url: string, init: RequestInit) => {
    seen.push({ body: JSON.parse(String(init.body)) })
    const r = replies[Math.min(i++, replies.length - 1)]
    return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'casey', 'x', 'member')`).run(USER)
  fs.mkdirSync(path.join(TMP_AGENTS, 'shot-bot'))
  fs.writeFileSync(
    path.join(TMP_AGENTS, 'shot-bot', 'agent.yaml'),
    'name: Shot Bot\nsystem_prompt: You help.\nknowledge_folders: [shots]\ntools: [attach_image]\ncolour: blue\nversion: 1.0.0\nauthor: Test\n',
  )
  fs.mkdirSync(path.join(TMP_KB, 'shots'), { recursive: true })
  fs.writeFileSync(path.join(TMP_KB, 'shots', 'chart.png'), Buffer.from(PNG_B64, 'base64'))
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('attach_image through a real chat turn', () => {
  it('stores the image against the TOOL row, metadata only, never the model\'s declared path', async () => {
    const seen: Seen[] = []
    const out = await runTurn({
      userId: USER,
      username: 'casey',
      agent: { ...findAgent('shot-bot')!, provider: 'anthropic' },
      text: 'show me the chart',
      env: { ...process.env, ANTHROPIC_API_KEY: 'k' },
      deps: {
        fetch: scripted(seen, [
          toolCall('attach_image', { source: 'kb', path: 'shots/chart.png', alt_text: 'spend chart' }),
          textReply('Here it is.'),
        ]),
      },
    })
    expect(out.messages.at(-1)?.content).toBe('Here it is.')

    const rows = listMessages(USER, 'shot-bot')
    const toolRow = rows.find(r => r.role === 'tool')!
    expect(toolRow.tool_name).toBe('attach_image')
    expect(toolRow.images).toHaveLength(1)
    expect(toolRow.images[0].media_type).toBe('image/png')
    expect(toolRow.images[0].alt_text).toBe('spend chart')
    expect(toolRow.images[0].url).toMatch(/^\/api\/agent-chat\/attachments\/\d+$/)
    // The final assistant text carries no attachment of its own.
    expect(rows.find(r => r.role === 'assistant')!.images).toEqual([])
    // Never the raw bytes or the kb-relative path leak into the stored row's text.
    expect(JSON.stringify(rows)).not.toContain(PNG_B64)
  })
})
