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
 *    or a blocker. Nothing else counts toward "Needs you". Being in the review
 *    stage is not a reason by itself ({@link reviewStageOf}, obj 901387).
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

/**
 * obj 901387: where a card in the review stage really stands. "In review" is a
 * STAGE; only some of these stages wait on a person.
 *
 *  - not_review:          the card is not in the review stage at all.
 *  - agent_running:       a session is live on the card (a worker acting on a
 *                         bounce, a follow-up). The bot's, not the person's.
 *  - awaiting_ai_review:  the AI reviewer has the card (`ai_review`), or the
 *                         card has (or was meant to open) a pull request and
 *                         no AI review verdict yet. Not the person's turn.
 *  - sign_off:            AI review passed. Waiting for the person to accept
 *                         or bounce it, or approve the merge / deploy.
 *  - review_escalated:    AI review ended `fail` / `blocked` and the card is
 *                         parked with nobody on it (a fail that went back to
 *                         the worker is `working`, or has a live session).
 *  - no_ai_review:        AI review does not apply (no pull request, or the
 *                         card opted out with skip_ai_review), so the person
 *                         is the only gate.
 */
export type ReviewStage = 'not_review' | 'agent_running' | 'awaiting_ai_review' | 'sign_off' | 'review_escalated' | 'no_ai_review'

export const REVIEW_STAGE_LABELS: Record<Exclude<ReviewStage, 'not_review'>, string> = {
  agent_running: 'Agent still working',
  awaiting_ai_review: 'Waiting on AI review',
  sign_off: 'Ready for your sign-off',
  review_escalated: 'AI review needs your call',
  no_ai_review: 'Ready for you to accept',
}

export interface ReviewStageInput {
  status: string
  session_id?: string | null
  ai_review_verdict?: string | null
  /** The card carries a pull request (pr_url or pr_number). */
  has_pr?: boolean | number | null
  /** The card was filed to open a pull request (objectives.create_pr). */
  create_pr?: boolean | number | null
  skip_ai_review?: boolean | number | null
}

const truthy = (v: boolean | number | null | undefined): boolean => v === true || Number(v) > 0

export function reviewStageOf(c: ReviewStageInput): ReviewStage {
  if (c.status === 'ai_review') return 'awaiting_ai_review'
  if (c.status !== 'review') return 'not_review'
  if (c.session_id != null && c.session_id !== '') return 'agent_running'
  if (c.ai_review_verdict === 'pass') return 'sign_off'
  if (c.ai_review_verdict === 'fail' || c.ai_review_verdict === 'blocked') return 'review_escalated'
  if (truthy(c.skip_ai_review)) return 'no_ai_review'
  if (truthy(c.has_pr) || truthy(c.create_pr)) return 'awaiting_ai_review'
  return 'no_ai_review'
}

/** The review stages that wait on a person. The ONE rule every "needs you" count uses. */
export function reviewStageNeedsPerson(stage: ReviewStage): boolean {
  return stage === 'sign_off' || stage === 'review_escalated' || stage === 'no_ai_review'
}

/** A review card the person has to act on: accept / bounce it, or approve its merge. */
export function reviewWaitsOnPerson(c: ReviewStageInput): boolean {
  return reviewStageNeedsPerson(reviewStageOf(c))
}

export interface NeedsYouInput extends ReviewStageInput {
  has_blockers?: boolean | number | null
  /** Names the card is waiting on (objectives.needs_secret, parsed). */
  needs_secret_count?: number
  stalled?: boolean
  job_disposition?: string | null
  /** obj 901059: the card has an open decision briefing waiting on the person. */
  open_decision?: boolean
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
 *  - decision: an open (unanswered) decision briefing, a job that finished with
 *    disposition `needs_review`, or a review card that waits on the person
 *    ({@link reviewWaitsOnPerson}: AI review passed, AI review escalated, or no
 *    AI review applies). obj 901387: a card that is merely IN review — still
 *    waiting on its AI review, or with an agent on it — is NOT counted; it only
 *    shows in the plain "N in review" stage count.
 *  - blocker: the card has a blocker, is waiting on a secret, or stalled.
 */
export function needsYouReasons(c: NeedsYouInput): NeedsYouReason[] {
  // obj 901059: an open decision still needs the person on a finished card (a
  // job that ended asking) — that is the case Operator could not see. Nothing else does.
  if (TERMINAL.has(c.status)) return c.open_decision ? ['decision'] : []
  const out: NeedsYouReason[] = []
  if (c.approval_denied) out.push('approval_beyond_grant')
  if (c.ceiling_usd != null && Number.isFinite(c.ceiling_usd) && c.spent_usd >= c.ceiling_usd) out.push('over_ceiling')
  if (reviewWaitsOnPerson(c) || c.job_disposition === 'needs_review' || c.open_decision) out.push('decision')
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
  /** obj 901387: where a review card stands (why it does or does not need you). */
  review_stage?: ReviewStage
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

/**
 * Running beats idle; anything needing a person beats both. `chatActive` is a
 * turn streaming or running tools in the bot's chat right now (obj 901025) —
 * it counts the same as a running card even when no card session is open, so
 * the sidebar/header never read Idle while the bot is mid-reply.
 */
export function botLiveState(counts: Pick<BotWorkCounts, 'running' | 'needs_you'>, chatActive = false): BotLiveState {
  if (counts.needs_you > 0) return 'waiting'
  if (counts.running > 0 || chatActive) return 'running'
  return 'idle'
}

/**
 * The sidebar line under a bot's name, e.g. "Working on #900936 · 2 in review".
 * `focus` is the newest running card (or the card waiting on you). `chatActive`
 * — see {@link botLiveState}.
 */
export function botLiveLine(counts: BotWorkCounts, focus: { id: number } | null, chatActive = false): string {
  const parts: string[] = []
  const state = botLiveState(counts, chatActive)
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
  // The queued count stays visible whether the bot reads Idle or Working — a
  // chat turn running (chatActive) must not hide how many cards are waiting.
  if (state !== 'waiting' && counts.queued > 0) parts.push(`${counts.queued} queued`)
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

/**
 * obj 901030: everything the bot did, not only its High Agency wakes — a card
 * it filed or started from chat, a PR it opened, a card it closed, a review
 * verdict. Newest first; a wake fire is one `kind: 'wake'` item among the rest
 * (its `wake_id` opens the same expanded run `entries`/`GET .../activity/:id`
 * already serve).
 */
export type BotActivityItemKind = 'wake' | 'filed' | 'started' | 'review' | 'done' | 'cancelled' | 'pr'

export interface BotActivityItem {
  /** Stable React key: unique per (kind, card, timestamp). */
  key: string
  kind: BotActivityItemKind
  at: string
  card: BotActivityCardRef
  /** Set only for kind = 'wake' — opens its expanded run. */
  wake_id: number | null
  /** One line: "Filed", "Started", "Entered review", "PR opened", … (wake rows
   *  carry their own report line instead, see BotActivityEntry.did). */
  detail: string
  pr_url: string | null
}

export interface BotActivityResponse {
  slug: string
  high_agency: boolean
  workspaces: string[]
  summary: BotDailySummary
  entries: BotActivityEntry[]
  /** obj 901030: the unified feed — every action, wake rows included. */
  items: BotActivityItem[]
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
  /** Decision only (obj 901059): the open decision and its one question, so the post says WHAT is being decided. */
  decision_id?: number
  question?: string
}
