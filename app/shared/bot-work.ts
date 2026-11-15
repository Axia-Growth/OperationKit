/**
 * Bot visibility (obj 900947) — what each bot is doing, and when it needs a person.
 *
 * Wire types for the per-bot Work tab, the High Agency Activity feed and the
 * Bots sidebar live line, plus the PURE rules behind them, so the server that
 * computes a view and the client that renders it can never disagree:
 *
 *  - {@link workGroupOf}: which Work-tab group a card sits in.
 *  - {@link needsYouReasons}: the ONLY four reasons a bot needs a person —
 *    an approval beyond its grant, a card over its spend ceiling, a decision,
 *    or a blocker. Nothing else counts toward "Needs you".
 *  - {@link chatRouteFor}: the chat-routing rule. Bot activity goes to the
 *    bot's Activity feed; the main chat only gets a message for one of those
 *    four reasons.
 *  - {@link botLiveState} / {@link botLiveLine}: the sidebar dot and line.
 *
 * Everything here is DERIVED from fields the board already keeps (status,
 * session, blockers, ceilings, the delegation audit). Nothing is stored twice.
 */

/** Work-tab groups, in display order. */
export const WORK_GROUPS = ['running', 'review', 'queued', 'done'] as const
export type WorkGroup = (typeof WORK_GROUPS)[number]

export const WORK_GROUP_LABELS: Record<WorkGroup, string> = {
  running: 'Running',
  review: 'In review',
  queued: 'Queued',
  done: 'Recently done',
}

/** How far back "Recently done" reaches. */
export const RECENTLY_DONE_DAYS = 7
/** At most this many cards in "Recently done". */
export const RECENTLY_DONE_LIMIT = 10

/**
 * The four need-a-person reasons, and nothing else. Order = priority when a
 * card has more than one (the sidebar and the chat message show the first).
 */
export const NEEDS_YOU_REASONS = ['approval_beyond_grant', 'over_ceiling', 'decision', 'blocker'] as const
export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number]

export const NEEDS_YOU_LABELS: Record<NeedsYouReason, string> = {
  approval_beyond_grant: 'Approval beyond its grant',
  over_ceiling: 'Over its spend ceiling',
  decision: 'Needs a decision',
  blocker: 'Blocked',
}

export function isNeedsYouReason(v: unknown): v is NeedsYouReason {
  return typeof v === 'string' && (NEEDS_YOU_REASONS as readonly string[]).includes(v)
}

/** Which Work-tab group a card belongs in, or null (cancelled / old done). */
export function workGroupOf(status: string): WorkGroup | null {
  switch (status) {
    case 'planning':
    case 'working':
      return 'running'
    case 'ai_review':
    case 'review':
      return 'review'
    case 'queue':
      return 'queued'
    case 'done':
      return 'done'
    default:
      return null
  }
}

export interface NeedsYouInput {
  status: string
  session_id?: string | null
  has_blockers?: boolean | number | null
  /** Names the card is waiting on (objectives.needs_secret, parsed). */
  needs_secret_count?: number
  stalled?: boolean
  job_disposition?: string | null
  spent_usd: number
  ceiling_usd: number | null
  /** A delegated approval for this card was refused and nobody approved it since. */
  approval_denied?: boolean
}

const TERMINAL = new Set(['done', 'cancelled'])

/**
 * Why this card needs a person right now, in priority order. Empty = it does
 * not. A done/cancelled card never needs anyone.
 *
 *  - approval_beyond_grant: the bot asked to approve a merge / prod migration /
 *    deploy its delegation grant does not cover (delegation_audit
 *    `approval_denied`), and no approval has been used on the card since.
 *  - over_ceiling: measured spend is at or over the card's effective ceiling
 *    (explicit, else the per-effort default `spend_ceiling_default_usd:<tier>`).
 *  - decision: the card sits in Needs You (review with no agent on it — the
 *    board's own rule), or a job finished with disposition `needs_review`.
 *  - blocker: the card has a blocker, is waiting on a secret, or stalled.
 */
export function needsYouReasons(c: NeedsYouInput): NeedsYouReason[] {
  if (TERMINAL.has(c.status)) return []
  const out: NeedsYouReason[] = []
  if (c.approval_denied) out.push('approval_beyond_grant')
  if (c.ceiling_usd != null && Number.isFinite(c.ceiling_usd) && c.spent_usd >= c.ceiling_usd) out.push('over_ceiling')
  const parked = c.status === 'review' && (c.session_id == null || c.session_id === '')
  if (parked || c.job_disposition === 'needs_review') out.push('decision')
  if (c.has_blockers === true || Number(c.has_blockers) > 0 || (c.needs_secret_count ?? 0) > 0 || c.stalled) out.push('blocker')
  return out
}

/** Where a piece of bot activity goes. */
export type ChatRoute = 'main_chat' | 'activity_feed'

/**
 * The routing rule (spec item 5). Only the four need-a-person reasons reach
 * the main chat; every other update — a wake started, a card finished, a PR
 * opened, a summary — goes to the bot's Activity feed.
 */
export function chatRouteFor(reason: string | null | undefined): ChatRoute {
  return isNeedsYouReason(reason) ? 'main_chat' : 'activity_feed'
}

/** The sidebar status dot. */
export type BotLiveState = 'waiting' | 'running' | 'idle'

export const BOT_LIVE_STATE_LABELS: Record<BotLiveState, string> = {
  waiting: 'Waiting on you',
  running: 'Running',
  idle: 'Idle',
}

export interface BotWorkCard {
  id: number
  title: string
  status: string
  workspace: string
  group: WorkGroup
  pr_url: string | null
  spent_usd: number
  ceiling_usd: number | null
  /** `objective` | `workspace:<ws>` | `global` | `default:<tier>` (PR 794). */
  ceiling_source: string | null
  ceiling_is_default: boolean
  needs_you: NeedsYouReason[]
  /** True for a High Agency wake card (it also has an Activity entry). */
  is_wake: boolean
  updated_at: string
}

export interface BotWorkCounts {
  running: number
  review: number
  queued: number
  done: number
  needs_you: number
}

export interface BotWorkView {
  slug: string
  /** The board owner-filter token for this bot (`bot:<registry id>`), for "Open on board". */
  owner_token: string
  /** Workspaces the view covers: the viewer's ∩ the bot's grant. */
  workspaces: string[]
  groups: Record<WorkGroup, BotWorkCard[]>
  counts: BotWorkCounts
  state: BotLiveState
  line: string
}

/** One bot's sidebar entry. */
export interface BotStatusEntry {
  slug: string
  state: BotLiveState
  line: string
  /** The card the line names ("Working on #…"), if any. */
  focus_id: number | null
  counts: BotWorkCounts
}

export interface BotStatusResponse {
  bots: Record<string, BotStatusEntry>
  /** "Needs you" across every bot, each card counted once. */
  needs_you_total: number
}

/** Running beats idle; anything needing a person beats both. */
export function botLiveState(counts: Pick<BotWorkCounts, 'running' | 'needs_you'>): BotLiveState {
  if (counts.needs_you > 0) return 'waiting'
  if (counts.running > 0) return 'running'
  return 'idle'
}

/**
 * The sidebar line under a bot's name, e.g. "Working on #900936 · 2 in review".
 * `focus` is the newest running card (or the card waiting on you).
 */
export function botLiveLine(counts: BotWorkCounts, focus: { id: number } | null): string {
  const parts: string[] = []
  const state = botLiveState(counts)
  if (state === 'waiting') {
    parts.push(counts.needs_you === 1 ? (focus ? `Needs you on #${focus.id}` : 'Needs you') : `${counts.needs_you} need you`)
    if (counts.running > 0) parts.push(`${counts.running} running`)
  } else if (state === 'running') {
    parts.push(focus ? `Working on #${focus.id}` : 'Working')
    if (counts.running > 1) parts.push(`+${counts.running - 1} more`)
  } else {
    parts.push('Idle')
  }
  if (counts.review > 0) parts.push(`${counts.review} in review`)
  if (state === 'idle' && counts.queued > 0) parts.push(`${counts.queued} queued`)
  return parts.join(' · ')
}

// ── Activity feed ────────────────────────────────────────────────────────────

export interface BotActivityCardRef {
  id: number
  title: string
  status: string
  pr_url: string | null
  spent_usd: number
}

/** One High Agency wake, as the feed shows it collapsed. */
export interface BotActivityEntry {
  wake_id: number
  at: string
  status: string
  /** The card the wake picked (filed, or the first card it linked to), if any. */
  picked: BotActivityCardRef | null
  /** One line: job_review_note, else the first line of the last session summary. */
  did: string
  pr_url: string | null
  /** The wake's own spend plus the card it picked. */
  cost_usd: number
  disposition: string | null
  needs_you: NeedsYouReason[]
}

/** The same wake, expanded into the full run. */
export interface BotActivityRun extends BotActivityEntry {
  title: string
  workspace: string
  summary: string | null
  review_note: string | null
  wake_spent_usd: number
  ceiling_usd: number | null
  children: BotActivityCardRef[]
  updated_at: string
}

export interface BotDailySummary {
  since: string
  wakes: number
  shipped: BotActivityCardRef[]
  spent_usd: number
  next: {
    next_wake_at: string | null
    queued: { id: number; title: string }[]
    needs_you: number
  }
}

export interface BotActivityResponse {
  slug: string
  high_agency: boolean
  workspaces: string[]
  summary: BotDailySummary
  entries: BotActivityEntry[]
}

/** meta.kind of a main-chat message a bot posts when it needs a person. */
export const BOT_NEEDS_YOU_KIND = 'bot_needs_you'

export interface BotNeedsYouMeta {
  kind: typeof BOT_NEEDS_YOU_KIND
  objective_id: number
  reason: NeedsYouReason
  title: string
  /** Over-ceiling only: what the card spent and its ceiling when posted. */
  spent_usd?: number
  ceiling_usd?: number
  /** Approval-beyond-grant only: the action the bot asked to approve. */
  action?: string | null
}
