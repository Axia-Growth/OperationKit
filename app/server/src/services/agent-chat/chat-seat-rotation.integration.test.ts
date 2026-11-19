import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { spawnSync } from 'child_process'

// obj 901395 — a bot chat turn died after four tool calls with "Couldn't
// answer. The AI provider failed: claude exited 0:" (an EMPTY reason) and the
// owner had to send the message again by hand. This drives the REAL path end
// to end (HTTP route → engine → Claude provider → seat pool → runClaudeTurn
// spawning a `claude` binary; only the binary is fake) and proves:
//   - an empty exit, or a usage limit, moves the SAME reply to the next account;
//   - a tool that already ran is NOT run a second time by the move;
//   - the chat gets one small line naming seat labels only;
//   - when every account is limited the person is told so in plain words, with
//     the count and the first reset time, never an empty reason.
//
// Fake credentials only. They must never appear in a response or a log line.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-rotate-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')
process.env.CC_SEAT_HOME_ROOT = path.join(TMP, 'seats')
process.env.CC_LEGACY_CODEX_HOME = path.join(TMP, 'no-legacy-codex')
process.env.GROK_HOME_DIR = path.join(TMP, 'no-legacy-grok')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.JWT_SECRET = 'test-secret-chat-seat-rotation-xx'
process.env.AGENT_FILES_DIR = path.join(TMP, 'agents')
process.env.KNOWLEDGE_BASE_DIR = path.join(TMP, 'kb')
process.env.AGENT_CHAT_PROVIDER = 'claude'
process.env.AGENT_CHAT_TIMEOUT_MS = '20000'
delete process.env.AGENT_CHAT_CLAUDE_OAUTH_TOKEN
delete process.env.AGENT_CHAT_SLOTS
delete process.env.LLM_GATEWAY_SLOTS
// The OVH trial install: sandboxed card sessions + the installer's one server token.
process.env.SESSION_ISOLATION = 'docker'
const SERVER_TOKEN = 'fake-server-token-for-tests-3333333333333333-ddd4'
process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN = SERVER_TOKEN
const TOKEN_1 = 'fake-setup-token-for-tests-0000000000000000-aaa1'
const TOKEN_2 = 'fake-setup-token-for-tests-1111111111111111-bbb2'
const ALL_TOKENS = [TOKEN_1, TOKEN_2, SERVER_TOKEN]
const LABEL: Record<string, string> = { [TOKEN_1]: 'seat-1', [TOKEN_2]: 'seat-2', [SERVER_TOKEN]: 'server' }

// ── the fake `claude` CLI ──
const CALLS = path.join(TMP, 'calls.jsonl')
const BEHAVIOUR = path.join(TMP, 'behaviour.json')
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require('fs')
if (process.argv[2] === '--probe') { console.log('fake-claude'); process.exit(0) }
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(BEHAVIOUR)}, 'utf8'))
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || ''
const who = cfg.labels[token] || (token ? 'unknown' : 'none')
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
let stdin = ''
process.stdin.on('data', d => { stdin += d })
process.stdin.on('end', () => {
  const afterTool = stdin.includes('<tool_result')
  const log = outcome => fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ who, afterTool, outcome }) + '\\n')
  const when = list => (list || []).some(e => e === who || (e === who + ':after-tool' && afterTool))
  // The 2026-11-17 failure: exit 0, nothing on stdout, nothing on stderr.
  if (when(cfg.empty)) { log('empty'); process.exit(0) }
  if (when(cfg.rateLimited)) {
    log('rate-limited')
    out({ type: 'result', subtype: 'error', is_error: true, result: "You've hit your usage limit · " + cfg.resets, usage: {} })
    process.exit(1)
  }
  const say = text => {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
    out({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 })
    process.exit(0)
  }
  // A two-step turn: first the model asks for a tool that WRITES, then answers.
  if (cfg.useTool && !afterTool) {
    log('tool-call')
    return say('<tool_calls>[{"name":"write_doc","arguments":{"path":"notes/log.md","content":"written once"}}]</tool_calls>')
  }
  log('ok')
  say('Answered by ' + who)
})
`

// The fake must really be the one that runs. Some machines mount /tmp noexec,
// and then execvp silently falls through to the next PATH entry — a real
// `claude`. So: put it in the first dir where it actually executes, and make
// it the ONLY thing on PATH, so a failure is ENOENT, never the real CLI.
const EXTRA_DIRS: string[] = []
function installFakeClaude(): string {
  const candidates = [path.join(TMP, 'bin'), path.join(process.cwd(), `.cc-test-fake-claude-${process.pid}`)]
  for (const dir of candidates) {
    fs.mkdirSync(dir, { recursive: true })
    if (!dir.startsWith(TMP)) EXTRA_DIRS.push(dir)
    const bin = path.join(dir, 'claude')
    fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 })
    // An extensionless script under a "type": "module" package would load as ESM.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}')
    const r = spawnSync(bin, ['--probe'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim() === 'fake-claude') return dir
  }
  throw new Error('could not install an executable fake claude')
}
const BIN = installFakeClaude()
process.env.CC_CLI_BIN_DIR = BIN
process.env.PATH = BIN

function behave(b: { empty?: string[]; rateLimited?: string[]; useTool?: boolean; resets?: string } = {}): void {
  fs.writeFileSync(BEHAVIOUR, JSON.stringify({ labels: LABEL, empty: b.empty ?? [], rateLimited: b.rateLimited ?? [], useTool: !!b.useTool, resets: b.resets ?? 'try again in 45 minutes' }))
  fs.rmSync(CALLS, { force: true })
}
function calls(): { who: string; afterTool: boolean; outcome: string }[] {
  if (!fs.existsSync(CALLS)) return []
  return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

vi.mock('../../ws/index.js', () => ({ broadcast: vi.fn() }))

const logged: string[] = []
for (const fn of ['log', 'warn', 'error', 'info'] as const) {
  vi.spyOn(console, fn).mockImplementation((...args: unknown[]) => {
    logged.push(args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' '))
  })
}

const express = (await import('express')).default
const cookieParser = (await import('cookie-parser')).default
const jwt = (await import('jsonwebtoken')).default
const { initDb, getDb } = await import('../../db/index.js')
const seatRouter = await import('../account-router.js')
const { whenLaneIdle } = await import('./engine.js')
const creds = await import('../seat-credentials.js')
const { default: chatRouter } = await import('../../routes/agent-chat.js')

const OWNER = 2
const BOTS = ['rotation-bot']

let server: http.Server
let baseUrl = ''
const bodies: string[] = []

async function say(slug: string, text: string): Promise<{ status: number; json: any; retryAfter: string | null }> {
  const t = jwt.sign({ id: OWNER, username: 'owner', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const res = await fetch(`${baseUrl}/api/agent-chat/agents/${slug}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${t}` },
    body: JSON.stringify({ text }),
  })
  const body = await res.text()
  bodies.push(body)
  return { status: res.status, json: body ? JSON.parse(body) : null, retryAfter: res.headers.get('retry-after') }
}

async function history(slug: string): Promise<any[]> {
  const t = jwt.sign({ id: OWNER, username: 'owner', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const res = await fetch(`${baseUrl}/api/agent-chat/agents/${slug}/messages`, { headers: { Cookie: `token=${t}` } })
  const body = await res.text()
  bodies.push(body)
  return (JSON.parse(body).messages ?? []) as any[]
}

const seats: { id: string }[] = []
const DOC = path.join(process.env.KNOWLEDGE_BASE_DIR!, 'notes', 'log.md')
const BOT = BOTS[0]
const seat = (i: number) => seatRouter.getAccountById(seats[i].id)!

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'owner', 'x', 'member')`).run(OWNER)
  for (const slug of BOTS) {
    fs.mkdirSync(path.join(process.env.AGENT_FILES_DIR!, slug), { recursive: true })
    fs.writeFileSync(
      path.join(process.env.AGENT_FILES_DIR!, slug, 'agent.yaml'),
      `name: ${slug}\nsystem_prompt: You help.\nknowledge_folders:\n  - notes\ntools:\n  - write_doc\nversion: 1.0.0\nauthor: Test\n`,
    )
  }
  fs.mkdirSync(path.join(process.env.KNOWLEDGE_BASE_DIR!, 'notes'), { recursive: true })

  // Two pasted setup-token seats, exactly as Settings → Seats stores them.
  for (const [i, token] of [TOKEN_1, TOKEN_2].entries()) {
    const id = `s${i + 1}`
    const { ref, hint } = creds.storeSeatCredential(id, token)
    const seat = seatRouter.addAccountSlot({ label: `Seat ${i + 1}`, credentialKind: 'setup_token', credentialRef: ref, credentialHint: hint })
    seats.push(seat)
  }

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', chatRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  for (const slug of BOTS) await whenLaneIdle(OWNER, slug)
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* closed */ }
  vi.restoreAllMocks()
  fs.rmSync(TMP, { recursive: true, force: true })
  for (const d of EXTRA_DIRS) fs.rmSync(d, { recursive: true, force: true })
})

beforeEach(async () => {
  // obj 900949: a message queued behind a running turn is delivered by a
  // background drain; let it finish before the next case reads the seats.
  for (const slug of BOTS) await whenLaneIdle(OWNER, slug)
  behave()
  // Every seat is busy with card sessions, as on the trial install.
  // Persisted, so the next loadState() does not bring a cool-down back.
  for (const s of seatRouter.listSeatRecords()) {
    seatRouter.forceClearRateLimit(s.id)
    seatRouter.clearRateLimit(s.id)
  }
  fs.rmSync(DOC, { force: true })
  for (const slug of BOTS) getDb().prepare('DELETE FROM agent_chat_messages WHERE agent_slug = ?').run(slug)
})

describe('a limited or empty account hands the reply to the next one (obj 901395)', () => {
  it('reproduces the incident shape: an empty exit is no longer "claude exited 0:" — the next account answers', async () => {
    behave({ empty: ['seat-1'] })
    const r = await say(BOT, 'hello')
    expect(r.status).toBe(200)
    const rows = r.json.messages as any[]
    expect(rows.map(m => m.role)).toEqual(['user', 'error', 'assistant'])
    expect(rows[2].content).toBe('Answered by seat-2')
    // The one small line: seat LABELS only.
    expect(rows[1].meta.kind).toBe('seat_moved')
    expect(rows[1].content).toBe('Seat 1 returned nothing, so this reply moved to Seat 2. Nothing was run twice.')
    expect(calls().map(c => `${c.who}:${c.outcome}`)).toEqual(['seat-1:empty', 'seat-2:ok'])
    // The empty seat rests for the short window, flagged as an empty reply (not a usage limit).
    expect(seat(0).cooldownReason).toBe('empty_turn')
    const restMs = Date.parse(seat(0).rateLimitResetsAt!) - Date.now()
    expect(restMs).toBeGreaterThan(4 * 60_000)
    expect(restMs).toBeLessThanOrEqual(5 * 60_000)
    expect(seat(0).consecutiveFailures ?? 0).toBe(0)
    expect(seat(1).rateLimitResetsAt).toBeNull()
  })

  it('a tool that already ran is NOT run again when the reply moves to another account mid-turn', async () => {
    // seat-1 asks for write_doc (a WRITE), the server runs it, then seat-1 comes
    // back empty on the next model call. seat-2 must continue from the recorded
    // tool result, not start the turn over.
    behave({ useTool: true, empty: ['seat-1:after-tool'] })
    const writes: string[] = []
    const realWrite = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, ...rest: any[]) => {
      if (String(file) === DOC) writes.push(String(file))
      return (realWrite as any)(file, ...rest)
    }) as any)
    let r
    try { r = await say(BOT, 'write the note') } finally { spy.mockRestore() }
    expect(r.status).toBe(200)
    const rows = r.json.messages as any[]
    expect(rows.map(m => m.role)).toEqual(['user', 'tool', 'error', 'assistant'])
    // Exactly one execution of the side effect.
    expect(writes).toHaveLength(1)
    expect(rows.filter(m => m.role === 'tool')).toHaveLength(1)
    expect(rows[1].tool_name).toBe('write_doc')
    expect(fs.readFileSync(DOC, 'utf8')).toBe('written once')
    expect(rows[2].meta.kind).toBe('seat_moved')
    expect(rows[3].content).toBe('Answered by seat-2')
    // The model was never asked to plan the turn again: the only call that did
    // not carry the tool result is the first one, and seat-2 was handed the result.
    expect(calls()).toEqual([
      { who: 'seat-1', afterTool: false, outcome: 'tool-call' },
      { who: 'seat-1', afterTool: true, outcome: 'empty' },
      { who: 'seat-2', afterTool: true, outcome: 'ok' },
    ])
  })

  it('a usage limit parks the account until the reset time the CLI gave, and the reply moves on', async () => {
    behave({ rateLimited: ['seat-1'], resets: 'try again in 45 minutes' })
    const r = await say(BOT, 'hello')
    expect(r.status).toBe(200)
    const rows = r.json.messages as any[]
    expect(rows[1].content).toBe('Seat 1 reached its usage limit, so this reply moved to Seat 2. Nothing was run twice.')
    expect(rows[2].content).toBe('Answered by seat-2')
    expect(seat(0).cooldownReason).toBe('limit')
    const mins = (Date.parse(seat(0).rateLimitResetsAt!) - Date.now()) / 60_000
    expect(mins).toBeGreaterThan(44)
    expect(mins).toBeLessThanOrEqual(45)
    // The next message does not even try the parked account.
    behave()
    const again = await say(BOT, 'and again')
    expect(again.status).toBe(200)
    expect(calls().map(c => c.who)).toEqual(['seat-2'])
    expect(again.json.messages.map((m: any) => m.role)).toEqual(['user', 'assistant'])
  })

  it('every account limited → plain words: how many accounts, and when the first one resets', async () => {
    behave({ rateLimited: ['seat-1', 'seat-2', 'server'], resets: 'try again in 45 minutes' })
    const r = await say(BOT, 'hello')
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('ai_unavailable')
    expect(r.json.reason).toBe('rate_limited')
    expect(r.json.error).toMatch(/^All 2 Claude accounts are at their usage limit\. The first one resets at \d{1,2}:\d{2}\s?[AP]M \S+ \(in about 4[45] minutes\)\. /)
    expect(r.json.error).not.toMatch(/claude exited/)
    // Nothing ran, so the message is handed back (not stored half-answered).
    expect(await history(BOT)).toEqual([])
  })

  it('every account limited AFTER a tool ran → the tool line stays, the reason is shown, and nothing is repeated', async () => {
    behave({ useTool: true, rateLimited: ['seat-1:after-tool', 'seat-2:after-tool', 'server:after-tool'] })
    const r = await say(BOT, 'write the note')
    expect(r.status).toBe(503)
    const rows = await history(BOT)
    expect(rows.map(m => m.role)).toEqual(['user', 'tool', 'error'])
    expect(rows[2].content).toMatch(/^All 2 Claude accounts are at their usage limit\./)
    expect(calls().filter(c => c.outcome === 'tool-call')).toHaveLength(1)
  })

  it('every account empty → says so (never an empty reason), and gives the accounts back', async () => {
    behave({ empty: ['seat-1', 'seat-2', 'server'] })
    const r = await say(BOT, 'hello')
    expect(r.status).toBe(503)
    expect(r.json.reason).toBe('empty')
    expect(r.json.error).toMatch(/^The AI returned nothing on 3 accounts in a row \(Seat 1, Seat 2, the server account\), so this is not one account's usage limit\./)
    expect(r.json.error).not.toMatch(/claude exited|: *$/)
    // Not the seats' fault: one broken request must not bench the pool cards run on.
    expect(seat(0).rateLimitResetsAt).toBeNull()
    expect(seat(1).rateLimitResetsAt).toBeNull()
  })

  it('the cap on accounts per reply is a setting (seat_rotation_max_seats_per_turn)', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('seat_rotation_max_seats_per_turn', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    try {
      behave({ rateLimited: ['seat-1'] })
      const r = await say(BOT, 'hello')
      expect(r.status).toBe(503)
      expect(r.json.error).toBe('This reply tried 1 Claude account and none could answer. 1 more account is free: send your message again.')
      expect(calls().map(c => c.who)).toEqual(['seat-1'])
    } finally {
      getDb().prepare("DELETE FROM settings WHERE key = 'seat_rotation_max_seats_per_turn'").run()
    }
  })

  it('never puts a credential value or an email address in a response or a log line', () => {
    const haystack = [...bodies, ...logged].join('\n')
    for (const t of ALL_TOKENS) expect(haystack).not.toContain(t)
    expect(bodies.join('\n')).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
  })
})
