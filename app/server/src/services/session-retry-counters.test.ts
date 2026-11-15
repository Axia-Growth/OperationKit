// Restart-durable session retry counters (obj 900911, systems audit #4, criterion 4).
//
// autoResumeCounts / overloadRetryCounts / turnsContinueCounts used to be
// module-level Maps that a restart (or an in-session self-deploy) emptied.
import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { DurableRetryCounter, SESSION_RETRY_COUNTERS_TABLE } from './session-retry-counters.js'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in retry-counter tests') } }))

const FILE = path.join(os.tmpdir(), `cc-retry-counters-${process.pid}-${Date.now()}.db`)
afterAll(() => { for (const f of [FILE, `${FILE}-wal`, `${FILE}-shm`]) fs.rmSync(f, { force: true }) })

/** One "process": its own connection and its own counter objects, like a fresh boot. */
function boot() {
  const conn = new Database(FILE)
  const db = () => conn
  return {
    conn,
    limit: new DurableRetryCounter('limit_rotate', db),
    overload: new DurableRetryCounter('overload_retry', db),
    turns: new DurableRetryCounter('turns_continue', db),
  }
}

describe('retry counters survive a simulated restart', () => {
  it('counts written before a restart are read back after it, per kind', () => {
    const a = boot()
    a.limit.set('sess-1', 3)
    a.overload.set('sess-1', 2)
    a.turns.set('sess-2', 5)
    a.conn.close() // process dies

    const b = boot() // new process, new Maps — nothing carried in memory
    expect(b.limit.get('sess-1')).toBe(3)
    expect(b.overload.get('sess-1')).toBe(2)
    expect(b.turns.get('sess-2')).toBe(5)
    expect(b.turns.get('sess-1')).toBeUndefined() // kinds are independent
    expect(b.limit.has('sess-1')).toBe(true)

    // The breaker keeps counting from where it was, not from zero.
    b.limit.set('sess-1', (b.limit.get('sess-1') || 0) + 1)
    b.conn.close()
    const c = boot()
    expect(c.limit.get('sess-1')).toBe(4)
    c.conn.close()
  })

  it('a reset (delete) also survives the restart', () => {
    const a = boot()
    a.overload.set('sess-9', 4)
    expect(a.overload.delete('sess-9')).toBe(true)
    a.conn.close()
    const b = boot()
    expect(b.overload.get('sess-9')).toBeUndefined()
    b.conn.close()
  })

  it('clear() drops only its own kind', () => {
    const a = boot()
    a.limit.set('s', 1)
    a.turns.set('s', 1)
    a.limit.clear()
    expect(a.limit.get('s')).toBeUndefined()
    expect(a.turns.get('s')).toBe(1)
    expect(a.conn.prepare(`SELECT COUNT(*) AS n FROM ${SESSION_RETRY_COUNTERS_TABLE} WHERE session_id = 's'`).get()).toEqual({ n: 1 })
    a.conn.close()
  })

  it('with no DB it degrades to an in-memory counter instead of throwing', () => {
    const c = new DurableRetryCounter('limit_rotate', () => { throw new Error('db down') })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    c.set('s', 2)
    expect(c.get('s')).toBe(2)
    expect(c.delete('s')).toBe(true)
    expect(c.get('s')).toBeUndefined()
  })

  it('session-death exports the durable counters (the Map surface the auto-resume paths use)', async () => {
    const m = await import('./session-death.js')
    expect(m.autoResumeCounts).toBeInstanceOf(DurableRetryCounter)
    expect(m.overloadRetryCounts).toBeInstanceOf(DurableRetryCounter)
    expect(m.turnsContinueCounts).toBeInstanceOf(DurableRetryCounter)
    expect(m.autoResumeCounts.kind).toBe('limit_rotate')
    // A backoff timer exists only in this process, so "pending" stays in memory.
    expect(m.overloadRetryPending).toBeInstanceOf(Set)
  })
})
