/**
 * Spend guard contracts (obj 900909, systems audit #10).
 *
 * The server owns every decision; this file only carries the shape the card UI
 * reads from `GET /api/objectives/:id/spend`.
 */

/** Effort tiers a card can run at, cheapest first. */
export const SPEND_EFFORT_TIERS = ['normal', 'high', 'ultracode'] as const
export type SpendEffortTier = (typeof SPEND_EFFORT_TIERS)[number]

/**
 * Where a card is in the degradation chain. Stages only move forward, one per
 * guard evaluation: none → warned → degraded → parked.
 */
export type SpendGuardStage = 'none' | 'warned' | 'degraded' | 'parked'

export interface SpendGuardView {
  objective_id: number
  /** The cost ceiling in force for this card, in USD. */
  ceiling_usd: number
  /**
   * Where the ceiling came from: `objective` (set on the card), `workspace:<ws>`,
   * `global`, or `default:<effort>` (the per-effort default, used when nothing
   * explicit is set).
   */
  ceiling_source: string
  /** True when the ceiling is the per-effort default rather than an explicit one. */
  ceiling_is_default: boolean
  /** Measured spend so far across every session of the card, in USD. */
  spent_usd: number
  /** Spend projected at the end of the projection horizon, or null while warming up. */
  projected_usd: number | null
  /** Current burn rate in USD per minute, or null while warming up. */
  burn_usd_per_min: number | null
  /** How far ahead the projection looks, in minutes. */
  horizon_minutes: number
  stage: SpendGuardStage
  stage_at: string | null
  /** Plain-language note on the last guard action, or null. */
  last_action: string | null
  last_action_at: string | null
  /** Why the last spawn or respawn was refused, or null. */
  last_refusal: string | null
  last_refusal_at: string | null
  /** May the guard move this card to a cheaper effort or model? */
  degrade_allowed: boolean
  /** The projection guard kill switch (`settings.spend_projection_guard_enabled`). */
  projection_guard_enabled: boolean
  /** The spawn/respawn guard kill switch (`settings.spend_spawn_guard_enabled`). */
  spawn_guard_enabled: boolean
  /** True when spend has reached the ceiling — new spawns are refused. */
  over_ceiling: boolean
}
