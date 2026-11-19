// ── What Full access lets a bot DO (obj 900972) ──
//
// bot-full-access.ts stores the switch. This file is what the switch means in
// a chat turn or a bot-to-bot wake: a family of tools the model is offered only
// while Full access counts, each one checked again on every call.
//
// When it applies. All three have to hold, re-read from the DB on each call:
//   1. the bot has Full access in that workspace (on, not expired, workspace
//      still granted — `fullAccessActive`);
//   2. the person the bot is acting for is an install admin. A bot acts for
//      the person chatting with it; Full access must not let a member reach,
//      through the bot, cards and settings they cannot reach themselves;
//   3. in a bot-to-bot wake, the workspace is the one conversation's workspace.
// Anything else is refused, and the refusal is written to the audit log.
//
// What it adds, always inside that ONE workspace:
//   - cards: read any card in full, take it over, hand it to another owner,
//     comment on it, restart it — whatever its current owner;
//   - knowledge base: the whole workspace folder, not just knowledge_folders
//     (`fullAccessKnowledgeFolders`, used by the ordinary knowledge tools);
//   - workflows: list, read, save a DRAFT version. Publishing stays the owner's
//     browser click (routes/flows.ts), so a draft never runs by itself;
//   - scheduled tasks: list, read, change the schedule / pause / resume / the
//     brief of an AI task. Never a script command (that is a command on the
//     host, not a workspace setting) and never a High Agency wake (a bot must
//     not schedule itself);
//   - bots: read the settings and run history of the bots that work here;
//   - a repo checkout: file a card on a project of this workspace, owned by the
//     bot, and start it — the card session gets its own git worktree;
//   - ask for an AI review of a card the bot OWNS (cardOwnerBot) that sits in
//     review with a pull request and no verdict, through the same service the
//     operator's /api/internal/ai-review/request route uses, inside the review
//     bounce cap (obj 901457);
//   - file and own cards: create_objective, with the bot's slug passing the
//     workspace agent pool through the obj 900948 helper (`botGrantedWorkspace`
//     inside `checkAgentInWorkspacePool`). There is no second bypass here.
//
// What it never adds: secret use, key minting or revoking, DNS / Cloudflare
// Access, billing (full-access-exclusions.ts), and any merge, prod-migration or
// deploy approval. A comment posted by `card_comment` reaches the card as an
// unverified relay, exactly like any other machine message, so it can never be
// read as the owner's approval; approvals stay with delegation_grants.
import fs from 'fs'
import path from 'path'
import { FULL_ACCESS_PERMANENT_EXCLUSIONS, getInitialStatus, validateOwnerBot, type Objective } from '@operationkit/shared'
import { getDb } from '../../db/index.js'
import { depthForParent } from '../../lib/objective-depth.js'
import { internalApiHeaders } from '../../lib/internal-api-headers.js'
import { containedIn, realpathOrNull, workspaceScopeRoots } from '../../lib/kb-workspace-scope.js'
import { checkAgentInWorkspacePool, setAssignees } from '../../routes/objectives-helpers.js'
import { logActivity } from '../../routes/feed.js'
import { broadcast } from '../../ws/index.js'
import { workspaceKbRoot } from '../doc-ingest/kb-paths.js'
import { userHasWorkspace } from '../../middleware/workspace.js'
import type { ChatAgent } from './agent-defs.js'
import { fullAccessActive, getFullAccess, listFullAccess, protectedCardRefusal, protectedPrTextRefusal, writeFullAccessAudit } from './bot-full-access.js'
import { botGrantedWorkspace, botMayUseWorkspace, highAgencyRoutineSlug, personaOwnershipBlocked } from './bot-workspaces.js'
import { chatCardModel, chatOwnerBotName, ToolUseError, type ToolContext, type ToolOutcome, type ToolSpec } from './tools.js'
import { agentExists } from '../agent-registry.js'
import { botForAgentSlug } from '../bots/bot-registry.js'
import { publicCardUrl } from '../../lib/public-url.js'
import { cardOwnerBot, ownerHasSlug } from '../bots/card-owner.js'
import { requestAiReview, type RequestReviewResult } from '../ai-review-backfill.js'
import { AI_REVIEW_ITERATION_CAP } from '../poller-decisions.js'

/** Starts and messages a card. The host uses the same loopback routes the scheduler does; tests pass a stub. */
export interface FullAccessHost {
  startCard(objectiveId: number, actor: string): Promise<{ ok: boolean; status?: string; reason?: string }>
  messageCard(objectiveId: number, message: string): Promise<{ ok: boolean; status?: string; reason?: string }>
  /**
   * Spawn an AI reviewer for a card in review (obj 901457). The host runs the
   * same `requestAiReview` the operator route does, behind the session cap;
   * tests pass a stub reviewer spawn. Optional only so older stubs still type.
   */
  requestReview?(objectiveId: number, opts: { requestedBy: string; maxIteration: number }): Promise<RequestReviewResult>
}

function port(): number {
  return parseInt(process.env.PORT || '3002', 10)
}

/**
 * The real host: the internal status PATCH and message routes, over loopback.
 * Going through them (rather than calling the session manager here) keeps every
 * guard those routes own — valid transitions, the session cap, locked and
 * human-closed cards, the disk check, the duplicate guard.
 */
export const hostFullAccessHost: FullAccessHost = {
  async startCard(objectiveId, actor) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port()}/api/internal/objectives/${objectiveId}/status`, {
        method: 'PATCH',
        headers: internalApiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status: 'working', reason: 'full_access', actor }),
      })
      const text = await resp.text()
      if (!resp.ok) return { ok: false, reason: `${resp.status} ${text.slice(0, 300)}` }
      let status: string | undefined
      try { status = (JSON.parse(text) as { status?: string }).status } catch { /* not JSON */ }
      return { ok: true, status }
    } catch (err) {
      return { ok: false, reason: `start request failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
  async messageCard(objectiveId, message) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port()}/api/internal/objectives/${objectiveId}/message`, {
        method: 'POST',
        headers: internalApiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message }),
      })
      const text = await resp.text()
      if (!resp.ok) return { ok: false, reason: `${resp.status} ${text.slice(0, 300)}` }
      let body: { status?: string; skipped?: boolean; reason?: string } = {}
      try { body = JSON.parse(text) as typeof body } catch { /* not JSON */ }
      // obj 901059: say what a locked status MEANS, so the bot can tell the person plainly (and offer to reopen) instead of a bare code.
      if (body.skipped) return { ok: false, status: body.status, reason: body.reason === 'locked_status' ? `not delivered: card #${objectiveId} is already ${body.status === 'cancelled' ? 'cancelled' : 'finished'}, so nothing was sent and nothing changed. If the person wants it to act, it must be reopened first (they can press Reopen and apply on a decision, or Reopen on the card).` : `not delivered: ${body.reason ?? 'the card refused it'}` }
      return { ok: true, status: body.status }
    } catch (err) {
      return { ok: false, reason: `message request failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
  async requestReview(objectiveId, opts) {
    const db = getDb()
    const { sessionCapReached, SESSION_CAP_ERROR } = await import('../../lib/session-cap.js')
    if (sessionCapReached(db)) return { id: objectiveId, ok: false, code: 'spawn_failed', detail: SESSION_CAP_ERROR }
    const { defaultAiReviewDeps } = await import('../../routes/internal-ai-review.js')
    return requestAiReview(db, objectiveId, defaultAiReviewDeps(), opts)
  },
}

type FaCtx = Pick<ToolContext, 'userId' | 'agent' | 'workspace'> & Partial<Pick<ToolContext, 'botWake' | 'username' | 'kbRoot' | 'now'>> & { fullAccessHost?: FullAccessHost }

function personIsAdmin(userId: number): boolean {
  try {
    const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined
    return row?.role === 'admin'
  } catch {
    return false
  }
}

/**
 * The workspaces where this bot's Full access counts in THIS turn: switched on
 * and unexpired, the bot acting for an install admin, and — in a bot-to-bot
 * wake — only the conversation's workspace. Empty = no Full access here.
 */
export function fullAccessWorkspaces(ctx: FaCtx): string[] {
  if (!personIsAdmin(ctx.userId)) return []
  const now = ctx.now?.() ?? new Date()
  let on: string[] = []
  try {
    on = listFullAccess(ctx.agent.slug, now).filter(a => a.state === 'on' && fullAccessActive(ctx.agent.slug, a.workspace, now)).map(a => a.workspace)
  } catch {
    return []
  }
  return ctx.botWake ? on.filter(w => w === ctx.workspace) : on
}

/** Tools Full access implies, on top of what the bot's file lists. Never `secrets` or `mcp`. */
export const FULL_ACCESS_IMPLIED_TOOLS = ['search', 'list_folders', 'read_file', 'write_doc', 'create_objective', 'get_objective', 'list_objectives', 'board_briefing'] as const

/**
 * Knowledge folders Full access adds: the whole knowledge folder of each
 * workspace it counts in, relative to the knowledge-base root (the form
 * knowledge_folders use). The ordinary knowledge tools then read and write
 * there under the same two walls as before — inside the KB root, and never in
 * a workspace the bot is not granted (kbWorkspaceGuard).
 */
export function fullAccessKnowledgeFolders(ctx: FaCtx & { kbRoot: string }): string[] {
  const out: string[] = []
  const kb = realpathOrNull(ctx.kbRoot) ?? path.resolve(ctx.kbRoot)
  for (const ws of fullAccessWorkspaces(ctx)) {
    const candidates: string[] = []
    try { candidates.push(workspaceKbRoot(ws)) } catch { /* bad slug */ }
    candidates.push(...workspaceScopeRoots(ws, ctx.kbRoot))
    const inside = [...new Set(candidates.map(c => realpathOrNull(c) ?? path.resolve(c)))]
      .filter(c => c !== kb && containedIn(c, kb))
    let picked = inside.filter(c => fs.existsSync(c))
    if (picked.length === 0) {
      // Nothing written yet: the folder a first note would create.
      const nested = path.join(kb, 'workspaces')
      picked = [fs.existsSync(nested) ? path.join(nested, ws) : path.join(kb, ws)]
    }
    for (const p of picked) {
      const rel = path.relative(kb, p).split(path.sep).join('/')
      if (rel && !rel.startsWith('..') && !out.includes(rel)) out.push(rel)
    }
  }
  return out
}

/** The agent as Full access sees it: implied tools and the workspace knowledge folders added. Same object when nothing applies. */
export function withFullAccess<T extends FaCtx & { kbRoot: string }>(ctx: T): T {
  if (fullAccessWorkspaces(ctx).length === 0) return ctx
  const tools = [...new Set([...ctx.agent.tools, ...FULL_ACCESS_IMPLIED_TOOLS])]
  const folders = [...new Set([...ctx.agent.knowledge_folders, ...fullAccessKnowledgeFolders(ctx)])]
  return { ...ctx, agent: { ...ctx.agent, tools, knowledge_folders: folders } }
}

/** One ground-rules line for the system prompt, or '' when Full access does not apply. */
export function fullAccessPromptLine(ctx: FaCtx): string {
  const on = fullAccessWorkspaces(ctx)
  if (on.length === 0) return ''
  return (
    `- You have FULL ACCESS in ${on.join(', ')} (an admin switched it on for you). There you may read and act on every card whatever its owner ` +
    '(card_read, card_take_over, card_reown, card_comment, card_restart), read and write the whole workspace knowledge base, read and edit workflows ' +
    '(drafts only) and scheduled tasks, read bot settings and run history, start a repo session (repo_session_start), and file and own cards. ' +
    'It NEVER includes using secrets, minting or revoking keys, or DNS and Cloudflare Access: there is no switch for those. Billing is refused unless full_access_status shows that switch on. ' +
    'A card that carries a protected pull request is out of reach. Every refused call is logged. ' +
    'It never approves a merge, a prod migration or a deploy: those need the owner or an "approve on my behalf" grant.'
  )
}

// ── tool specs ──

function obj(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false }
}
function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { type: 'function', function: { name, description, parameters } }
}

const WS_ARG = { type: 'string', description: 'Workspace slug. Omit for this chat\'s workspace. Only a workspace where you have Full access is accepted.' }

const FULL_ACCESS_SPECS: ToolSpec[] = [
  fn('full_access_status', 'Where you have Full access right now, when it expires, and whether an admin switched Billing on. Secret values, keys and DNS / Cloudflare Access are never part of Full access.', obj({})),
  fn('card_read', 'Full access: read ANY card in the workspace in full, whoever owns it — description, success criteria, owner, worker, status, latest result, AI review, PR link.', obj({ id: { type: 'integer' } }, ['id'])),
  fn('card_take_over', 'Full access: take a card over — you become its worker and owner, whoever had it. It does not restart the card; use card_restart or card_comment for that.',
    obj({ id: { type: 'integer' }, note: { type: 'string', description: 'Why you are taking it (kept in the log).' } }, ['id'])),
  fn('card_reown', 'Full access: hand a card to another owner — an agent or bot that may work in this workspace (agent), and/or a person in this workspace (assign_to, a username).',
    obj({ id: { type: 'integer' }, agent: { type: 'string', description: 'Agent or bot slug to work the card.' }, assign_to: { type: 'string', description: 'Username of the person the card is assigned to.' }, note: { type: 'string' } }, ['id'])),
  fn('card_comment', 'Full access: post a message on any card in the workspace. The card\'s worker reads it as a message from you (a bot, not the owner) and is woken to act on it. It can never count as the owner\'s approval of a merge or deploy.',
    obj({ id: { type: 'integer' }, message: { type: 'string', description: 'What the worker should know or do next.' } }, ['id', 'message'])),
  fn('card_restart', 'Full access: restart any card in the workspace (move it back to working, which starts its worker). The board\'s own rules still apply: a locked or human-closed card is not reopened.',
    obj({ id: { type: 'integer' }, message: { type: 'string', description: 'Optional instruction to restart it with.' } }, ['id'])),
  fn('card_request_review', 'Full access: ask for an AI review of YOUR OWN card (one you own) when it sits in review with a pull request and no review verdict. It does not re-run the work. Refused for another bot\'s card, a protected card, a card that already has a verdict, and once the card has used its review rounds.',
    obj({ id: { type: 'integer' }, note: { type: 'string', description: 'Why it needs a review now (kept in the log).' } }, ['id'])),
  fn('workflow_list', 'Full access: list the workspace\'s workflows (id, name, status, published and latest version).', obj({ workspace: WS_ARG })),
  fn('workflow_read', 'Full access: read one workflow: its details and the latest version\'s definition.', obj({ id: { type: 'integer' } }, ['id'])),
  fn('workflow_save_draft', 'Full access: save an edited workflow definition as a new DRAFT version. Read it first and send the FULL definition. A draft never runs: publishing is the owner\'s click in the app.',
    obj({ id: { type: 'integer' }, definition: { type: 'object', description: 'The full okflow/1 definition.' } }, ['id', 'definition'])),
  fn('routine_list', 'Full access: list the workspace\'s scheduled tasks (id, name, kind, schedule, on/off, last and next run).', obj({ workspace: WS_ARG })),
  fn('routine_read', 'Full access: read one scheduled task in full, including its brief.', obj({ id: { type: 'integer' } }, ['id'])),
  fn('routine_update', 'Full access: edit a scheduled task: its schedule (cron), on/off, or the title and brief of an AI task. Script commands and High Agency wake schedules cannot be edited from here.',
    obj({
      id: { type: 'integer' },
      cron: { type: 'string', description: '5-field cron expression, server time.' },
      enabled: { type: 'boolean' },
      title: { type: 'string' },
      description: { type: 'string', description: 'The brief each run is given (AI tasks only).' },
    }, ['id'])),
  fn('bot_list', 'Full access: the bots that may work in this workspace, with their model, tools and whether High Agency is on.', obj({ workspace: WS_ARG })),
  fn('bot_read', 'Full access: one bot\'s settings in full: instructions, model, tools, knowledge folders, High Agency.', obj({ slug: { type: 'string' }, workspace: WS_ARG }, ['slug'])),
  fn('bot_run_history', 'Full access: a bot\'s recent runs in this workspace: its High Agency wakes and the cards it worked.',
    obj({ slug: { type: 'string' }, workspace: WS_ARG, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20' } }, ['slug'])),
  fn('repo_session_start', 'Full access: get a repo checkout. Files a card on one of this workspace\'s projects (repos), owned by you, and starts it: the card\'s session runs in its own git worktree of that repo and reports back on the card. Use for code changes and anything that needs the files.',
    obj({
      project: { type: 'string', description: 'The project (repo) name, as it appears on this workspace\'s cards.' },
      title: { type: 'string' },
      description: { type: 'string', description: 'What to do in the repo, and what "done" looks like.' },
      workspace: WS_ARG,
    }, ['project', 'title', 'description'])),
]

export const FULL_ACCESS_FNS: ReadonlySet<string> = new Set(FULL_ACCESS_SPECS.map(s => s.function.name))

/** Abilities that change something. Each successful use is one audit row. */
const WRITE_ABILITIES: ReadonlySet<string> = new Set([
  'card_take_over', 'card_reown', 'card_comment', 'card_restart', 'card_request_review', 'workflow_save_draft', 'routine_update', 'repo_session_start',
])

/** The Full access tool specs, only while Full access counts for this turn. */
export function fullAccessToolSpecs(ctx: FaCtx): ToolSpec[] {
  return fullAccessWorkspaces(ctx).length > 0 ? FULL_ACCESS_SPECS : []
}

// ── the gate every ability passes ──

function refuse(ctx: FaCtx, ability: string, workspace: string | null, detail: string, message: string, objectiveId?: number): never {
  writeFullAccessAudit({
    event: 'ability_refused',
    slug: ctx.agent.slug,
    workspace,
    actor: `bot:${ctx.agent.slug}`,
    actor_user_id: ctx.userId,
    ability,
    objective_id: objectiveId ?? null,
    detail,
  })
  throw new ToolUseError(message)
}

function botLabel(ctx: FaCtx): string {
  return ctx.agent.name || ctx.agent.slug
}

/** The workspace an ability runs in, or a logged refusal. `wanted` '' = the chat's workspace. */
function requireWorkspace(ctx: FaCtx, ability: string, wantedRaw: unknown, objectiveId?: number): string {
  const wanted = typeof wantedRaw === 'string' && wantedRaw.trim() ? wantedRaw.trim() : ctx.workspace
  if (!personIsAdmin(ctx.userId)) {
    refuse(ctx, ability, wanted || null, 'the person the bot is acting for is not an admin',
      `${botLabel(ctx)}'s Full access applies only when it is working for an admin. For you it stays inside what you can see yourself.`, objectiveId)
  }
  const on = fullAccessWorkspaces(ctx)
  if (!wanted || !on.includes(wanted)) {
    const state = wanted ? getFullAccess(ctx.agent.slug, wanted, ctx.now?.() ?? new Date()).state : 'off'
    const why = !wanted
      ? 'no workspace'
      : state === 'expired'
        ? 'Full access has expired in this workspace'
        : state === 'on'
          ? ctx.botWake ? 'outside the workspace of this bot conversation' : 'the workspace is no longer granted to the bot'
          : 'Full access is off in this workspace'
    refuse(ctx, ability, wanted || null, why,
      `${botLabel(ctx)} has no Full access in ${wanted ? `"${wanted}"` : 'this chat'}${state === 'expired' ? ' (it expired)' : ''}. Workspaces where it is on: ${on.join(', ') || '(none)'}. An admin switches it on in the bot's settings.`, objectiveId)
  }
  return wanted
}

interface CardRow extends Objective { deleted_at?: string | null }

/** A card, only if it sits in a workspace where Full access counts. Missing and out-of-reach read the same. */
function requireCard(ctx: FaCtx, ability: string, idRaw: unknown): CardRow {
  const id = Math.trunc(Number(idRaw))
  if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a card number.')
  const row = getDb().prepare('SELECT * FROM objectives WHERE id = ? AND deleted_at IS NULL').get(id) as CardRow | undefined
  const on = fullAccessWorkspaces(ctx)
  if (!row || !on.includes(row.workspace)) {
    // Check the person first so a member gets the plain reason, not a card oracle.
    if (!personIsAdmin(ctx.userId)) requireWorkspace(ctx, ability, ctx.workspace, id)
    refuse(ctx, ability, row && botMayUseWorkspace(ctx.agent.slug, row.workspace) ? row.workspace : null, 'card is not in a workspace where Full access is on',
      `Card #${id} is not in a workspace where ${botLabel(ctx)} has Full access. Workspaces where it is on: ${on.join(', ') || '(none)'}.`, id)
  }
  // A card that carries a protected pull request is out of reach of every ability, reads included.
  const protectedRefusal = protectedCardRefusal({ slug: ctx.agent.slug, workspace: row.workspace, ability, card: row, actorUserId: ctx.userId })
  if (protectedRefusal) throw new ToolUseError(protectedRefusal)
  return row
}

function used(ctx: FaCtx, ability: string, workspace: string, detail: string, objectiveId?: number): void {
  if (!WRITE_ABILITIES.has(ability)) return
  writeFullAccessAudit({ event: 'ability_used', slug: ctx.agent.slug, workspace, actor: `bot:${ctx.agent.slug}`, actor_user_id: ctx.userId, ability, objective_id: objectiveId ?? null, detail })
  try {
    logActivity({
      project: 'operationkit',
      workspace,
      objective_id: objectiveId ?? null,
      event_type: 'decision',
      title: `${botLabel(ctx)} (Full access): ${detail}`.slice(0, 200),
      detail: null,
      metadata: { kind: 'bot_full_access_used', slug: ctx.agent.slug, ability, workspace, acting_for_user_id: ctx.userId },
    })
  } catch { /* the activity feed is best-effort */ }
}

function broadcastCard(id: number): Objective | undefined {
  const row = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined
  if (row) {
    try { broadcast({ type: 'objective_updated', payload: row }) } catch { /* no WS server in tests */ }
  }
  return row
}

/**
 * The owner_bot a card gets when this bot owns it — the same rule a chat-filed
 * card follows (tools.ts createCard, obj 900948): the registry bot's id when the
 * bot is in the bot registry, else its name or slug, and never a value that
 * resolves to some OTHER registered bot.
 */
export function ownerBotName(agent: Pick<ChatAgent, 'slug' | 'name'>): string | null {
  const db = getDb()
  const registered = botForAgentSlug(agent.slug, db)
  if (registered) return registered.id
  return chatOwnerBotName(agent, db)
}

/**
 * Why this bot cannot be named as a card's worker in `workspace`, or null when
 * it can. The one pool gate decides (obj 900948's `checkAgentInWorkspacePool`,
 * which a granted bot passes) — there is no second bypass here, and (obj
 * 901026) no second refusal either: a bot whose slug also names a worker
 * persona is no longer refused on that account alone. "A bot and an agent are
 * the same thing" — an explicit workspace grant IS the decision that the slug
 * belongs to the bot here, superseding the review-of-PR-797 carve-out.
 */
export function botOwnershipRefusal(slug: string, workspace: string, project?: string | null): string | null {
  return checkAgentInWorkspacePool(workspace, slug, project ?? null)
}

function clip(text: unknown, max: number): string | null {
  if (typeof text !== 'string' || !text) return null
  return text.length > max ? `${text.slice(0, max)}… [cut]` : text
}

function str(args: Record<string, unknown>, key: string, required = false): string {
  const v = args[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (required) throw new ToolUseError(`"${key}" is required.`)
  return ''
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

// ── routines ──

interface RoutineRow {
  id: number
  name: string
  cron_expr: string
  objective_template: string
  enabled: number
  last_run_at: string | null
  kind?: string | null
  flow_id?: number | null
  script_command?: string | null
  last_run_status?: string | null
  auto_paused_at?: string | null
  auto_pause_reason?: string | null
}

function routineTemplate(r: RoutineRow): Record<string, unknown> {
  try {
    const t = JSON.parse(r.objective_template || '{}') as unknown
    return t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A routine's workspace: its template's, or its workflow's. null = it belongs to no workspace this can name. */
function routineWorkspace(r: RoutineRow): string | null {
  const ws = routineTemplate(r).workspace
  if (typeof ws === 'string' && ws) return ws
  if (r.flow_id != null) {
    try {
      const f = getDb().prepare('SELECT workspace FROM flow_definitions WHERE id = ?').get(r.flow_id) as { workspace: string } | undefined
      if (f) return f.workspace
    } catch { /* no flow tables */ }
  }
  const m = /^flow:([^/]+)\//.exec(r.name)
  return m ? m[1] : null
}

function routineKind(r: RoutineRow): string {
  return r.kind || 'ai'
}

async function routineView(r: RoutineRow, full: boolean) {
  const { describeCron, nextRunAt } = await import('../routine-scheduler.js')
  const tpl = routineTemplate(r)
  const next = nextRunAt(r.cron_expr)
  return {
    id: r.id,
    name: r.name,
    kind: routineKind(r),
    title: typeof tpl.title === 'string' ? tpl.title : r.name,
    cron: r.cron_expr,
    cadence: describeCron(r.cron_expr),
    enabled: Number(r.enabled) === 1,
    last_run_at: r.last_run_at,
    last_run_status: r.last_run_status ?? null,
    next_run_at: next ? next.toISOString() : null,
    auto_paused: !!r.auto_paused_at,
    ...(r.auto_pause_reason ? { auto_pause_reason: r.auto_pause_reason } : {}),
    ...(full
      ? {
          agent: typeof tpl.agent_context === 'string' ? tpl.agent_context : null,
          project: typeof tpl.project === 'string' ? tpl.project : null,
          description: clip(tpl.description, 8000),
          // A script task's command runs on the host; it is shown so the bot can explain the task, never edited here.
          ...(routineKind(r) === 'script' ? { script_command: clip(r.script_command, 2000) } : {}),
        }
      : {}),
  }
}

// ── dispatch ──

export async function runFullAccessTool(ctx: FaCtx & { username: string }, fnName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!FULL_ACCESS_FNS.has(fnName)) throw new ToolUseError(`Unknown tool "${fnName}".`)
  const db = getDb()
  const host = ctx.fullAccessHost ?? hostFullAccessHost
  const now = ctx.now?.() ?? new Date()
  const me = botLabel(ctx)

  switch (fnName) {
    case 'full_access_status': {
      if (!personIsAdmin(ctx.userId)) requireWorkspace(ctx, fnName, ctx.workspace)
      const on = fullAccessWorkspaces(ctx)
      const rows = on.map(ws => {
        const a = getFullAccess(ctx.agent.slug, ws, now)
        return { workspace: ws, expires_at: a.expires_at ? `${a.expires_at} UTC` : null, billing_switched_on: a.allow.billing, never_allowed: [...FULL_ACCESS_PERMANENT_EXCLUSIONS] }
      })
      return {
        result: {
          full_access: rows,
          note: rows.length
            ? 'Secrets, keys and DNS / Cloudflare Access are always refused and logged; billing too unless switched on. Merge, prod-migration and deploy approvals are never part of Full access.'
            : 'Full access is not on in any workspace for this chat.',
        },
        summary: rows.length ? `Full access is on in ${on.join(', ')}` : 'Full access is off',
      }
    }

    case 'card_read': {
      const c = requireCard(ctx, fnName, args.id)
      const assignee = c.assigned_user_id
        ? (db.prepare('SELECT username FROM users WHERE id = ?').get(c.assigned_user_id) as { username: string } | undefined)?.username ?? null
        : null
      const r = c as unknown as Record<string, unknown>
      return {
        result: {
          id: c.id,
          title: c.title,
          status: c.status,
          workspace: c.workspace,
          project: c.project ?? null,
          type: c.type,
          worker_agent: c.agent_context,
          owner_bot: r.owner_bot ?? null,
          assigned_to: assignee,
          parent_id: c.parent_id ?? null,
          has_blockers: Number(c.has_blockers) > 0,
          pr_url: c.pr_url ?? null,
          ai_review_verdict: c.ai_review_verdict ?? null,
          ai_review_findings: clip(r.ai_review_findings, 3000),
          description: clip(c.description, 8000),
          completion_goal: clip(r.completion_goal, 3000),
          acceptance_criteria: clip(typeof r.acceptance_criteria === 'string' ? r.acceptance_criteria : JSON.stringify(r.acceptance_criteria ?? null), 3000),
          latest_result: clip(c.last_session_summary, 6000),
          updated_at: c.updated_at,
          url: publicCardUrl(c.id),
        },
        summary: `Read card #${c.id} in full (${c.status})`,
        objective_id: c.id,
      }
    }

    case 'card_take_over': {
      const c = requireCard(ctx, fnName, args.id)
      // The one pool gate (obj 900948): a granted bot passes it, nothing else is bypassed.
      const poolError = botOwnershipRefusal(ctx.agent.slug, c.workspace, c.project ?? null)
      if (poolError) refuse(ctx, fnName, c.workspace, poolError, poolError, c.id)
      const before = { agent: c.agent_context, owner: (c as unknown as { owner_bot?: string | null }).owner_bot ?? null }
      db.prepare("UPDATE objectives SET agent_context = ?, owner_bot = ?, updated_at = datetime('now') WHERE id = ?").run(ctx.agent.slug, ownerBotName(ctx.agent), c.id)
      broadcastCard(c.id)
      const note = str(args, 'note')
      used(ctx, fnName, c.workspace, `took over card #${c.id} from ${before.owner || before.agent || 'nobody'}${note ? ` — ${note.slice(0, 200)}` : ''}`, c.id)
      return {
        result: { id: c.id, worker_agent: ctx.agent.slug, owner_bot: ownerBotName(ctx.agent), previous: before, note: 'You own this card now. It was not restarted: use card_restart or card_comment to move it.' },
        summary: `Took over card #${c.id}`,
        objective_id: c.id,
      }
    }

    case 'card_reown': {
      const c = requireCard(ctx, fnName, args.id)
      const agentSlug = str(args, 'agent')
      const assignTo = str(args, 'assign_to')
      if (!agentSlug && !assignTo) throw new ToolUseError('Name the new owner: "agent" (an agent or bot slug) and/or "assign_to" (a username).')
      const sets: string[] = []
      const params: unknown[] = []
      const changed: string[] = []
      let newAssignee: number | null = null
      if (agentSlug) {
        if (!SLUG_RE.test(agentSlug)) throw new ToolUseError('agent must be an agent or bot slug.')
        const poolError = checkAgentInWorkspacePool(c.workspace, agentSlug, c.project ?? null)
        if (poolError) refuse(ctx, fnName, c.workspace, poolError, poolError, c.id)
        const { findAgent } = await import('./engine.js')
        const bot = findAgent(agentSlug)
        let persona = false
        try { persona = agentExists(agentSlug) } catch { persona = false }
        // A real worker: an agent on this install's roster, or a bot that may work in this workspace.
        if ((!bot && !persona) || (bot && !persona && !botMayUseWorkspace(bot.slug, c.workspace))) {
          throw new ToolUseError(`"${agentSlug}" is not an agent or bot that works in the ${c.workspace} workspace.`)
        }
        // obj 901026 (review fix): an EXPLICIT workspace grant makes the bot
        // the card's owner even when the slug also names a worker persona —
        // the grant is the decision that the two are one identity here, not
        // the clash. EXCEPT the five protected default-roster personas
        // (cto/cmo/coo/cfo/general): those stay the persona's, never the bot's,
        // regardless of a grant (`personaOwnershipBlocked`).
        const botOwns = !!bot && !personaOwnershipBlocked(agentSlug, c.workspace) && (botGrantedWorkspace(agentSlug, c.workspace) || !persona)
        sets.push('agent_context = ?', 'owner_bot = ?')
        params.push(agentSlug, bot && botOwns ? ownerBotName(bot) : null)
        changed.push(`worker ${agentSlug}`)
      }
      if (assignTo) {
        const u = db.prepare('SELECT id, role, username FROM users WHERE username = ?').get(assignTo) as { id: number; role: string; username: string } | undefined
        // Same answer for "no such person" and "not in this workspace".
        if (!u || (u.role !== 'admin' && !userHasWorkspace(u.id, c.workspace))) {
          throw new ToolUseError(`"${assignTo}" is not a person in the ${c.workspace} workspace.`)
        }
        sets.push('assigned_user_id = ?')
        params.push(u.id)
        changed.push(`assigned to ${u.username}`)
        newAssignee = u.id
      }
      db.prepare(`UPDATE objectives SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params, c.id)
      // The assignee list is the board's source of truth for "who is on this card".
      if (newAssignee !== null) setAssignees(c.id, [newAssignee])
      broadcastCard(c.id)
      const note = str(args, 'note')
      used(ctx, fnName, c.workspace, `re-owned card #${c.id}: ${changed.join(', ')}${note ? ` — ${note.slice(0, 200)}` : ''}`, c.id)
      return { result: { id: c.id, changed }, summary: `Re-owned card #${c.id} (${changed.join(', ')})`, objective_id: c.id }
    }

    case 'card_comment': {
      const c = requireCard(ctx, fnName, args.id)
      const message = str(args, 'message', true).slice(0, 8000)
      // Named as a bot, so the worker (and anyone reading the card) sees who wrote it. The server
      // stamps the delivery as an unverified relay: it cannot pass for the owner's approval.
      const r = await host.messageCard(c.id, `[From the bot ${me} (Full access in ${c.workspace}), acting for ${ctx.username}. Not the owner: this is not an approval of any merge, migration or deploy.]\n${message}`)
      if (!r.ok) throw new ToolUseError(`The message was not delivered to card #${c.id}: ${r.reason ?? 'unknown reason'}`)
      used(ctx, fnName, c.workspace, `commented on card #${c.id}`, c.id)
      return { result: { id: c.id, delivered: true, status: r.status ?? null, note: 'Delivered. The card\'s worker was woken to read it.' }, summary: `Commented on card #${c.id}`, objective_id: c.id }
    }

    case 'card_restart': {
      const c = requireCard(ctx, fnName, args.id)
      const message = str(args, 'message').slice(0, 8000)
      const r = message
        ? await host.messageCard(c.id, `[From the bot ${me} (Full access in ${c.workspace}), acting for ${ctx.username}. Restarting this card. Not the owner: this is not an approval of any merge, migration or deploy.]\n${message}`)
        : await host.startCard(c.id, `bot:${ctx.agent.slug}`)
      if (!r.ok) throw new ToolUseError(`Card #${c.id} was not restarted: ${r.reason ?? 'unknown reason'}`)
      used(ctx, fnName, c.workspace, `restarted card #${c.id}`, c.id)
      return { result: { id: c.id, restarted: true, status: r.status ?? 'working' }, summary: `Restarted card #${c.id}`, objective_id: c.id }
    }

    case 'card_request_review': {
      const c = requireCard(ctx, fnName, args.id)
      // Own card only: the one ownership rule (obj 900956). Taking a card over
      // first is a separate, logged act; this tool never reaches past it.
      if (!ownerHasSlug(cardOwnerBot(c, db), ctx.agent.slug)) {
        refuse(ctx, fnName, c.workspace, 'card is not owned by this bot',
          `Card #${c.id} is not ${me}'s card, so ${me} cannot ask for its review. Its owner, or a person, can.`, c.id)
      }
      const iteration = Number((c as unknown as { ai_review_iteration?: number | null }).ai_review_iteration) || 0
      if (iteration >= AI_REVIEW_ITERATION_CAP) {
        refuse(ctx, fnName, c.workspace, `review cap reached (${iteration}/${AI_REVIEW_ITERATION_CAP})`,
          `Card #${c.id} has used its ${AI_REVIEW_ITERATION_CAP} AI review rounds. Another review needs a person: raise a decision for the owner.`, c.id)
      }
      const doReview = host.requestReview ?? hostFullAccessHost.requestReview!
      const r = await doReview(c.id, { requestedBy: `bot:${ctx.agent.slug}`, maxIteration: AI_REVIEW_ITERATION_CAP })
      if (!r.ok) {
        const why: Record<string, string> = {
          not_in_review: `it is ${c.status}, not in review`,
          has_verdict: `it already has a review verdict (${c.ai_review_verdict})`,
          no_pr: 'it has no pull request linked',
          pr_not_open: `its pull request is ${r.detail ?? 'not open'}`,
          delegator: 'it is a delegator card', strategy: 'it is a Strategy', routine: 'it is a scheduled-task run',
          skip_ai_review: 'AI review is switched off for it',
          iteration_cap: `it has used its ${AI_REVIEW_ITERATION_CAP} AI review rounds`,
          spawn_failed: `the reviewer did not start (${r.detail ?? 'unknown reason'})`,
          raced: 'the card moved while the reviewer started',
        }
        const reason = why[r.code] ?? r.code
        refuse(ctx, fnName, c.workspace, `review not requested: ${r.code}`, `No review was started for card #${c.id}: ${reason}.`, c.id)
      }
      broadcastCard(c.id)
      const note = str(args, 'note')
      used(ctx, fnName, c.workspace, `asked for an AI review of card #${c.id} (round ${r.iteration} of ${AI_REVIEW_ITERATION_CAP})${note ? ` — ${note.slice(0, 200)}` : ''}`, c.id)
      return {
        result: { id: c.id, status: 'ai_review', review_round: r.iteration, review_cap: AI_REVIEW_ITERATION_CAP, note: 'The AI reviewer is reading the pull request now. The verdict lands on the card; the work was not re-run.' },
        summary: `Asked for an AI review of card #${c.id}`,
        objective_id: c.id,
      }
    }

    case 'workflow_list': {
      const ws = requireWorkspace(ctx, fnName, args.workspace)
      const { latestFlowVersion } = await import('../flow-routines.js')
      let rows: { id: number; slug: string; name: string; status: string; published_version: number | null; updated_at: string }[] = []
      try {
        rows = db.prepare("SELECT id, slug, name, status, published_version, updated_at FROM flow_definitions WHERE workspace = ? AND status != 'archived' ORDER BY updated_at DESC LIMIT 100").all(ws) as typeof rows
      } catch { rows = [] }
      const workflows = rows.map(f => ({ ...f, latest_version: latestFlowVersion(db, f.id) }))
      return { result: { workspace: ws, workflows }, summary: `Listed workflows in ${ws} (${workflows.length})` }
    }

    case 'workflow_read':
    case 'workflow_save_draft': {
      const id = Math.trunc(Number(args.id))
      const { getFlowRow, latestFlowVersion, loadFlowVersion } = await import('../flow-routines.js')
      const flow = Number.isInteger(id) && id > 0 ? getFlowRow(db, id) : null
      const on = fullAccessWorkspaces(ctx)
      if (!flow || !on.includes(flow.workspace)) {
        if (!personIsAdmin(ctx.userId)) requireWorkspace(ctx, fnName, ctx.workspace)
        refuse(ctx, fnName, null, 'workflow is not in a workspace where Full access is on', `Workflow #${args.id} is not in a workspace where ${me} has Full access.`)
      }
      const latest = latestFlowVersion(db, flow.id)
      if (fnName === 'workflow_read') {
        const def = latest != null ? loadFlowVersion(db, flow.id, latest) : null
        let json = JSON.stringify(def ?? null)
        const cut = json.length > 30_000
        if (cut) json = `${json.slice(0, 30_000)}… [cut]`
        return {
          result: {
            id: flow.id, slug: flow.slug, name: flow.name, workspace: flow.workspace, status: flow.status,
            published_version: flow.published_version, latest_version: latest, notes: clip(flow.notes, 4000),
            definition: cut ? json : def,
            ...(cut ? { truncated: true } : {}),
          },
          summary: `Read workflow "${flow.name}"`,
        }
      }
      if (flow.status === 'archived') throw new ToolUseError('This workflow is archived and cannot be edited.')
      const raw = args.definition
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolUseError('definition (the full okflow/1 JSON object) is required.')
      const { saveFlowVersion } = await import('../flow-engine.js')
      const def = { ...(raw as Record<string, unknown>) }
      // The flow's identity is not the model's to change: same id, same workspace, next version.
      def.id = flow.slug
      def.workspace = flow.workspace
      def.version = (latest ?? 0) + 1
      const saved = saveFlowVersion(db, { workspace: flow.workspace, definition: def as never, author: `bot:${ctx.agent.slug}` })
      if (!saved.ok) {
        const errors = (saved.errors ?? []).slice(0, 10)
        throw new ToolUseError(`The draft was not saved (${saved.reason}).${errors.length ? ` ${JSON.stringify(errors).slice(0, 1500)}` : ''}`)
      }
      used(ctx, fnName, flow.workspace, `saved draft v${saved.version} of workflow "${flow.name}" (#${flow.id})`)
      return {
        result: { id: flow.id, version: saved.version, created: saved.created, status: 'draft', note: 'Saved as a draft. It does not run until the owner publishes it in the app.' },
        summary: `Saved draft v${saved.version} of workflow "${flow.name}"`,
      }
    }

    case 'routine_list': {
      const ws = requireWorkspace(ctx, fnName, args.workspace)
      const rows = (db.prepare('SELECT * FROM routines ORDER BY id').all() as RoutineRow[]).filter(r => routineWorkspace(r) === ws)
      const routines = await Promise.all(rows.slice(0, 200).map(r => routineView(r, false)))
      return { result: { workspace: ws, scheduled_tasks: routines }, summary: `Listed scheduled tasks in ${ws} (${routines.length})` }
    }

    case 'routine_read':
    case 'routine_update': {
      const id = Math.trunc(Number(args.id))
      const r = Number.isInteger(id) && id > 0 ? (db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined) : undefined
      const rws = r ? routineWorkspace(r) : null
      const on = fullAccessWorkspaces(ctx)
      if (!r || !rws || !on.includes(rws)) {
        if (!personIsAdmin(ctx.userId)) requireWorkspace(ctx, fnName, ctx.workspace)
        refuse(ctx, fnName, null, 'scheduled task is not in a workspace where Full access is on', `Scheduled task #${args.id} is not in a workspace where ${me} has Full access.`)
      }
      if (fnName === 'routine_read') {
        return { result: await routineView(r, true), summary: `Read scheduled task "${r.name}"` }
      }
      if (highAgencyRoutineSlug(r.name)) {
        refuse(ctx, fnName, rws, 'High Agency wake schedules are an admin setting',
          'A High Agency wake schedule is set by an admin on the bot\'s settings panel. A bot cannot change its own or another bot\'s wake schedule.')
      }
      for (const k of ['script_command', 'kind', 'alert_marker', 'script_timeout_sec', 'objective_template', 'workspace', 'agent', 'agent_context', 'name', 'max_queue_depth']) {
        if (args[k] !== undefined) {
          refuse(ctx, fnName, rws, `field "${k}" is not editable with Full access`,
            `"${k}" cannot be changed from here. Full access edits a scheduled task's schedule, on/off, and an AI task's title and brief. A script command runs on the host and stays with an admin.`)
        }
      }
      const { validateCronExpr } = await import('../routine-scheduler.js')
      const sets: string[] = []
      const params: unknown[] = []
      const changed: string[] = []
      if (args.cron !== undefined) {
        if (routineKind(r) === 'flow') throw new ToolUseError('This task runs a workflow: its schedule comes from the workflow\'s trigger. Edit the workflow (workflow_save_draft) instead.')
        const cron = str(args, 'cron', true)
        const err = validateCronExpr(cron)
        if (err) throw new ToolUseError(err)
        sets.push('cron_expr = ?')
        params.push(cron)
        changed.push(`schedule ${cron}`)
      }
      if (args.enabled !== undefined) {
        if (typeof args.enabled !== 'boolean') throw new ToolUseError('enabled must be true or false.')
        sets.push('enabled = ?')
        params.push(args.enabled ? 1 : 0)
        // Switching it back on is a resume, as on the Jobs board: clear the auto-pause state.
        if (args.enabled) sets.push('consecutive_failures = 0', 'auto_paused_at = NULL', 'auto_pause_reason = NULL')
        changed.push(args.enabled ? 'switched on' : 'switched off')
      }
      if (args.title !== undefined || args.description !== undefined) {
        if (routineKind(r) !== 'ai') throw new ToolUseError('Only an AI task has a title and brief to edit. This one is a ' + routineKind(r) + ' task.')
        const tpl = routineTemplate(r)
        if (args.title !== undefined) { tpl.title = str(args, 'title', true).slice(0, 200); changed.push('title') }
        if (args.description !== undefined) { tpl.description = str(args, 'description', true).slice(0, 20_000); changed.push('brief') }
        sets.push('objective_template = ?')
        params.push(JSON.stringify(tpl))
      }
      if (sets.length === 0) throw new ToolUseError('Nothing to change. Send cron, enabled, title or description.')
      try {
        db.prepare(`UPDATE routines SET ${sets.join(', ')} WHERE id = ?`).run(...params, r.id)
      } catch (err) {
        // Older installs lack the auto-pause columns; the plain update still applies.
        const plain = sets.filter(s => !/consecutive_failures|auto_paused_at|auto_pause_reason/.test(s))
        if (plain.length === sets.length) throw err
        db.prepare(`UPDATE routines SET ${plain.join(', ')} WHERE id = ?`).run(...params, r.id)
      }
      used(ctx, fnName, rws, `edited scheduled task "${r.name}" (#${r.id}): ${changed.join(', ')}`)
      const after = db.prepare('SELECT * FROM routines WHERE id = ?').get(r.id) as RoutineRow
      return { result: { changed, scheduled_task: await routineView(after, true) }, summary: `Edited scheduled task "${r.name}" (${changed.join(', ')})` }
    }

    case 'bot_list':
    case 'bot_read':
    case 'bot_run_history': {
      const ws = requireWorkspace(ctx, fnName, args.workspace)
      const { listAgents } = await import('./engine.js')
      const { effectiveTools } = await import('./tools.js')
      const { getHighAgency } = await import('./high-agency.js')
      // Only bots that may work in THIS workspace: Full access is a workspace's view, not the install's.
      const bots = listAgents().agents.filter(a => botMayUseWorkspace(a.slug, ws))
      const ha = (slug: string) => {
        try {
          const s = getHighAgency(slug)
          return { enabled: s.enabled && s.workspace === ws, level: s.level, routine_id: s.workspace === ws ? s.routine_id : null }
        } catch {
          return { enabled: false, level: 1, routine_id: null as number | null }
        }
      }
      if (fnName === 'bot_list') {
        const list = bots.map(a => ({
          slug: a.slug, name: a.name, description: clip(a.description, 300), provider: a.provider, model: a.model,
          tools: effectiveTools(a), full_access_here: fullAccessActive(a.slug, ws, now), high_agency: { enabled: ha(a.slug).enabled, level: ha(a.slug).level },
        }))
        return { result: { workspace: ws, bots: list }, summary: `Listed bots in ${ws} (${list.length})` }
      }
      const slug = str(args, 'slug', true)
      const bot = bots.find(a => a.slug === slug)
      // Same answer for "no such bot" and "a bot that does not work here".
      if (!bot) throw new ToolUseError(`There is no bot "${slug}" working in the ${ws} workspace.`)
      if (fnName === 'bot_read') {
        return {
          result: {
            slug: bot.slug, name: bot.name, description: bot.description, source: bot.source, version: bot.version,
            provider: bot.provider, model: bot.model, tools: effectiveTools(bot), knowledge_folders: bot.knowledge_folders,
            instructions: clip(bot.system_prompt, 8000),
            overrides: bot.config ? { name: bot.config.name, provider: bot.config.provider, model: bot.config.model, tools: bot.config.tools, all_tools: bot.config.all_tools, updated_by: bot.config.updated_by, updated_at: bot.config.updated_at } : null,
            full_access_here: fullAccessActive(bot.slug, ws, now),
            high_agency: ha(bot.slug),
          },
          summary: `Read ${bot.name}'s settings`,
        }
      }
      const limit = Math.min(50, Math.max(1, Math.trunc(Number(args.limit) || 20)))
      let wakes: unknown[] = []
      const rid = ha(bot.slug).routine_id
      if (rid != null) {
        try {
          const { listRoutineExecutions } = await import('../routine-runs.js')
          const routine = db.prepare('SELECT * FROM routines WHERE id = ?').get(rid) as RoutineRow | undefined
          if (routine) {
            wakes = listRoutineExecutions(db, routine, limit).map(e => ({
              key: e.key, source: e.source, status: e.status, started_at: e.started_at, ended_at: e.ended_at, reason: e.reason, card: e.objective_id, cost_usd: e.cost_usd,
            }))
          }
        } catch { wakes = [] }
      }
      const cards = db
        .prepare(
          `SELECT id, title, status, ai_review_verdict, pr_url, updated_at FROM objectives
            WHERE workspace = ? AND agent_context = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(ws, bot.slug, limit)
      return { result: { slug: bot.slug, workspace: ws, high_agency_wakes: wakes, cards_worked: cards }, summary: `Read ${bot.name}'s run history in ${ws}` }
    }

    case 'repo_session_start': {
      const ws = requireWorkspace(ctx, fnName, args.workspace)
      const project = str(args, 'project', true)
      const title = str(args, 'title', true).slice(0, 200)
      const description = str(args, 'description', true)
      const known = (db
        .prepare("SELECT DISTINCT project FROM objectives WHERE workspace = ? AND project IS NOT NULL AND project != '' AND deleted_at IS NULL ORDER BY project")
        .all(ws) as { project: string }[]).map(r => r.project)
      // Only a repo this workspace already works in: Full access is one workspace, not every repo on the host.
      if (!SLUG_RE.test(project) || !known.includes(project)) {
        refuse(ctx, fnName, ws, `project "${project.slice(0, 80)}" is not a project of this workspace`,
          `"${project}" is not a project of the ${ws} workspace. Projects here: ${known.join(', ') || '(none yet)'}.`)
      }
      const poolError = botOwnershipRefusal(ctx.agent.slug, ws, project)
      if (poolError) refuse(ctx, fnName, ws, poolError, poolError)
      // A new session must not be pointed at a protected pull request either.
      // Same check, same message as create_objective (protectedPrTextRefusal).
      const textRefusal = protectedPrTextRefusal({ slug: ctx.agent.slug, workspace: ws, ability: fnName, title, description, actorUserId: ctx.userId })
      if (textRefusal) throw new ToolUseError(textRefusal)
      const body = [
        description,
        '',
        `— Repo session started from chat by the bot "${me}" (Full access in ${ws}), acting for ${ctx.username}. It runs in its own git worktree and reports on this card.`,
      ].join('\n')
      const info = db
        .prepare(
          `INSERT INTO objectives (title, description, agent_context, workspace, project, category, depth, assigned_user_id, created_by, type, status, origin, owner_bot, model)
           VALUES (?, ?, ?, ?, ?, 'general', ?, ?, ?, 'task', ?, 'agent_chat', ?, ?)`,
        )
        .run(title, body, ctx.agent.slug, ws, project, depthForParent(db, null), ctx.userId, ctx.userId, getInitialStatus('task'), ownerBotName(ctx.agent), chatCardModel(ctx.agent))
      const cardId = Number(info.lastInsertRowid)
      db.prepare('INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, ?)').run(cardId, ctx.userId, ctx.agent.slug)
      broadcastCard(cardId)
      const started = await host.startCard(cardId, `bot:${ctx.agent.slug}`)
      const row = broadcastCard(cardId)
      used(ctx, fnName, ws, `started a repo session on ${project}: card #${cardId}`, cardId)
      return {
        result: {
          id: cardId,
          project,
          workspace: ws,
          status: row?.status ?? 'queue',
          started: started.ok,
          note: started.ok
            ? `Card #${cardId} is running in its own checkout of ${project}. Check it with card_read; steer it with card_comment.`
            : `Card #${cardId} is filed but did not start: ${started.reason ?? 'unknown reason'}. It is yours; card_restart tries again.`,
        },
        summary: `Started a repo session on ${project}: card #${cardId}`,
        objective_id: cardId,
      }
    }
  }
  throw new ToolUseError(`Unknown tool "${fnName}".`)
}
