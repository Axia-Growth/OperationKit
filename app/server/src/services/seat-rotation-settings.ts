// ── Seat rotation settings (obj 901395) ──
//
// Three numbers an operator can change without a restart (settings table, read
// at point of use; an env var of the same meaning wins):
//
//   seat_limit_cooldown_minutes        15   how long a LIMITED seat rests when the
//                                           CLI gave no reset time (first step; it
//                                           doubles per repeat, capped at 5 hours)
//   seat_empty_turn_cooldown_minutes    5   how long a seat rests after a turn that
//                                           came back EMPTY (exit with no answer and
//                                           no error text). 0 = rotate but do not rest
//   seat_rotation_max_seats_per_turn    4   how many seats one chat reply / gateway
//                                           request may try before it gives up
//
// The account router holds no DB handle, so this module hands it the two
// cool-down numbers through registerSeatCooldownConfig (same pattern as
// registerSeatCredentialCheck in seat-credentials.ts).
import { readSetting } from '../lib/install-defaults.js'
import * as accountRouter from './account-router.js'

export const SEAT_ROTATION_SETTING = {
  limitCooldownMinutes: 'seat_limit_cooldown_minutes',
  emptyTurnCooldownMinutes: 'seat_empty_turn_cooldown_minutes',
  maxSeatsPerTurn: 'seat_rotation_max_seats_per_turn',
} as const

export const SEAT_ROTATION_DEFAULT = {
  limitCooldownMinutes: 15,
  emptyTurnCooldownMinutes: 5,
  maxSeatsPerTurn: 4,
} as const

export const SEAT_ROTATION_ENV = {
  limitCooldownMinutes: 'CC_SEAT_LIMIT_COOLDOWN_MINUTES',
  emptyTurnCooldownMinutes: 'CC_SEAT_EMPTY_TURN_COOLDOWN_MINUTES',
  maxSeatsPerTurn: 'CC_SEAT_ROTATION_MAX_SEATS_PER_TURN',
} as const

/** Bounds: a typo must not bench a seat for a week or try 500 seats. */
const BOUNDS = {
  limitCooldownMinutes: [1, 300],
  emptyTurnCooldownMinutes: [0, 120],
  maxSeatsPerTurn: [1, 20],
} as const

type Key = keyof typeof SEAT_ROTATION_DEFAULT

export type SeatRotationSettings = Record<Key, number>

/** Parse one value; anything unreadable or out of range → null (the default applies). */
export function parseSeatRotationValue(key: Key, raw: unknown): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  const [lo, hi] = BOUNDS[key]
  return n >= lo && n <= hi ? n : null
}

export function seatRotationBounds(): Record<Key, readonly [number, number]> {
  return BOUNDS
}

function one(key: Key, env: NodeJS.ProcessEnv, read: (k: string) => string | undefined): number {
  return (
    parseSeatRotationValue(key, env[SEAT_ROTATION_ENV[key]]) ??
    parseSeatRotationValue(key, read(SEAT_ROTATION_SETTING[key])) ??
    SEAT_ROTATION_DEFAULT[key]
  )
}

export function seatRotationSettings(
  env: NodeJS.ProcessEnv = process.env,
  read: (k: string) => string | undefined = k => readSetting(k),
): SeatRotationSettings {
  return {
    limitCooldownMinutes: one('limitCooldownMinutes', env, read),
    emptyTurnCooldownMinutes: one('emptyTurnCooldownMinutes', env, read),
    maxSeatsPerTurn: one('maxSeatsPerTurn', env, read),
  }
}

/** The install timezone (same order as high-agency's installTimeZone), for times shown to people. */
export function seatDisplayTimeZone(env: NodeJS.ProcessEnv = process.env, read: (k: string) => string | undefined = k => readSetting(k)): string {
  for (const tz of [(env.CC_INSTALL_TIMEZONE || '').trim(), (read('install_timezone') || '').trim()]) {
    if (!tz) continue
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch { /* unknown zone → next */ }
  }
  return 'America/New_York'
}

// Guarded: a test that mocks the router without this export must still load.
try {
  accountRouter.registerSeatCooldownConfig(() => {
    const s = seatRotationSettings()
    return { limitBaseMs: s.limitCooldownMinutes * 60_000, emptyTurnMs: s.emptyTurnCooldownMinutes * 60_000 }
  })
} catch { /* router mocked without the hook: the built-in defaults apply */ }
