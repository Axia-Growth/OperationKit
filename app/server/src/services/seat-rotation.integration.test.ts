import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'

// obj 901395 — the seat-rotation pieces below the chat: the three operator
// settings, the cool-down a limited / empty seat gets (real router, temp state
// file), the plain-words "all accounts are limited" message, the card-session
// no-op rest, and the Settings route. Fake credentials only.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seat-rotation-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')
process.env.CC_SEAT_HOME_ROOT = path.join(TMP, 'seats')
process.env.CC_LEGACY_CODEX_HOME = path.join(TMP, 'no-legacy-codex')
process.env.GROK_HOME_DIR = path.join(TMP, 'no-legacy-grok')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 5).toString('base64')
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.JWT_SECRET = 'test-secret-seat-rotation-xxxxxxx'
delete process.env.SESSION_ISOLATION
delete process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN
delete process.env.SESSION_JAIL_ANTHROPIC_API_KEY
delete process.env.AGENT_CHAT_SLOTS
delete process.env.LLM_GATEWAY_SLOTS
for (const k of ['CC_SEAT_LIMIT_COOLDOWN_MINUTES', 'CC_SEAT_EMPTY_TURN_COOLDOWN_MINUTES', 'CC_SEAT_ROTATION_MAX_SEATS_PER_TURN']) delete process.env[k]

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }))
vi.spyOn(console, 'log').mockImplementation(() => undefined)

const express = (await import('express')).default
const { initDb, getDb } = await import('../db/index.js')
const router = await import('./account-router.js')
const creds = await import('./seat-credentials.js')
const settings = await import('./seat-rotation-settings.js')
const { BackendError } = await import('./llm-gateway/claude-cli-backend.js')
const { unavailableFromBackend, formatResetTime, seatMoveLine } = await import('./agent-chat/providers.js')
const { restSeatAfterNoOpSpawn } = await import('./noop-seat-rest.js')
const { default: seatsRouter } = await import('../routes/admin-seats.js')

const setSetting = (k: string, v: string | null) =>
  v === null
    ? getDb().prepare('DELETE FROM settings WHERE key = ?').run(k)
    : getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)

const ids: string[] = []
const seat = (i: number) => router.getAccountById(ids[i])!
let server: http.Server
let base = ''

beforeAll(async () => {
  initDb()
  for (const [i, token] of ['fake-setup-token-for-tests-0000000000000000-aaa1', 'fake-setup-token-for-tests-1111111111111111-bbb2'].entries()) {
    const { ref, hint } = creds.storeSeatCredential(`r${i + 1}`, token)
    ids.push(router.addAccountSlot({ label: `Seat ${i + 1}`, credentialKind: 'setup_token', credentialRef: ref, credentialHint: hint }).id)
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 1, username: 'admin', role: 'admin' }; next() })
  app.use('/api/admin', seatsRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  base = `http://127.0.0.1:${addr.port}/api/admin`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* closed */ }
  vi.restoreAllMocks()
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  for (const id of ids) { router.forceClearRateLimit(id); router.clearRateLimit(id) }
  for (const k of Object.values(settings.SEAT_ROTATION_SETTING)) setSetting(k, null)
})

describe('the three settings', () => {
  it('defaults: 15 minute limit rest, 5 minute empty-reply rest, 4 accounts per reply', () => {
    expect(settings.seatRotationSettings()).toEqual({ limitCooldownMinutes: 15, emptyTurnCooldownMinutes: 5, maxSeatsPerTurn: 4 })
  })

  it('a settings row changes the value with no restart; the env var wins over it', () => {
    setSetting('seat_limit_cooldown_minutes', '30')
    setSetting('seat_rotation_max_seats_per_turn', '6')
    expect(settings.seatRotationSettings()).toMatchObject({ limitCooldownMinutes: 30, maxSeatsPerTurn: 6 })
    expect(settings.seatRotationSettings({ CC_SEAT_ROTATION_MAX_SEATS_PER_TURN: '2' }).maxSeatsPerTurn).toBe(2)
  })

  it('garbage or an out-of-range value falls back to the default instead of benching a seat for a week', () => {
    for (const bad of ['abc', '-3', '0', '1.5', '99999']) {
      setSetting('seat_limit_cooldown_minutes', bad)
      expect(settings.seatRotationSettings().limitCooldownMinutes).toBe(15)
    }
    setSetting('seat_empty_turn_cooldown_minutes', '0') // 0 is allowed here: rotate without resting
    expect(settings.seatRotationSettings().emptyTurnCooldownMinutes).toBe(0)
  })
})

describe('parking a limited account', () => {
  it('uses the reset time the CLI gave', () => {
    const at = new Date(Date.now() + 2 * 60 * 60_000)
    router.recordRateLimit(ids[0], at, "You've hit your usage limit")
    expect(seat(0).rateLimitResetsAt).toBe(at.toISOString())
    expect(seat(0).cooldownReason).toBe('limit')
    expect(creds.maskSeat(seat(0))).toMatchObject({ health: 'cooling_down', cooldownUntil: at.toISOString(), cooldownReason: 'limit' })
  })

  it('with no reset time, rests for seat_limit_cooldown_minutes', () => {
    setSetting('seat_limit_cooldown_minutes', '40')
    router.recordRateLimit(ids[0], undefined, 'usage limit')
    const mins = (Date.parse(seat(0).rateLimitResetsAt!) - Date.now()) / 60_000
    expect(mins).toBeGreaterThan(39)
    expect(mins).toBeLessThanOrEqual(40)
  })

  it('a parked account is not picked; the next one is', () => {
    router.recordRateLimit(ids[0], new Date(Date.now() + 60 * 60_000))
    expect(router.pickAccount()?.id).toBe(ids[1])
  })
})

describe('an empty turn', () => {
  it('rests the seat for the short window, marked as an empty reply, without touching the failure streak', () => {
    const r = router.recordEmptyTurn(ids[0])!
    expect(seat(0).cooldownReason).toBe('empty_turn')
    expect(seat(0).rateLimitResetsAt).toBe(r.until)
    expect(seat(0).consecutiveFailures ?? 0).toBe(0)
    const mins = (Date.parse(r.until) - Date.now()) / 60_000
    expect(mins).toBeGreaterThan(4)
    expect(mins).toBeLessThanOrEqual(5)
    expect(creds.maskSeat(seat(0)).cooldownReason).toBe('empty_turn')
    expect(router.pickAccount()?.id).toBe(ids[1])
  })

  it('never shortens or replaces a usage-limit park that is already running', () => {
    const at = new Date(Date.now() + 3 * 60 * 60_000)
    router.recordRateLimit(ids[0], at)
    expect(router.recordEmptyTurn(ids[0])).toBeNull()
    expect(seat(0).rateLimitResetsAt).toBe(at.toISOString())
    expect(seat(0).cooldownReason).toBe('limit')
  })

  it('0 minutes = no rest; an unknown seat is a no-op', () => {
    setSetting('seat_empty_turn_cooldown_minutes', '0')
    expect(router.recordEmptyTurn(ids[0])).toBeNull()
    expect(seat(0).rateLimitResetsAt).toBeNull()
    expect(router.recordEmptyTurn('nope')).toBeNull()
  })

  it('the rest can be lifted, but only while it is still the one that was set', () => {
    const r = router.recordEmptyTurn(ids[0])!
    expect(router.liftEmptyTurnRest(r)).toBe(true)
    expect(seat(0).rateLimitResetsAt).toBeNull()
    const again = router.recordEmptyTurn(ids[0])!
    const real = new Date(Date.now() + 60_000) // a real limit lands on top (sooner reset)
    router.forceClearRateLimit(ids[0])
    router.recordRateLimit(ids[0], real)
    expect(router.liftEmptyTurnRest(again)).toBe(false)
    expect(seat(0).rateLimitResetsAt).toBe(real.toISOString())
  })
})

describe('a card spawn that produced nothing', () => {
  it('rests the seat it ran on, so the respawn is picked onto another seat', () => {
    getDb().prepare("INSERT INTO session_runtime (session_id, account_id) VALUES ('cc-noop-1', ?)").run(ids[0])
    expect(router.pickAccount()?.id).toBe(ids[0])
    expect(restSeatAfterNoOpSpawn(getDb(), 'cc-noop-1')).toBe(ids[0])
    expect(seat(0).cooldownReason).toBe('empty_turn')
    expect(router.pickAccount()?.id).toBe(ids[1])
  })

  it('an unknown session, a missing seat or no session id changes nothing', () => {
    expect(restSeatAfterNoOpSpawn(getDb(), null)).toBeNull()
    expect(restSeatAfterNoOpSpawn(getDb(), 'cc-never-ran')).toBeNull()
    getDb().prepare("INSERT INTO session_runtime (session_id, account_id) VALUES ('cc-noop-2', 'gone')").run()
    expect(restSeatAfterNoOpSpawn(getDb(), 'cc-noop-2')).toBeNull()
    expect(seat(0).rateLimitResetsAt).toBeNull()
  })
})

describe('what the person is told when nobody could answer', () => {
  const now = new Date('2026-11-18T01:22:00Z') // 8:22 PM in New York
  const info = (pool: Parameters<typeof unavailableFromBackend>[1] extends infer I ? I extends { pool: infer P } ? P : never : never, freeUntried = 0) =>
    ({ pool, freeUntried, timeZone: 'America/New_York', now })
  const err = (kind: 'rate_limit' | 'empty' | 'auth' | 'no_account', tried: { label: string; kind: 'rate_limit' | 'empty' | 'auth' }[] = []) => {
    const e = new BackendError(kind, 'x', 's1')
    e.tried = tried.map((t, i) => ({ slot: `s${i + 1}`, ...t }))
    return e
  }

  it('all limited: how many accounts there are and when the first one resets', () => {
    const m = unavailableFromBackend(err('rate_limit'), info({ total: 3, available: 0, limited: 3, signedOut: 0, earliestReset: '2026-11-18T02:00:00Z' }))!
    expect(m.reason).toBe('rate_limited')
    expect(m.message).toBe('All 3 Claude accounts are at their usage limit. The first one resets at 9:00 PM EST (in about 38 minutes). Try again then, or add another account in Settings → Seats.')
  })

  it('one account only, and a reset on another day carries the weekday', () => {
    const m = unavailableFromBackend(err('no_account'), info({ total: 1, available: 0, limited: 1, signedOut: 0, earliestReset: '2026-11-18T19:00:00Z' }))!
    expect(m.message).toBe('The only Claude account is at its usage limit. It resets at Wednesday, 2:00 PM EST (in about 18 hours). Try again then, or add another account in Settings → Seats.')
  })

  it('a mix of limited and signed-out accounts is spelled out', () => {
    const m = unavailableFromBackend(err('rate_limit'), info({ total: 3, available: 0, limited: 2, signedOut: 1, earliestReset: '2026-11-18T02:00:00Z' }))!
    expect(m.message).toMatch(/^None of the 3 Claude accounts can answer right now: 2 at their usage limit, 1 needs to be signed in again\. The first one resets at 9:00 PM EST/)
  })

  it('every account empty: said plainly, with labels', () => {
    const m = unavailableFromBackend(err('empty', [{ label: 'Seat 1', kind: 'empty' }, { label: 'Seat 2', kind: 'empty' }]), info({ total: 2, available: 2, limited: 0, signedOut: 0, earliestReset: null }))!
    expect(m.reason).toBe('empty')
    expect(m.message).toMatch(/^The AI returned nothing on 2 accounts in a row \(Seat 1, Seat 2\)/)
  })

  it('never an empty reason and never "claude exited", whatever the pool looks like', () => {
    const pools = [null, { total: 0, available: 0, limited: 0, signedOut: 0, earliestReset: null }, { total: 2, available: 1, limited: 1, signedOut: 0, earliestReset: null }]
    for (const kind of ['rate_limit', 'empty', 'auth', 'no_account'] as const) {
      for (const pool of pools) {
        const m = unavailableFromBackend(err(kind, kind === 'no_account' ? [] : [{ label: 'Seat 1', kind: kind === 'auth' ? 'auth' : kind }]), info(pool))!
        expect(m.message.length).toBeGreaterThan(40)
        expect(m.message).not.toMatch(/claude exited|:\s*$|undefined|NaN/)
      }
    }
  })

  it('a crash or a timeout is not turned into "accounts are limited"', () => {
    expect(unavailableFromBackend(new BackendError('cli_error', 'claude exited 1: boom', 's1'))).toBeNull()
    expect(unavailableFromBackend(new BackendError('timeout', 't', 's1'))).toBeNull()
  })

  it('reads the real pool when no info is passed', () => {
    const at = new Date(Date.now() + 50 * 60_000)
    router.recordRateLimit(ids[0], at)
    router.recordRateLimit(ids[1], new Date(Date.now() + 90 * 60_000))
    expect(router.claudePoolSummary()).toEqual({ total: 2, available: 0, limited: 2, signedOut: 0, earliestReset: at.toISOString() })
    expect(unavailableFromBackend(err('rate_limit'))!.message).toMatch(/^All 2 Claude accounts are at their usage limit\. The first one resets at .+ \(in about (49|50) minutes\)\./)
  })

  it('formats and the chat line', () => {
    expect(formatResetTime('2026-11-18T01:23:00Z', now, 'America/New_York')).toBe('8:23 PM EST (in about 1 minute)')
    expect(seatMoveLine({ from: [{ label: 'Seat 2', reason: 'limit' }], to: 'Seat 3' })).toBe('Seat 2 reached its usage limit, so this reply moved to Seat 3. Nothing was run twice.')
    expect(seatMoveLine({ from: [{ label: 'Seat 1', reason: 'limit' }, { label: 'Seat 2', reason: 'empty' }], to: 'Seat 3' }))
      .toBe('Seat 1 reached its usage limit and Seat 2 returned nothing, so this reply moved to Seat 3. Nothing was run twice.')
  })
})

describe('Settings → Models → "When an account is limited"', () => {
  const call = async (method: string, body?: unknown) => {
    const res = await fetch(`${base}/seats/rotation`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, json: await res.json() as any }
  }

  it('GET returns values, defaults and bounds', async () => {
    const r = await call('GET')
    expect(r.status).toBe(200)
    expect(r.json.values).toEqual({ limitCooldownMinutes: 15, emptyTurnCooldownMinutes: 5, maxSeatsPerTurn: 4 })
    expect(r.json.bounds.maxSeatsPerTurn).toEqual({ min: 1, max: 20 })
    expect(r.json.env_locked).toEqual([])
  })

  it('PUT saves, takes effect at once, and is audited', async () => {
    const r = await call('PUT', { maxSeatsPerTurn: 6, emptyTurnCooldownMinutes: 0 })
    expect(r.status).toBe(200)
    expect(r.json.values).toEqual({ limitCooldownMinutes: 15, emptyTurnCooldownMinutes: 0, maxSeatsPerTurn: 6 })
    expect(settings.seatRotationSettings().maxSeatsPerTurn).toBe(6)
    const audit = getDb().prepare("SELECT detail FROM seat_audit_log WHERE action = 'rotation_settings' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(audit.detail).toBe('emptyTurnCooldownMinutes=0 maxSeatsPerTurn=6')
  })

  it('PUT refuses a bad value and saves nothing', async () => {
    const r = await call('PUT', { maxSeatsPerTurn: 500 })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('maxSeatsPerTurn must be a whole number from 1 to 20')
    expect((await call('PUT', {})).status).toBe(400)
    expect(settings.seatRotationSettings().maxSeatsPerTurn).toBe(4)
  })

  it('the seat list carries the reset time and the reason of a parked seat', async () => {
    const at = new Date(Date.now() + 30 * 60_000)
    router.recordRateLimit(ids[0], at)
    const res = await fetch(`${base}/seats`)
    const s = ((await res.json()) as any).seats.find((x: any) => x.id === ids[0])
    expect(s).toMatchObject({ health: 'cooling_down', cooldownUntil: at.toISOString(), cooldownReason: 'limit', available: false })
  })
})
