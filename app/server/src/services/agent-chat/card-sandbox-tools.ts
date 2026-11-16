// ── A bot's chat can reach its own cards' sandboxes (obj 901027) ──
//
// Operator: "I can't run Playwright from this chat. I have no browser or sandbox
// here, so the card's session does the work" (Operation Kit Dev, in chat). This
// gives a chat bot a family of tools to look inside a card's SANDBOX — not the
// board-level read/write `card_read`/`card_comment` full-access-tools.ts
// already has, but the actual files, logs, transcript and running jail a card's
// own worker session uses — so a bot can AUDIT the work a card it owns is
// doing, mid-run or after.
//
// Gate, checked on every call, re-read from the DB each time:
//   - the bot's agent file (or bot-page config) must list the `card_sandbox`
//     tool — explicit opt-in only, never implied by "all tools"
//     (EXPLICIT_ONLY_TOOLS in tool-names.ts), because sandbox_run executes a
//     shell command;
//   - the bot must be allowed to use the card's WORKSPACE at all
//     (botMayUseWorkspace, obj 900797) and the person CHATTING with the bot
//     must themselves be a member of that workspace, unless they are an
//     install admin (the same "admin bypass" boardUser/requireWorkspace use
//     elsewhere) — a member of workspace A chatting with a bot must not be
//     able to reach that bot's cards in workspace B this way;
//   - the CARD must be one this bot owns (its worker — agent_context — or its
//     owner_bot) OR the bot must have Full access to the card's workspace
//     (bot-full-access.ts). Anything else is refused and logged; a bot can
//     never reach a sibling bot's card this way.
//   - a card carrying a protected pull request is out of reach of every
//     ability here too (protectedCardRefusal, same rule full-access-tools.ts
//     applies), logged to BOTH the Full access audit log and this module's own.
//   - sandbox_run additionally requires the chatting person to be an install
//     admin, matching the "Full access abilities only count while working for
//     an admin" rule (full-access-tools.ts) — a shell in a live sandbox is the
//     most dangerous ability here.
//
// What it never does: it never hands the bot Shared (global) secrets.
// sandbox_run execs with an EMPTY environment plus PATH/HOME/LANG only
// (buildJailSandboxExecArgv, session-jail.ts) — none of the card session's own
// scoped env (GH tokens, workspace secrets, CC_SESSION_TOKEN) is inherited.
// `env -i` alone would not have been enough on its own (obj 901027 security
// review, round 2): the exec also runs as its OWN dedicated uid
// (`SANDBOX_EXEC_USER`, never the jail's PID 1 / worker uid), which is what
// actually stops `cat /proc/1/environ` from printing the worker's real
// `--env-file` secrets straight past the empty-env wrapper — that is a
// uid/kernel check, not something `env -i` touches. The jail network is
// reachable from inside the exec regardless, so the fix for "could this exec
// reach the control plane's own internal API with no credential" lives at the
// OTHER end, in `middleware/internal-api-gate.ts`'s `isSandboxPeer` check: a
// peer trusted only via the jail's CIDR is never treated as on-box authority
// anymore, whatever runs inside the jail.
// Every byte returned to the model — file reads, the log, and command
// output — ALSO goes through the same `redactLive` scrubbing the live-progress
// API already uses for mid-run visibility (services/live-redaction.ts): known
// secret values and well-known credential shapes are replaced with
// `[REDACTED:NAME]` before the model ever sees them. Reading the seat-login
// mount (`~/.codex`, `~/.grok`) is refused outright before the command runs
// (targetsSeatLogin) — redundant defense-in-depth on top of the uid
// separation above, which is the part that holds even against a command that
// dodges the pattern match (base64, quoting, `cd` tricks, …): those files are
// not owned by `SANDBOX_EXEC_USER` either.
//
// Every call — allowed or refused — is one row in `agent_chat_sandbox_audit`.
import { execFile } from 'node:child_process'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../../db/index.js'
import { userHasWorkspace } from '../../middleware/workspace.js'
import { ArtifactError, listArtifacts, readArtifact } from '../live-artifacts.js'
import { redactLive } from '../live-redaction.js'
import { deriveTranscriptProgress, listProgress } from '../objective-progress.js'
import { buildJailSandboxExecArgv, jailEnabled } from '../session-jail.js'
import { protectedCardRefusal, fullAccessActive } from './bot-full-access.js'
import { botMayUseWorkspace } from './bot-workspaces.js'
import { ownerBotName } from './full-access-tools.js'
import { agentHasTool, ToolUseError, type ToolContext, type ToolOutcome, type ToolSpec } from './tools.js'

/** Fails closed: a read error (or a missing user) is "not an admin". */
export function sandboxActorIsAdmin(userId: number): boolean {
  try {
    const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined
    return row?.role === 'admin'
  } catch {
    return false
  }
}

/** The jail's seat-login mount (obj 901027 security review): never readable through sandbox_run, whatever redaction might otherwise catch. */
export function targetsSeatLogin(command: string): boolean {
  return /\.codex\b|\.grok\b/i.test(command)
}

function obj(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false }
}
function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { type: 'function', function: { name, description, parameters } }
}

const SANDBOX_SPECS: ToolSpec[] = [
  fn('sandbox_list', 'List the cards YOU own (your worker slug or owner_bot) that have a running or recent session sandbox — most recently updated first.',
    obj({ limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20' } })),
  fn('sandbox_list_files', 'List the files in one card\'s sandbox (its objective-memory directory): partial outputs, ARTIFACT.md, anything it wrote. The card must be one you own or have Full access to.',
    obj({ id: { type: 'integer' } }, ['id'])),
  fn('sandbox_read_file', 'Read one file from a card\'s sandbox (redacted; binaries are listed but not served).',
    obj({
      id: { type: 'integer' },
      path: { type: 'string', description: 'File path relative to the card\'s sandbox, from sandbox_list_files' },
      tail_bytes: { type: 'integer', description: 'Read only the last N bytes (e.g. the end of a growing log).' },
    }, ['id', 'path'])),
  fn('sandbox_read_log', 'Read a card\'s progress log and live transcript stage: recent progress events, the latest snapshot, and what the transcript shows the session doing right now.',
    obj({ id: { type: 'integer' }, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Progress events to return. Default 10' } }, ['id'])),
  fn('sandbox_run', 'Run a shell command inside a card\'s LIVE sandbox — the same jail its own worker session runs in — and get the output back. Only works while the card is running in a sandboxed (SESSION_ISOLATION=docker) session; never has access to Shared secrets, and output is redacted before it reaches you.',
    obj({ id: { type: 'integer' }, command: { type: 'string', description: 'A shell command, e.g. "ls -la" or "cat package.json"' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 60_000, description: 'Default 20000' } }, ['id', 'command'])),
]

export const CARD_SANDBOX_FNS: ReadonlySet<string> = new Set(SANDBOX_SPECS.map(s => s.function.name))

/** The Full access tool family only shows up while the tool is listed for this bot (obj 900749: explicit opt-in, never implied by "all"). */
export function cardSandboxToolSpecs(ctx: Pick<ToolContext, 'agent'>): ToolSpec[] {
  return agentHasTool(ctx.agent, 'card_sandbox') ? SANDBOX_SPECS : []
}

// ── audit ──

export interface SandboxAuditInput {
  event: 'ability_used' | 'ability_refused'
  slug: string
  workspace?: string | null
  actor_user_id?: number | null
  ability: string
  objective_id?: number | null
  detail?: string | null
}

/** Append one audit row. Never throws: a failed audit write must not turn a refusal into an allow, or the reverse. */
export function writeSandboxAudit(e: SandboxAuditInput): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO agent_chat_sandbox_audit (event, slug, workspace, actor_user_id, ability, objective_id, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.event, e.slug, e.workspace ?? null, e.actor_user_id ?? null, e.ability, e.objective_id ?? null, e.detail ? e.detail.slice(0, 1000) : null)
  } catch (err) {
    console.error('[card-sandbox] audit write failed', err instanceof Error ? err.message : err)
  }
}

export interface SandboxAuditEntry {
  id: number
  event: string
  slug: string
  workspace: string | null
  actor_user_id: number | null
  ability: string
  objective_id: number | null
  detail: string | null
  created_at: string
}

/** Newest first, one bot's rows. For the bot settings page / future audit view. */
export function listSandboxAudit(slug: string, limit = 50): SandboxAuditEntry[] {
  const n = Math.min(200, Math.max(1, Math.trunc(limit)))
  return getDb().prepare('SELECT * FROM agent_chat_sandbox_audit WHERE slug = ? ORDER BY id DESC LIMIT ?').all(slug, n) as SandboxAuditEntry[]
}

// ── the gate every ability passes ──

interface CardRow extends Objective { deleted_at?: string | null }

function botLabel(ctx: Pick<ToolContext, 'agent'>): string {
  return ctx.agent.name || ctx.agent.slug
}

/**
 * Does this bot's sandbox reach extend to this card? Three conditions, ALL
 * required: the bot may use the card's workspace at all; the person chatting
 * is a member of that workspace (or an install admin); and the bot owns the
 * card or has Full access to its workspace. Missing any one is a refusal —
 * this is the fix for the obj 901027 security review's #1: a member of
 * workspace A chatting with a bot must not reach that bot's cards in
 * workspace B just because the bot owns them.
 */
export function sandboxCardAccess(ctx: Pick<ToolContext, 'agent' | 'now' | 'userId'>, card: Pick<CardRow, 'agent_context' | 'workspace'> & { owner_bot?: string | null }): boolean {
  if (!card.workspace) return false
  if (!botMayUseWorkspace(ctx.agent.slug, card.workspace)) return false
  const admin = sandboxActorIsAdmin(ctx.userId)
  if (!admin && !userHasWorkspace(ctx.userId, card.workspace)) return false
  // obj 901027 security review, point C: Full access alone is not enough — it
  // widens a bot's reach to EVERY card in the workspace, so (same rule
  // full-access-tools.ts's requireWorkspace/requireCard apply to every other
  // Full-access ability) it only counts while the chatting person is an
  // install admin. A non-admin workspace member chatting with a Full-access
  // bot must stay limited to cards the bot itself owns.
  const now = ctx.now?.() ?? new Date()
  if (admin && fullAccessActive(ctx.agent.slug, card.workspace, now)) return true
  if (card.agent_context === ctx.agent.slug) return true
  const owner = ownerBotName(ctx.agent)
  return !!owner && card.owner_bot === owner
}

/**
 * A card this bot's sandbox tools may reach, or a logged refusal. Same answer
 * for "missing" and "not reachable": no existence oracle. `requireAdmin`
 * (sandbox_run only) additionally requires the chatting person to be an
 * install admin, matching the Full access "only while working for an admin"
 * rule — a live shell is the one ability here that can do real damage.
 */
function requireSandboxCard(ctx: Pick<ToolContext, 'agent' | 'now' | 'userId'>, ability: string, idRaw: unknown, opts: { requireAdmin?: boolean } = {}): CardRow {
  const id = Math.trunc(Number(idRaw))
  if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a card number.')
  const row = getDb().prepare('SELECT * FROM objectives WHERE id = ? AND deleted_at IS NULL').get(id) as CardRow | undefined
  if (!row || !sandboxCardAccess(ctx, row)) {
    writeSandboxAudit({
      event: 'ability_refused', slug: ctx.agent.slug, workspace: row?.workspace ?? null, actor_user_id: ctx.userId, ability, objective_id: id,
      detail: row ? 'bot does not own this card, has no Full access to its workspace, or the chatting person is not a member of it' : 'card not found',
    })
    throw new ToolUseError(`Card #${id} is not a sandbox ${botLabel(ctx)} may reach. It must own the card (be its worker or owner_bot) or have Full access to its workspace, and you must be a member of that workspace.`)
  }
  if (opts.requireAdmin && !sandboxActorIsAdmin(ctx.userId)) {
    writeSandboxAudit({
      event: 'ability_refused', slug: ctx.agent.slug, workspace: row.workspace, actor_user_id: ctx.userId, ability, objective_id: id,
      detail: 'sandbox_run requires the person chatting with the bot to be an install admin',
    })
    throw new ToolUseError(`sandbox_run only runs for an install admin chatting with ${botLabel(ctx)} — the same rule Full access abilities follow. Refused and logged.`)
  }
  const refusal = protectedCardRefusal({ slug: ctx.agent.slug, workspace: row.workspace, ability, card: row, actorUserId: ctx.userId })
  if (refusal) {
    writeSandboxAudit({ event: 'ability_refused', slug: ctx.agent.slug, workspace: row.workspace, actor_user_id: ctx.userId, ability, objective_id: id, detail: refusal })
    throw new ToolUseError(refusal)
  }
  return row
}

function used(ctx: Pick<ToolContext, 'agent' | 'userId'>, ability: string, workspace: string, objectiveId: number, detail: string): void {
  writeSandboxAudit({ event: 'ability_used', slug: ctx.agent.slug, workspace, actor_user_id: ctx.userId, ability, objective_id: objectiveId, detail })
}

function str(args: Record<string, unknown>, key: string, required = false): string {
  const v = args[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (required) throw new ToolUseError(`"${key}" is required.`)
  return ''
}

// ── sandbox_run ──

export interface SandboxRunResult { code: number; stdout: string; stderr: string }
/** Injectable so tests never need a real docker daemon. */
export type SandboxRunner = (objectiveId: number, command: string, timeoutMs: number) => Promise<SandboxRunResult>

/**
 * `docker exec` into the card's own live jail — the same sandbox its worker
 * session runs in — but with an EMPTY environment (`buildJailSandboxExecArgv`)
 * and an in-jail `timeout` wrapping the command itself, not just the `docker
 * exec` CLI. Fails closed off a jail-mode install. The Node-side `timeout`
 * option is kept too, as a belt-and-braces bound on the CLI call.
 */
export const dockerSandboxRunner: SandboxRunner = (objectiveId, command, timeoutMs) =>
  new Promise(resolve => {
    execFile('docker', buildJailSandboxExecArgv(objectiveId, command, timeoutMs), { timeout: timeoutMs + 10_000, maxBuffer: 2_000_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })

// ── dispatch ──

export async function runCardSandboxTool(
  ctx: ToolContext,
  fnName: string,
  args: Record<string, unknown>,
  runner: SandboxRunner = dockerSandboxRunner,
): Promise<ToolOutcome> {
  if (!CARD_SANDBOX_FNS.has(fnName)) throw new ToolUseError(`Unknown tool "${fnName}".`)
  if (!agentHasTool(ctx.agent, 'card_sandbox')) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)
  const db = getDb()

  if (fnName === 'sandbox_list') {
    const limit = Math.min(50, Math.max(1, Math.trunc(Number(args.limit) || 20)))
    const owner = ownerBotName(ctx.agent)
    const admin = sandboxActorIsAdmin(ctx.userId)
    // Overfetch, then scope to workspaces the bot may use AND the chatting
    // person is a member of (or admin) — the same obj 901027 review fix as
    // sandboxCardAccess, applied here because this query spans every
    // workspace the bot owns cards in, not one card at a time.
    const rows = db
      .prepare(
        `SELECT id, title, status, workspace, session_id, updated_at FROM objectives
          WHERE deleted_at IS NULL AND (agent_context = ? OR (owner_bot IS NOT NULL AND owner_bot = ?))
          ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(ctx.agent.slug, owner, Math.min(200, limit * 5)) as { id: number; title: string; status: string; workspace: string; session_id: string | null; updated_at: string }[]
    const scoped = rows.filter(r => botMayUseWorkspace(ctx.agent.slug, r.workspace) && (admin || userHasWorkspace(ctx.userId, r.workspace)))
    const cards = scoped.slice(0, limit).map(r => ({
      id: r.id, title: r.title, status: r.status, workspace: r.workspace, updated_at: r.updated_at,
      running: !!r.session_id && ['working', 'ai_review', 'queue'].includes(r.status),
    }))
    writeSandboxAudit({ event: 'ability_used', slug: ctx.agent.slug, workspace: null, actor_user_id: ctx.userId, ability: fnName, objective_id: null, detail: `listed ${cards.length} of ${rows.length} candidate card(s)` })
    return { result: { cards }, summary: `Listed ${cards.length} of your card sandboxes` }
  }

  if (fnName === 'sandbox_list_files') {
    const card = requireSandboxCard(ctx, fnName, args.id)
    const { entries, truncated } = listArtifacts(card.id)
    used(ctx, fnName, card.workspace, card.id, `listed ${entries.length} file(s)`)
    return { result: { id: card.id, entries, truncated }, summary: `Listed ${entries.length} file(s) in card #${card.id}'s sandbox`, objective_id: card.id }
  }

  if (fnName === 'sandbox_read_file') {
    const card = requireSandboxCard(ctx, fnName, args.id)
    try {
      const out = readArtifact(card.id, args.path, { tailBytes: Number(args.tail_bytes) || undefined })
      used(ctx, fnName, card.workspace, card.id, `read ${out.path}`)
      return { result: out, summary: `Read ${out.path} from card #${card.id}'s sandbox`, objective_id: card.id }
    } catch (err) {
      if (err instanceof ArtifactError) {
        // obj 901027 security review, minor point: a path-traversal or
        // NOTES.md-masking refusal from readArtifact is an ability refusal
        // just like any other gate failure here, and must leave the same
        // audit trail.
        writeSandboxAudit({ event: 'ability_refused', slug: ctx.agent.slug, workspace: card.workspace, actor_user_id: ctx.userId, ability: fnName, objective_id: card.id, detail: err.message })
        throw new ToolUseError(err.message)
      }
      throw err
    }
  }

  if (fnName === 'sandbox_read_log') {
    const card = requireSandboxCard(ctx, fnName, args.id)
    const limit = Math.min(50, Math.max(1, Math.trunc(Number(args.limit) || 10)))
    const page = listProgress(db, card.id, { limit })
    const transcript = deriveTranscriptProgress(card.session_id ?? null, {})
    used(ctx, fnName, card.workspace, card.id, `read log (${page.events.length} event(s))`)
    return {
      result: { id: card.id, status: card.status, latest: page.events[0] ?? null, events: page.events, total_events: page.total, transcript },
      summary: `Read card #${card.id}'s log (${page.events.length} event(s))`,
      objective_id: card.id,
    }
  }

  // sandbox_run
  const card = requireSandboxCard(ctx, fnName, args.id, { requireAdmin: true })
  if (!jailEnabled()) {
    writeSandboxAudit({ event: 'ability_refused', slug: ctx.agent.slug, workspace: card.workspace, actor_user_id: ctx.userId, ability: fnName, objective_id: card.id, detail: 'SESSION_ISOLATION is not docker on this install' })
    throw new ToolUseError('sandbox_run needs a sandboxed session (SESSION_ISOLATION=docker). This install runs sessions directly in the shared app container, so there is no separate sandbox to exec into safely — refused.')
  }
  const command = str(args, 'command', true)
  if (targetsSeatLogin(command)) {
    writeSandboxAudit({ event: 'ability_refused', slug: ctx.agent.slug, workspace: card.workspace, actor_user_id: ctx.userId, ability: fnName, objective_id: card.id, detail: 'command referenced the jail\'s seat-login mount (~/.codex or ~/.grok)' })
    throw new ToolUseError('Refused: that command reaches the jail\'s seat-login mount (~/.codex or ~/.grok), which sandbox_run never reads. This refusal was logged.')
  }
  const timeoutMs = Math.min(60_000, Math.max(1000, Math.trunc(Number(args.timeout_ms)) || 20_000))
  const r = await runner(card.id, command, timeoutMs)
  const stdout = redactLive(r.stdout).text.slice(0, 20_000)
  const stderr = redactLive(r.stderr).text.slice(0, 4000)
  used(ctx, fnName, card.workspace, card.id, `ran "${redactLive(command).text.slice(0, 200)}" (exit ${r.code})`)
  return {
    result: { id: card.id, exit_code: r.code, stdout, stderr },
    summary: `Ran a command in card #${card.id}'s sandbox (exit ${r.code})`,
    objective_id: card.id,
  }
}
