/**
 * Needs You bulk triage + bot approvals (obj 900869) — the shared vocabulary.
 *
 * Bulk triage is a HUMAN tool: the owner, signed in to the web app, selects
 * cards in Needs You and approves, dismisses or reassigns them in one batch.
 * Every batch is written to an audit table with one row per card.
 *
 * A bot approval is a single card at a time, on a named agent key, and only
 * when the card is ELIGIBLE: either the bot holds an active delegation grant
 * (obj 900839 — the one grant system; nothing here issues grants) for the
 * signature the card needs, or the card falls under a rule that needs no new
 * human signature.
 */

export const TRIAGE_ACTIONS = ['approve', 'dismiss', 'reassign'] as const
export type TriageAction = (typeof TRIAGE_ACTIONS)[number]

export function isTriageAction(raw: unknown): raw is TriageAction {
  return typeof raw === 'string' && (TRIAGE_ACTIONS as readonly string[]).includes(raw)
}

/** Most cards one request may touch. The UI splits a bigger selection into chunks. */
export const TRIAGE_MAX_BATCH = 100

/** POST /api/board-triage/batches */
export interface TriageBatchRequest {
  action: TriageAction
  objective_ids: number[]
  /** reassign only: replace the human assignees with these user ids ([] = clear). */
  assigned_user_ids?: number[]
  /** reassign only: set the bot owner (a registry name/alias), or null to clear. */
  owner_bot?: string | null
  /** Optional free-text reason, kept on the batch audit row. */
  note?: string
  /**
   * Dry run: run every check and answer with exactly what WOULD happen to each
   * card. Nothing is written — no batch row, no card change, no audit row.
   * The answer is a TriageBatchPreview, not a TriageBatchResponse.
   */
  dry_run?: boolean
}

export type TriageItemResult = 'ok' | 'skipped' | 'failed'

export interface TriageItemOutcome {
  objective_id: number
  title: string | null
  result: TriageItemResult
  from_status: string | null
  to_status: string | null
  /** Why it was skipped / failed, in plain words. */
  error?: string
}

export interface TriageBatchResponse {
  batch_id: number
  action: TriageAction
  requested: number
  ok: number
  skipped: number
  failed: number
  items: TriageItemOutcome[]
}

/** One card in a dry run: what the real action would do to it right now. */
export interface TriagePreviewItem {
  objective_id: number
  title: string | null
  result: 'would_change' | 'skipped' | 'failed'
  from_status: string | null
  /** Where the card would end up (same as from_status for a reassign). */
  to_status: string | null
  /** would_change: the change in plain words. */
  change?: string
  /** skipped / failed: why, in plain words (the same text the real run records). */
  error?: string
}

/** POST /api/board-triage/batches with `dry_run: true`. Nothing was changed. */
export interface TriageBatchPreview {
  dry_run: true
  action: TriageAction
  requested: number
  would_change: number
  skipped: number
  failed: number
  items: TriagePreviewItem[]
  /** What the preview cannot promise (the gates that only run on the real move). */
  note: string
}

export interface TriageBatchSummary {
  id: number
  action: TriageAction
  actor: string
  requested: number
  ok: number
  skipped: number
  failed: number
  note: string | null
  params: Record<string, unknown>
  created_at: string
}

/** Who a card can be handed to (GET /api/board-triage/owners). */
export interface TriageOwnerOptions {
  humans: { id: number; username: string }[]
  bots: { id: string; name: string }[]
}

// ── bot approvals ────────────────────────────────────────────────────────────

/**
 * What signature a Needs You card is waiting on.
 *  - `merge`: the card has an open pull request — approving it means shipping
 *    code, which the grant system names `merge`.
 *  - `close`: nothing gated is pending; approving closes the card.
 */
export type ApprovalNeed = 'merge' | 'close'

export type BotApprovalBasis =
  /** The bot holds an active delegation grant for exactly this need. */
  | 'grant'
  /** The card is the bot's own work, passed AI review, and nothing gated is
   *  pending — closing it needs no new human signature. */
  | 'rule:own_work_reviewed'

export type BotApprovalRefusal =
  | 'not_in_needs_you'
  | 'unknown_bot'
  | 'needs_secret'
  | 'strategy'
  | 'money_path'
  | 'no_active_grant'
  | 'not_bot_owned'
  | 'no_passing_review'
  | 'key_workspace_forbidden'
  | 'requires_bot_key'

export interface BotApprovalEligibility {
  eligible: boolean
  need: ApprovalNeed
  bot: string | null
  basis?: BotApprovalBasis
  grant_id?: number
  refusal?: BotApprovalRefusal
  /** One plain sentence: why it may or may not approve. */
  reason: string
}
