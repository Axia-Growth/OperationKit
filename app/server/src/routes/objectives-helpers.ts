/**
 * Shared objective access/mapping helpers — extracted from objectives.ts
 * (behavior frozen). Used by CRUD and the remaining facade routes.
 */
import { botSlugPassesAgentPool } from '../services/agent-chat/bot-workspaces.js'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getWorkspace } from '../services/workspaces.js'
import { resolveAvailable } from '../services/resource-assignments.js'
import { DEFAULT_AGENT_CONTEXT, cardOwner, type NeedsSecretItem, type Objective } from '@operationkit/shared'
import { listBots, registryKey, type BotDefinition } from '../services/bots/bot-registry.js'
import { loadChatAgents, builtinsEnabled } from '../services/agent-chat/agent-defs.js'
import { allBotConfigs, applyBotConfig } from '../services/agent-chat/bot-config.js'

/**
 * Lightweight card projection for the board LIST (obj 700512). This is EVERY
 * objectives column EXCEPT the six heavy TEXT fields the board/cards never read:
 * description, last_session_summary, approved_plan, ai_review_findings,
 * acceptance_criteria, transcript_path. Those (avg ~3.3KB description alone)
 * ballooned the list to 15MB / 2125 rows; the detail views fetch them on demand
 * via GET /:id. Keeping every OTHER scalar/flag means no board logic regresses —
 * we only drop text the card doesn't render. mapObjective still runs over these
 * rows; acceptance_criteria simply resolves to null (the column is absent).
 */
/** Raw column names in the lightweight LIST projection (no table alias). */
const LIST_COLUMNS_ARRAY = [
  'id', 'title', 'status', 'agent_context', 'assigned_user_id', 'session_id',
  'created_at', 'updated_at', 'workspace', 'category', 'parent_id', 'depth', 'project',
  // project_id = board Project FK (DISTINCT from project = repo-link above)
  'project_id',
  'session_count', 'total_cost_usd', 'total_tokens', 'has_blockers', 'task_count',
  'tasks_passed', 'create_pr', 'branch_name', 'pr_url', 'pr_number', 'completion_goal',
  'workflow_hint', 'effort', 'created_by', 'type', 'plan_approved_at', 'planning_session_id',
  'ai_review_verdict', 'ai_review_session_id', 'skip_ai_review', 'ai_review_iteration',
  'test_cred_slug', 'model', 'routine_id', 'delegate_mode', 'job_disposition',
  'job_review_note', 'source_job_id', 'scope_flags', 'reconcile_sig', 'is_strategy',
  'rejected_tree_sha', 'not_mergeable', 'trust_stage', 'origin', 'strategy_id',
  'last_activity_at', 'ran_on_fallback', 'fallback_detected_at', 'ran_model',
  // obj 714090: agent-key attribution so the card chip can name the bot.
  'agent_key_id', 'agent_key_label',
  // obj 900270: owning Grok bot (null = unowned) — the card chip shows it.
  'owner_bot',
  // obj 900372: stall watchdog flag + reason + restart counter (stalled = flag set while working).
  'stalled_at', 'stall_reason', 'stall_restarts',
  // obj 900625: queue auto-start state (request flag, hold, dependency, launch stamp, skip note).
  'queued_at', 'auto_start_requested_at', 'queue_hold', 'blocked_by', 'autostarted_at', 'auto_start_note',
]

/**
 * Lightweight card projection for the board LIST (obj 700512). This is EVERY
 * objectives column EXCEPT the six heavy TEXT fields the board/cards never read:
 * description, last_session_summary, approved_plan, ai_review_findings,
 * acceptance_criteria, transcript_path. Those (avg ~3.3KB description alone)
 * ballooned the list to 15MB / 2125 rows; the detail views fetch them on demand
 * via GET /:id. Keeping every OTHER scalar/flag means no board logic regresses —
 * we only drop text the card doesn't render. mapObjective still runs over these
 * rows; acceptance_criteria simply resolves to null (the column is absent).
 *
 * Backward-compatible form — no table alias. Use LIST_SELECT + LIST_FROM when
 * you need the LEFT JOIN on projects (project_name / project_color).
 */
export const LIST_COLUMNS = LIST_COLUMNS_ARRAY.join(', ')

/**
 * SELECT list for the board LIST query with a LEFT JOIN on projects.
 * Each objectives column is prefixed `o.` to avoid ambiguity, plus
 * `p.name AS project_name` and `p.color AS project_color` from the join.
 * Use with LIST_FROM below.
 */
export const LIST_SELECT = `${LIST_COLUMNS_ARRAY.map(c => `o.${c}`).join(', ')}, p.name AS project_name, p.color AS project_color`

/**
 * FROM clause for the board LIST query that resolves project_name / project_color.
 * Combine with LIST_SELECT and WHERE predicates prefixed with `o.`.
 */
export const LIST_FROM = 'objectives o LEFT JOIN projects p ON p.id = o.project_id'

/**
 * Read-access gate for a single objective, mirroring the LIST visibility rules
 * (obj 700512 GET /:id). Admins see all; a member sees an objective if their
 * membership for that workspace is 'all'-visibility, or they own it. Kept aligned
 * with the list query so detail fetches never leak across workspaces (obj 1001/700082).
 */
export function canReadObjective(req: AuthRequest, objective: Objective): boolean {
  const user = req.user!
  if (user.role === 'admin') return true
  const membership = getUserWorkspaces(user.id).find(m => m.workspace === objective.workspace)
  if (!membership) return false
  if (membership.objective_visibility === 'all') return true
  return userOwnsObjective(user.id, objective)
}

/**
 * Maps a raw SQLite objectives row to the typed Objective contract. SQLite
 * returns 0/1 for INTEGER-typed boolean columns and stores JSON columns as
 * TEXT — both need explicit normalization before the row leaves the server.
 *
 * Touches only the columns whose stored shape differs from the wire shape:
 * - boolean: has_blockers, create_pr, skip_ai_review (0/1 → boolean)
 * - JSON:    acceptance_criteria (TEXT → AcceptanceCriterion[] | null)
 * - hydrate: assigned_user_ids from the objective_assignees join table, and the
 *            matching assigned_usernames from users.username (obj 700850)
 *
 * `userMap` (id → username) is an OPTIONAL preloaded lookup. The board LIST maps
 * hundreds of rows, so it builds the map ONCE (buildUsernameMap) and passes it in
 * here — resolving names is then a pure in-memory lookup with zero per-card
 * queries (no N+1). Single-object / short-list callers may omit it, in which case
 * we resolve the handful of ids with one targeted `IN (...)` query.
 */
export function buildUsernameMap(): Map<number, string> {
  const rows = getDb().prepare('SELECT id, username FROM users').all() as { id: number; username: string }[]
  return new Map(rows.map(u => [u.id, u.username]))
}

export function resolveUsernames(assignedIds: number[], userMap?: Map<number, string>): string[] {
  if (assignedIds.length === 0) return []
  const lookup = userMap ?? (() => {
    const placeholders = assignedIds.map(() => '?').join(',')
    const rows = getDb()
      .prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`)
      .all(...assignedIds) as { id: number; username: string }[]
    return new Map(rows.map(u => [u.id, u.username]))
  })()
  // Preserve assignedIds order (primary first); drop ids with no matching user.
  return assignedIds
    .map(id => lookup.get(id))
    .filter((name): name is string => typeof name === 'string')
}

/** obj 718944: tolerant parse of objectives.needs_secret (names + reasons only). */
export function parseNeedsSecret(raw: unknown): NeedsSecretItem[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(x => x && typeof x.name === 'string') : []
  } catch {
    return []
  }
}

// ── Board ownership (obj 900869) ─────────────────────────────────────────────
// The bot list is settings-backed; mapObjective runs once per card on a board
// read, so the registry is read at most once per BOT_CACHE_MS, not per row.
const BOT_CACHE_MS = 30_000
let botCache: { at: number; bots: BotDefinition[] } | null = null

function cachedBots(): BotDefinition[] {
  const now = Date.now()
  if (!botCache || now - botCache.at > BOT_CACHE_MS) {
    let bots: BotDefinition[]
    try { bots = listBots(getDb()) } catch { bots = listBots() }
    botCache = { at: now, bots }
  }
  return botCache.bots
}

/**
 * obj 900947: installed chat bots (slug → display name). A chat bot that was
 * never added to the bot registry still owns the cards filed with
 * agent_context = its slug (the High Agency rule), so the board resolves it to
 * the bot's display name — the same id its Work tab's "Open on board" link uses
 * (bot-work.ts botIdentity: registry id, else the bot's name).
 */
let chatBotCache: { at: number; bots: Array<{ slug: string; name: string }> } | null = null

function cachedChatBots(): Array<{ slug: string; name: string }> {
  const now = Date.now()
  if (!chatBotCache || now - chatBotCache.at > BOT_CACHE_MS) {
    let bots: Array<{ slug: string; name: string }> = []
    try {
      const loaded = loadChatAgents({ env: process.env, includeDemo: false, includeBuiltins: builtinsEnabled(process.env) })
      let configs: ReturnType<typeof allBotConfigs> = new Map()
      try { configs = allBotConfigs() } catch { /* no table yet → every bot is its file */ }
      bots = loaded.agents.map(a => applyBotConfig(a, configs.get(a.slug))).map(a => ({ slug: a.slug, name: a.name }))
    } catch {
      bots = []
    }
    chatBotCache = { at: now, bots }
  }
  return chatBotCache.bots
}

function matchChatBot(raw: string | null | undefined): { slug: string; name: string } | null {
  const key = raw ? registryKey(raw) : ''
  if (!key) return null
  return cachedChatBots().find(c => registryKey(c.slug) === key || registryKey(c.name) === key) ?? null
}

/**
 * obj 901030: does ANY chat bot actually installed on THIS board answer to
 * `b`'s name, alias or agent slug? Registry membership alone (BUILT_IN_BOTS or
 * settings.bot_registry) is a generic identity shipped with the product — e.g.
 * "Operation Kit" ships as BUILT_IN_BOTS[0] on every install whether or not that
 * install has actually configured a chat bot for it. An install that never
 * loaded a matching agent file has nothing here that can vouch for the name.
 */
function hasInstalledChatAgent(b: BotDefinition): boolean {
  const chats = cachedChatBots()
  if (chats.length === 0) return false
  const keys = new Set([registryKey(b.id), registryKey(b.name), ...b.aliases.map(registryKey), ...b.agent_slugs.map(registryKey)])
  return chats.some(c => keys.has(registryKey(c.slug)) || keys.has(registryKey(c.name)))
}

/** Test seam: forget the cached registry (a test that edits settings.bot_registry). */
export function clearBotOwnerCache(): void {
  botCache = null
  chatBotCache = null
}

export interface ResolvedBotOwner {
  id: string
  name: string
  /** obj 901030: true when the card arrived through a shared agent API key
   *  (`agent_key_label` is set) AND no chat bot installed on THIS board
   *  answers to the resolved name/alias/agent_slug (`hasInstalledChatAgent`).
   *  A registry hit (BUILT_IN_BOTS or settings.bot_registry) is NOT enough on
   *  its own — the registry is shipped product data, present whether or not an
   *  install actually configured that bot (e.g. "Operation Kit" is
   *  BUILT_IN_BOTS[0] everywhere). A bot this board actually has a chat agent
   *  for is never external, API key or not — that is the normal shape of a
   *  headless Grok bot (obj 900323) answering through the shared key. */
  external: boolean
}

/**
 * The registry bot behind a card: its explicit `owner_bot`, else the bot that
 * owns the card's `agent_context` chat slug (a High Agency wake card is filed
 * with agent_context = the bot's slug). Null when neither names a known bot. An
 * `owner_bot` the registry does not know resolves to an installed chat bot when
 * it names one (obj 900947), else is still shown as itself — it was
 * written by someone, and hiding it would hide who filed the card. `external`
 * (obj 901030) flags the case nothing on this board can actually vouch for:
 * no installed chat agent answers to the name AND the card arrived via a
 * shared agent API key, so it is styled as an outside owner rather than
 * silently passing for one of this install's own bots.
 */
export function resolveBotOwner(row: Pick<Objective, 'owner_bot' | 'agent_context' | 'agent_key_label'>): ResolvedBotOwner | null {
  const bots = cachedBots()
  const match = (raw: string | null | undefined, slugs: boolean): BotDefinition | null => {
    const key = raw ? registryKey(raw) : ''
    if (!key) return null
    for (const b of bots) {
      if (registryKey(b.id) === key || registryKey(b.name) === key) return b
      if (b.aliases.some(a => registryKey(a) === key)) return b
      if (slugs && b.agent_slugs.some(sl => registryKey(sl) === key)) return b
    }
    return null
  }
  const arrivedViaApiKey = (row.agent_key_label ?? '').trim().length > 0
  const externalFor = (b: BotDefinition): boolean => arrivedViaApiKey && !hasInstalledChatAgent(b)
  const explicit = (row.owner_bot ?? '').trim()
  if (explicit) {
    const b = match(explicit, true)
    if (b) return { id: b.id, name: b.name, external: externalFor(b) }
    // obj 900947: a chat bot's display name → its registry entry (by its slug), else the bot itself.
    const chat = matchChatBot(explicit)
    if (chat) {
      const reg = match(chat.slug, true)
      return reg ? { id: reg.id, name: reg.name, external: false } : { id: chat.name, name: chat.name, external: false }
    }
    return { id: explicit, name: explicit, external: true }
  }
  // 'general' is the column DEFAULT for agent_context (every card filed without
  // a persona carries it), and the built-in "General" bot also lists it as its
  // chat slug. Reading it as a bot would make every unowned card on the board
  // look bot-owned, so the default slug never implies a bot — a General card
  // must say so through owner_bot (a claim or a bot filer sets it).
  if (registryKey(row.agent_context ?? '') === registryKey(DEFAULT_AGENT_CONTEXT)) return null
  const viaSlug = match(row.agent_context, true)
  if (viaSlug) return { id: viaSlug.id, name: viaSlug.name, external: externalFor(viaSlug) }
  // obj 900947: an installed chat bot outside the registry still owns its slug's cards.
  const chat = matchChatBot(row.agent_context)
  return chat ? { id: chat.name, name: chat.name, external: false } : null
}

export function mapObjective(row: Objective, userMap?: Map<number, string>): Objective {
  const r = row as unknown as Record<string, unknown>
  let acceptance: unknown = null
  const raw = r.acceptance_criteria
  if (typeof raw === 'string' && raw.length > 0) {
    try { acceptance = JSON.parse(raw) } catch { acceptance = null }
  }
  const ids = getDb()
    .prepare('SELECT user_id FROM objective_assignees WHERE objective_id = ? ORDER BY user_id')
    .all(row.id) as { user_id: number }[]
  const assignedIds = ids.map(x => x.user_id)
  // Ensure the primary assignee is present in the list (defensive — backfill
  // covers this, but a manual DB poke or a row with assigned_user_id but no
  // join row would otherwise vanish from the multi-assign view).
  if (row.assigned_user_id != null && !assignedIds.includes(row.assigned_user_id)) {
    assignedIds.unshift(row.assigned_user_id)
  }
  const assignedUsernames = resolveUsernames(assignedIds, userMap)
  const createdBy = row.created_by != null ? (resolveUsernames([row.created_by], userMap)[0] ?? null) : null
  const bot = resolveBotOwner(row)
  const keyLabel = (row.agent_key_label ?? '').trim()
  const botOwnerDetail = bot?.external
    ? (keyLabel ? `Filed by an outside assistant via API key ${keyLabel}.` : `Filed by an outside assistant — ${bot.name} is not a bot on this install.`)
    : null
  const currentOwner = cardOwner({
    status: row.status,
    session_id: row.session_id,
    bot_owner: bot?.id ?? null,
    bot_owner_name: bot?.name ?? null,
    bot_owner_is_external: bot?.external ?? false,
    bot_owner_detail: botOwnerDetail,
    assigned_usernames: assignedUsernames,
    created_by_username: createdBy,
  })
  // obj 901075: the needs_browser column is dead (every worker gets the
  // browser); keep it out of every response so nobody reads it as a switch.
  const { needs_browser: _deadNeedsBrowser, ...rowOut } = row as typeof row & { needs_browser?: unknown }
  void _deadNeedsBrowser
  return {
    ...rowOut,
    bot_owner: bot?.id ?? null,
    bot_owner_name: bot?.name ?? null,
    bot_owner_is_external: bot?.external ?? false,
    bot_owner_detail: botOwnerDetail,
    created_by_username: createdBy,
    current_owner: currentOwner,
    needs_secret: parseNeedsSecret(r.needs_secret),
    has_blockers: !!r.has_blockers,
    create_pr: !!r.create_pr,
    delegate_mode: !!r.delegate_mode,
    is_strategy: !!r.is_strategy,
    terminal_by_human: !!r.terminal_by_human,
    skip_ai_review: !!r.skip_ai_review,
    ran_on_fallback: !!r.ran_on_fallback,
    // obj 900372: one-read stall signal for bots. True only while the card is still
    // `working` — a flag left on a card that already moved on is not a stall.
    stalled: !!r.stalled_at && row.status === 'working',
    stalled_at: (r.stalled_at as string | null | undefined) ?? null,
    stall_reason: (r.stall_reason as string | null | undefined) ?? null,
    last_activity_at: (r.last_activity_at as string | null | undefined) ?? null,
    acceptance_criteria: acceptance as Objective['acceptance_criteria'],
    assigned_user_ids: assignedIds,
    assigned_usernames: assignedUsernames,
    // project_name / project_color come from the LEFT JOIN on projects when the
    // query uses LIST_SELECT + LIST_FROM. For queries that SELECT * (GET /:id),
    // these columns are absent from the raw row — keep null rather than undefined
    // so callers see a consistent shape.
    project_name: (r.project_name as string | null | undefined) ?? null,
    project_color: (r.project_color as string | null | undefined) ?? null,
  }
}

/** Replace the join-table rows for an objective with the given set of user ids. */
export function setAssignees(objectiveId: number, userIds: number[]): void {
  const db = getDb()
  const tx = db.transaction((ids: number[]) => {
    db.prepare('DELETE FROM objective_assignees WHERE objective_id = ?').run(objectiveId)
    const insert = db.prepare('INSERT OR IGNORE INTO objective_assignees (objective_id, user_id) VALUES (?, ?)')
    for (const uid of ids) insert.run(objectiveId, uid)
  })
  tx(userIds)
}

/**
 * Normalize the incoming assignee fields to a single canonical list. Callers
 * can send either `assigned_user_ids` (the new multi-assign array) or the
 * legacy `assigned_user_id` shorthand. If both are sent, the array wins.
 * Returns null when the caller didn't touch assignment at all.
 */
export function normalizeAssignees(
  legacy: number | null | undefined,
  multi: number[] | undefined,
): number[] | null {
  if (multi !== undefined) {
    return Array.from(new Set(multi.filter(n => typeof n === 'number' && n > 0)))
  }
  if (legacy !== undefined) {
    return legacy ? [legacy] : []
  }
  return null
}

/**
 * May this caller route work to these people?
 *
 * A card's assignee decides whose identity the session runs as, so "assign" is
 * an impersonation primitive unless it is bounded. A non-admin may only name
 * themselves. An admin may name anyone — routing work is their job — but that
 * grants no credentials: the assignee's connectors stay absent in the spawned
 * session unless the assignee opted that connector in to delegated work
 * (services/connector-guard.ts, services/session-spawn-env.ts isDelegatedCard).
 *
 * Returns null when allowed, or a sentence to put in a 403.
 */
export function checkAssigneesAllowed(
  user: { id: number; role: string },
  requested: number[] | null,
): string | null {
  if (requested === null || requested.length === 0) return null
  if (user.role === 'admin') return null
  const others = requested.filter(id => id !== user.id)
  if (others.length === 0) return null
  return 'You can only assign objectives to yourself'
}

/** Check if a non-admin user owns an objective (created it or is assigned to it) */
export function userOwnsObjective(userId: number, objective: Objective): boolean {
  if (objective.created_by === userId) return true
  if (objective.assigned_user_id === userId) return true
  const row = getDb()
    .prepare('SELECT 1 FROM objective_assignees WHERE objective_id = ? AND user_id = ?')
    .get(objective.id, userId)
  return !!row
}

/**
 * Phase-3 gate: an agent must be in the workspace's default_agent_pool to be
 * assignable to an objective in that workspace. Empty pool (legacy / freshly
 * created workspaces) is treated as "no restriction" so we don't break
 * pre-Phase-3 rows on upgrade. Returns null on pass, error message on fail.
 *
 * obj 900948: a chat bot's slug that an admin has GRANTED this workspace (the
 * per-bot workspace access list, obj 900797) passes. The grant is the explicit
 * admin decision that the bot may work here; without it a High Agency wake could
 * not file or own its own cards (agent_context = its slug). Only an explicit
 * grant counts — an ungranted workspace, or a bot that was never restricted, is
 * still refused by the pool exactly as before, and worker personas are unchanged.
 * The grant replaces the POOL membership only: the project-grain restriction
 * below runs first and applies to a bot like any other agent, and a bot slug
 * that is also a worker persona gets no exception (botSlugPassesAgentPool).
 */
export function checkAgentInWorkspacePool(
  workspace: string,
  agentContext: string,
  project?: string | null,
): string | null {
  // obj-2388: project-grain agent assignments (resource_assignments) COMPLEMENT
  // the workspace pool. If any agent assignment is scoped to this workspace or
  // (workspace, project), availability is restricted to the resolved set; absent
  // such assignments this is a no-op and the legacy workspace-pool gate governs.
  const avail = resolveAvailable('agent', { workspace, project })
  if (avail.restricted && !avail.allowed.includes(agentContext)) {
    return `Agent '${agentContext}' is not assigned to ${project ? `project '${project}'` : `workspace '${workspace}'`} (allowed: ${avail.allowed.join(', ') || 'none'})`
  }

  const ws = getWorkspace(workspace)
  if (!ws) return null // workspace existence is checked elsewhere; pool gate skips
  const pool = ws.default_agent_pool
  if (!pool || pool.length === 0) return null // unconfigured pool = allow any
  if (pool.includes(agentContext)) return null
  if (botSlugPassesAgentPool(agentContext, workspace)) return null
  return `Agent '${agentContext}' is not in workspace '${workspace}' pool (allowed: ${pool.join(', ')})`
}

/**
 * Server-side default for `agent_context` when the caller does not supply one
 * (obj 708817 — the human create form no longer asks for an agent).
 *
 * There is no classifier: the agent-registry lookup on `objective.agent_context`
 * in prompt-builder.ts is the ONLY thing that picks the persona and the working
 * directory, so an absent agent MUST resolve to a concrete, deterministic value.
 * The workspace's own `default_agent_pool[0]` is that value — it gives
 * per-workspace routing (operationkit -> 'cto', a marketing workspace -> 'cmo')
 * with no new logic — falling back to 'general' for a legacy/unconfigured pool.
 *
 * Callers that DO send agent_context keep their exact previous behaviour; this
 * is only consulted for the absent case.
 */
export function defaultAgentForWorkspace(workspace: string): string {
  const ws = getWorkspace(workspace)
  const pool = ws?.default_agent_pool
  if (pool && pool.length > 0) return pool[0]
  return 'general'
}

/** Middleware-style ownership check for member users. Admins always pass. */
export function requireOwnership(req: AuthRequest, objective: Objective): string | null {
  const user = req.user!
  if (user.role === 'admin') return null
  if (!userOwnsObjective(user.id, objective)) {
    return 'You do not have access to this objective'
  }
  return null
}

