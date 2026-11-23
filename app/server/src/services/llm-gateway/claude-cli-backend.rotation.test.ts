import { describe, it, expect, vi, beforeEach } from 'vitest'

// obj 901395 — the pool backend's rotation rules, with the router mocked (the
// real one persists to disk). The end-to-end proof, with a real spawned CLI
// stand-in and the real router, is chat-seat-rotation.integration.test.ts.
const lift = vi.fn()
vi.mock('../account-router.js', () => ({
  pickAccount: vi.fn(),
  recordRateLimit: vi.fn(),
  recordAuthFailure: vi.fn(),
  recordEmptyTurn: vi.fn(() => null),
  liftEmptyTurnRest: (r: unknown) => lift(r),
  getAccountLabel: (id: string) => id,
  isRateLimitMessage: (t: string) => /rate limit|usage limit/i.test(t),
  isAuthFailureMessage: (t: string) => /invalid authentication credentials/i.test(t),
  parseResetTime: () => null,
}))
vi.mock('../seat-credentials.js', () => ({ seatCredentialEnv: () => ({}) }))

import { applyStreamLine, BackendError, createClaudeCliBackend, isRotatableKind, safeSeatLabel } from './claude-cli-backend.js'
import type { AccountSlot, EmptyTurnRest } from '../account-router.js'

const slot = (id: string, label = id): AccountSlot => ({
  id, label, priority: 0, homeDir: `/home/${id}`, sessionsToday: 0, tokensToday: 0, costToday: 0,
  lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [],
})
const ok = (id: string) => ({ text: `from ${id}`, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, stopReason: 'end_turn', slot: id, costUsd: 0, ttftMs: 1 })
const rest = (id: string): EmptyTurnRest => ({ accountId: id, until: '2026-11-18T00:05:00.000Z', prevResetsAt: null, prevLastRateLimit: null })
const emptyErr = (id: string) => {
  const e = new BackendError('empty', `claude returned no answer and no error text on seat ${id} (exit code 0)`, id)
  e.emptyRest = rest(id)
  return e
}
function poolOf(seats: AccountSlot[]) {
  return (filter: (a: AccountSlot) => boolean) => seats.find(filter) ?? null
}
const req = { model: 'm', systemPrompt: 's', prompt: 'p' }

beforeEach(() => lift.mockClear())

describe('which failures move a request to the next account', () => {
  it('rate limit, sign-in failure and an EMPTY turn rotate; a crash, a timeout and a stop do not', () => {
    expect(['rate_limit', 'auth', 'empty'].every(k => isRotatableKind(k as never))).toBe(true)
    expect(['cli_error', 'timeout', 'aborted', 'no_account'].some(k => isRotatableKind(k as never))).toBe(false)
  })

  it('an empty turn on the first seat is answered by the second, and the result says which seat was left and why', async () => {
    const run = vi.fn(async (a: AccountSlot) => { if (a.id === 's1') throw emptyErr('s1'); return ok(a.id) })
    const backend = createClaudeCliBackend({ pick: poolOf([slot('s1', 'Seat 1'), slot('s2', 'Seat 2')]), run: run as never, slotFilter: () => true })
    const r = await backend(req)
    expect(r.text).toBe('from s2')
    expect(r.attempts).toBe(2)
    expect(r.slotLabel).toBe('Seat 2')
    expect(r.moved).toEqual([{ slot: 's1', label: 'Seat 1', kind: 'empty' }])
    // One seat was empty and another answered: the rest on the empty seat stands.
    expect(lift).not.toHaveBeenCalled()
  })

  it('the first seat answering reports no move', async () => {
    const backend = createClaudeCliBackend({ pick: poolOf([slot('s1')]), run: (async (a: AccountSlot) => ok(a.id)) as never, slotFilter: () => true })
    expect((await backend(req)).moved).toEqual([])
  })

  it('EVERY seat empty: the error lists what was tried and the seats are given back (not the seats\' fault)', async () => {
    const run = vi.fn(async (a: AccountSlot) => { throw emptyErr(a.id) })
    const backend = createClaudeCliBackend({ pick: poolOf([slot('s1', 'Seat 1'), slot('s2', 'Seat 2')]), run: run as never, slotFilter: () => true })
    const err = await backend(req).catch(e => e)
    expect(err).toBeInstanceOf(BackendError)
    expect(err.kind).toBe('empty')
    expect(err.tried.map((t: { label: string }) => t.label)).toEqual(['Seat 1', 'Seat 2'])
    expect(lift.mock.calls.map(c => c[0].accountId)).toEqual(['s1', 's2'])
  })

  it('a single empty seat keeps its rest (one sample is not proof the request is at fault)', async () => {
    const backend = createClaudeCliBackend({ pick: poolOf([slot('s1')]), run: (async () => { throw emptyErr('s1') }) as never, slotFilter: () => true })
    await backend(req).catch(() => undefined)
    expect(lift).not.toHaveBeenCalled()
  })

  it('a limit on one seat and an empty turn on another: neither rest is lifted', async () => {
    const run = vi.fn(async (a: AccountSlot) => { throw a.id === 's1' ? new BackendError('rate_limit', 'account rate-limited', 's1') : emptyErr(a.id) })
    const backend = createClaudeCliBackend({ pick: poolOf([slot('s1'), slot('s2')]), run: run as never, slotFilter: () => true })
    const err = await backend(req).catch(e => e)
    expect(err.tried.map((t: { kind: string }) => t.kind)).toEqual(['rate_limit', 'empty'])
    expect(lift).not.toHaveBeenCalled()
  })

  it('maxAttempts may be a function, read on every request (the operator setting)', async () => {
    let cap = 1
    const run = vi.fn(async (a: AccountSlot) => { if (a.id === 's1') throw emptyErr('s1'); return ok(a.id) })
    const backend = createClaudeCliBackend({ pick: poolOf([slot('s1'), slot('s2')]), run: run as never, slotFilter: () => true, maxAttempts: () => cap })
    expect((await backend(req).catch(e => e)).kind).toBe('empty')
    cap = 2
    expect((await backend(req)).text).toBe('from s2')
  })

  it('text already streamed to a client is never retried on another seat', async () => {
    const run = vi.fn(async () => { throw new BackendError('empty', 'x', 's1', true) })
    const backend = createClaudeCliBackend({ pick: poolOf([slot('s1'), slot('s2')]), run: run as never, slotFilter: () => true })
    await backend(req).catch(() => undefined)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('what a person is shown for a seat', () => {
  it('the operator label, unless it looks like an email, a path or a token', () => {
    expect(safeSeatLabel('s1', 'Seat 1')).toBe('Seat 1')
    expect(safeSeatLabel('s1', 'operator@example.com')).toBe('s1')
    expect(safeSeatLabel('s1', '/home/ccuser-b')).toBe('s1')
    expect(safeSeatLabel('s1', 'sk-ant-oat01-abc')).toBe('s1')
    expect(safeSeatLabel('s1', '')).toBe('s1')
    expect(safeSeatLabel('s1', null)).toBe('s1')
  })
})

describe('an errored result with an empty result string', () => {
  it('is still an error (it used to read as "no error" and pass as an empty success)', () => {
    const st = { text: '', sawDelta: false, fallbackText: '', usage: null, stopReason: null, costUsd: 0, resultError: null, rateLimited: null, authFailed: null, notLoggedIn: null, ttftMs: null }
    applyStreamLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', usage: {} }), st as never, Date.now())
    expect(st.resultError).toBe('error_during_execution')
  })
})
