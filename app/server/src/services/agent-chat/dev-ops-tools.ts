// ── Operation Kit Dev operator tools in chat (obj 901424) ──
//
// The owner approved (2026-11-18) a set of operator powers for ONE bot,
// Operation Kit Dev, behind ONE admin switch (services/dev-ops/switch.ts, on by
// default for Dev, off-able on the bot's settings panel):
//
// | tool               | does                                                             |
// |--------------------|------------------------------------------------------------------|
// | dev_merge_pr       | squash-merge a Dev card's PR once CI is green (done card / no    |
// |                    | review OK; a behind branch is updated, then merged on green)     |
// | dev_close_card     | mark done a card whose PR the owner merged by hand; cancel /     |
// |                    | close Dev's own cards — no admin sign-off prompt                 |
// | dev_deploy         | the standard update.sh deploy, backup → verify → health →        |
// |                    | automatic rollback                                               |
// | dev_deploy_status  | how the last deploys ended                                       |
// | cloudflare_access  | list / add / remove ONE email in the Access allow list           |
// | cloudflare_dns     | list / upsert / delete a DNS record in the install's zone        |
// | cloudflare_run     | install/cloudflare.sh status | api-bypass | api-bic              |
// | dev_ops_audit      | read the dev-ops audit trail                                     |
//
// Offered only when devOpsGate passes: the bot is operation-kit-dev, the switch
// is on, the person is an admin, and the turn is a live chat (never a card wake
// or a bot-to-bot wake). Every call re-checks the gate; every call — allowed or
// refused — writes a dev_ops_audit row. No tool returns a secret value: the
// Cloudflare token stays in its host file and results are redacted.
// Full access and delegation grants are not consulted.
import type { Objective } from '@operationkit/shared'
import { getDb } from '../../db/index.js'
import { writeDevOpsAudit, listDevOpsAudit } from '../dev-ops/audit.js'
import { cloudflareAccess, cloudflareDns, cloudflareRun, CF_RUN_COMMANDS, DNS_TYPES, type AccessAction, type DnsAction } from '../dev-ops/cloudflare.js'
import { devCloseCard } from '../dev-ops/close.js'
import { deployStatus, startDevDeploy } from '../dev-ops/deploy.js'
import { devMerge, type DevActor, type DevMergeCard } from '../dev-ops/merge.js'
import { devOpsGate } from '../dev-ops/switch.js'
import { botMayUseWorkspace } from './bot-workspaces.js'
import { getBoardCard, ToolUseError, type ToolContext, type ToolOutcome, type ToolSpec } from './tools.js'

export const DEV_OPS_FNS: ReadonlySet<string> = new Set([
  'dev_merge_pr', 'dev_close_card', 'dev_deploy', 'dev_deploy_status',
  'cloudflare_access', 'cloudflare_dns', 'cloudflare_run', 'dev_ops_audit',
])

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }
}

const ID = { type: 'integer', description: 'Card number.' }
const NOTE = { type: 'string', description: 'One line on why (goes on the audit trail).' }

const SPECS: ToolSpec[] = [
  fn('dev_merge_pr',
    'Squash-merge the PR of one of YOUR own cards once CI is green. Works when the card is already done or has no AI review yet; a failed review still refuses. ' +
    'If the branch is behind main it is updated (a merge from main) and merged automatically once CI is green on the new head. Reserved PRs (645) are never merged. Then the card is marked done.',
    { id: ID, note: NOTE }, ['id']),
  fn('dev_close_card',
    'Close a card without the admin sign-off prompt: done when its PR is merged on GitHub (e.g. the owner merged it by hand), or done / cancelled for one of your own cards. Never a Strategy or a reserved PR.',
    { id: ID, status: { type: 'string', enum: ['done', 'cancelled'] }, note: NOTE }, ['id', 'status']),
  fn('dev_deploy',
    'Deploy the latest main to this live server with the standard update flow (update.sh: backup first, then verify.sh and a public health check; automatic rollback to the backup if either fails). The app restarts, so chat drops briefly. Only when the person asks to deploy.',
    { note: NOTE }),
  fn('dev_deploy_status', 'How the latest deploys ended (deployed, rolled back, failed) and what step a running one is on.', {}),
  fn('cloudflare_access',
    'Cloudflare Access allow list of this install: list it, add ONE exact email, or remove ONE email. A domain / wildcard / everyone allow is never added; protected owner addresses are never removed.',
    { action: { type: 'string', enum: ['list', 'add', 'remove'] }, email: { type: 'string', description: 'One exact email address (add / remove).' } }, ['action']),
  fn('cloudflare_dns',
    "DNS records in this install's Cloudflare zone: list, upsert (create or change) or delete one record. Only A, AAAA, CNAME, TXT, MX; never this install's own record.",
    {
      action: { type: 'string', enum: ['list', 'upsert', 'delete'] },
      type: { type: 'string', enum: [...DNS_TYPES] },
      name: { type: 'string', description: 'Full record name, e.g. mail.example.com.' },
      content: { type: 'string', description: 'Record value (IP, host name, or TXT text). For delete, picks one of several records.' },
      proxied: { type: 'boolean', description: 'A / AAAA / CNAME: through Cloudflare (orange cloud). Default false.' },
      ttl: { type: 'integer', description: '1 = automatic (default), else 60-86400 seconds.' },
      priority: { type: 'integer', description: 'MX priority (default 10).' },
    }, ['action']),
  fn('cloudflare_run',
    "Run a reconcile/status step of the install's own Cloudflare setup (install/cloudflare.sh): status, api-bypass (the bot API Access bypass) or api-bic (the narrow browser-integrity exception).",
    { command: { type: 'string', enum: [...CF_RUN_COMMANDS] } }, ['command']),
  fn('dev_ops_audit', 'The latest operator-tool audit rows (every merge, close, deploy and Cloudflare call, allowed or refused).',
    { limit: { type: 'integer', description: 'How many rows (default 20, max 100).' } }),
]

function wake(ctx: ToolContext): boolean {
  return !!(ctx.cardWake || ctx.botWake)
}

/** The dev-ops tools for this turn: only Operation Kit Dev, switch on, an admin, a live chat. */
export function devOpsToolSpecs(ctx: ToolContext): ToolSpec[] {
  try {
    if (devOpsGate({ agentSlug: ctx.agent.slug, userId: ctx.userId, wake: wake(ctx), browserSession: ctx.browserSession === true })) return []
  } catch {
    return []
  }
  return SPECS.map(s => ({ ...s, function: { ...s.function } }))
}

function actorOf(ctx: ToolContext): DevActor {
  return { userId: ctx.userId, username: ctx.username, botSlug: ctx.agent.slug }
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Load a card the person (narrowed to the bot's workspaces) can see, in a workspace the bot may use. */
function visibleCard(ctx: ToolContext, id: number): DevMergeCard & Objective {
  getBoardCard(ctx, id) // throws "not on a board you can see"
  const card = getDb().prepare('SELECT * FROM objectives WHERE id = ? AND deleted_at IS NULL').get(id) as (DevMergeCard & Objective) | undefined
  if (!card) throw new ToolUseError(`Card #${id} is not on a board you can see.`)
  if (!botMayUseWorkspace(ctx.agent.slug, card.workspace)) throw new ToolUseError(`Card #${id} is in a workspace this bot may not use.`)
  return card
}

export async function runDevOpsTool(ctx: ToolContext, fnName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!DEV_OPS_FNS.has(fnName)) throw new ToolUseError(`Unknown tool "${fnName}".`)
  const actor = actorOf(ctx)
  const gate = devOpsGate({ agentSlug: ctx.agent.slug, userId: ctx.userId, wake: wake(ctx), browserSession: ctx.browserSession === true })
  if (gate) {
    writeDevOpsAudit({ bot_slug: ctx.agent.slug, user_id: ctx.userId, username: ctx.username, action: fnName, outcome: 'refused', code: gate.code, detail: gate.error })
    return { result: { ok: false, code: gate.code, error: gate.error }, summary: `Refused: ${gate.error}` }
  }

  const cardCall = (action: string, id: number): (DevMergeCard & Objective) => {
    try {
      return visibleCard(ctx, id)
    } catch (err) {
      writeDevOpsAudit({ bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action, target: `card #${id}`, objective_id: Number.isInteger(id) ? id : null, outcome: 'refused', code: 'not_visible', detail: (err as Error).message })
      ;(err as { devOpsAudited?: boolean }).devOpsAudited = true
      throw err
    }
  }

  try {
    return await runAllowed(fnName, args, actor, cardCall)
  } catch (err) {
    // A bad argument (no id, unknown status / action) is a refusal too: audit it once.
    if (!(err as { devOpsAudited?: boolean }).devOpsAudited) {
      writeDevOpsAudit({ bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action: fnName, outcome: 'refused', code: 'bad_request', detail: (err as Error).message })
    }
    throw err
  }
}

/** Every refusal from the host side or a guard is a result, not a throw; a throw is a bad request. */
async function runAllowed(
  fnName: string,
  args: Record<string, unknown>,
  actor: DevActor,
  cardCall: (action: string, id: number) => DevMergeCard & Objective,
): Promise<ToolOutcome> {
  switch (fnName) {
    case 'dev_merge_pr': {
      const id = Number(args.id)
      if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a card number.')
      const card = cardCall('merge', id)
      const r = await devMerge(card, actor)
      return { result: r, summary: r.ok ? r.message : `Did not merge card #${id}: ${r.message}`, objective_id: id }
    }
    case 'dev_close_card': {
      const id = Number(args.id)
      if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a card number.')
      const status = args.status === 'done' || args.status === 'cancelled' ? args.status : null
      if (!status) throw new ToolUseError('status must be done or cancelled.')
      const card = cardCall(`close_${status}`, id)
      const r = await devCloseCard(card, status, actor, str(args.note))
      return { result: r, summary: r.ok ? r.message : `Did not close card #${id}: ${r.message}`, objective_id: id }
    }
    case 'dev_deploy': {
      const r = await startDevDeploy(actor, str(args.note))
      return { result: r, summary: r.ok ? `Deploy #${r.deploy_id} started (update.sh with backup, verify, health, auto-rollback)` : `Did not deploy: ${r.message}` }
    }
    case 'dev_deploy_status': {
      const rows = deployStatus(3)
      writeDevOpsAudit({ bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action: 'deploy_status', outcome: 'allowed', code: 'read' })
      const last = rows[0]
      return { result: { deploys: rows }, summary: last ? `Deploy #${last.id}: ${last.status}${last.step ? ` (${last.step})` : ''}` : 'No deploys from chat yet' }
    }
    case 'cloudflare_access': {
      const action = (['list', 'add', 'remove'] as const).find(a => a === args.action) as AccessAction | undefined
      if (!action) throw new ToolUseError('action must be list, add or remove.')
      const r = await cloudflareAccess(actor, action, args.email)
      return { result: r, summary: r.ok ? `Cloudflare Access ${action}: ${r.code}` : `Cloudflare Access ${action} refused: ${r.message ?? r.code}` }
    }
    case 'cloudflare_dns': {
      const action = (['list', 'upsert', 'delete'] as const).find(a => a === args.action) as DnsAction | undefined
      if (!action) throw new ToolUseError('action must be list, upsert or delete.')
      const r = await cloudflareDns(actor, {
        action,
        type: str(args.type, 10) || undefined,
        name: str(args.name, 253) || undefined,
        content: typeof args.content === 'string' ? args.content.slice(0, 4096) : undefined,
        proxied: args.proxied === true,
        ttl: args.ttl == null ? undefined : Number(args.ttl),
        priority: args.priority == null ? undefined : Number(args.priority),
      })
      return { result: r, summary: r.ok ? `DNS ${action}: ${r.code}` : `DNS ${action} refused: ${r.message ?? r.code}` }
    }
    case 'cloudflare_run': {
      const r = await cloudflareRun(actor, args.command)
      return { result: r, summary: r.ok ? `cloudflare.sh ${String(args.command)}: done` : `cloudflare.sh ${String(args.command)}: ${r.message ?? r.code}` }
    }
    case 'dev_ops_audit': {
      const n = Math.max(1, Math.min(100, Number(args.limit) || 20))
      writeDevOpsAudit({ bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action: 'audit_read', outcome: 'allowed', code: 'read' })
      return { result: { rows: listDevOpsAudit(n) }, summary: `Read the last ${n} operator audit rows` }
    }
  }
  throw new ToolUseError(`Unknown tool "${fnName}".`)
}
