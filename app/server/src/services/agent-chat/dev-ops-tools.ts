// ── Operation Kit Dev operator tools in chat (obj 901424) ──
//
// The owner approved (2026-11-18) a set of operator powers for ONE bot,
// Operation Kit Dev, behind ONE admin switch (services/dev-ops/switch.ts, on by
// default for Dev, off-able on the bot's settings panel):
//
// | tool               | does                                                             |
// |--------------------|------------------------------------------------------------------|
// | dev_merge_pr       | squash-merge a Dev card's PR once CI is green (done card / no    |
// |                    | review OK; a behind branch is updated, then merged on green;     |
// |                    | waiting merges on one repo are a queue, one at a time)           |
// | dev_close_card     | mark done a card whose PR the owner merged by hand; cancel /     |
// |                    | close Dev's own cards — no admin sign-off prompt                 |
// | dev_deploy         | the standard update.sh deploy, backup → verify → health →        |
// |                    | automatic rollback                                               |
// | dev_deploy_status  | how the last deploys ended + the real end state (obj 901495):    |
// |                    | live commit, public main, private main, the sync PR; with a card |
// |                    | id, whether that card's PR is merged, its merge sha and checks   |
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
//
// obj 901492: two more tools exist only while an admin has switched on "GitHub
// repo rights" for at least one repo (services/dev-ops/repo-grant.ts, OFF by
// default, listed per repo), on top of the same gate:
//
// | dev_merge_repo_pr  | squash-merge owner/name#N with no card needed (the public sync   |
// |                    | PR included) when it is open, cleanly mergeable and CI is green  |
// | dev_refresh_pr_ci  | update a behind branch and make sure CI really runs on the head  |
//
// Their walls live in services/dev-ops/repo-merge.ts.
import type { Objective } from '@operationkit/shared'
import { getDb } from '../../db/index.js'
import { writeDevOpsAudit, listDevOpsAudit } from '../dev-ops/audit.js'
import { cloudflareAccess, cloudflareDns, cloudflareRun, CF_RUN_COMMANDS, DNS_TYPES, type AccessAction, type DnsAction } from '../dev-ops/cloudflare.js'
import { devCloseCard } from '../dev-ops/close.js'
import { deployStatus, startDevDeploy } from '../dev-ops/deploy.js'
import { readEndState, readMergeFacts, type EndState, type MergeFacts } from '../dev-ops/end-state.js'
import { repoFromPrUrl } from '../ci-green-gate-run.js'
import { resolveMergeGithubAuth } from '../grant-merge-github-auth.js'
import { devMerge, prNumberOf, type DevActor, type DevMergeCard } from '../dev-ops/merge.js'
import { devOpsGate } from '../dev-ops/switch.js'
import { listRepoGrants } from '../dev-ops/repo-grant.js'
import { devRefreshPrCi, devRepoMerge } from '../dev-ops/repo-merge.js'
import { botMayUseWorkspace } from './bot-workspaces.js'
import { getBoardCard, ToolUseError, type ToolContext, type ToolOutcome, type ToolSpec } from './tools.js'

export const DEV_OPS_FNS: ReadonlySet<string> = new Set([
  'dev_merge_pr', 'dev_close_card', 'dev_deploy', 'dev_deploy_status',
  'cloudflare_access', 'cloudflare_dns', 'cloudflare_run', 'dev_ops_audit',
])

/** obj 901492: offered only while at least one repo is granted. Never part of DEV_OPS_FNS's default set. */
export const DEV_REPO_FNS: ReadonlySet<string> = new Set(['dev_merge_repo_pr', 'dev_refresh_pr_ci'])
/** Every operator tool name, for routing and the wake refusal. */
export const DEV_OPS_ALL_FNS: ReadonlySet<string> = new Set([...DEV_OPS_FNS, ...DEV_REPO_FNS])

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }
}

const ID = { type: 'integer', description: 'Card number.' }
const NOTE = { type: 'string', description: 'One line on why (goes on the audit trail).' }

const SPECS: ToolSpec[] = [
  fn('dev_merge_pr',
    'Squash-merge the PR of one of YOUR own cards once CI is green. Works when the card is already done or has no AI review yet; a failed review still refuses. ' +
    'If the branch is behind main it is updated (a merge from main) and merged automatically once CI is green on the new head. ' +
    'Merges on one repo are taken ONE AT A TIME in the order you ask: while one is waiting, the next ones are queued (`queued_behind`, with `queue_position`) and their branches are left alone until they reach the front, so ask for each PR once and do not ask again. ' +
    'Reserved PRs (645) are never merged. Then the card is marked done.',
    { id: ID, note: NOTE }, ['id']),
  fn('dev_close_card',
    'Close a card without the admin sign-off prompt: done when its PR is merged on GitHub (e.g. the owner merged it by hand), or done / cancelled for one of your own cards. Never a Strategy or a reserved PR.',
    { id: ID, status: { type: 'string', enum: ['done', 'cancelled'] }, note: NOTE }, ['id', 'status']),
  fn('dev_deploy',
    'Deploy the newest commit of the code source this server pulls from (main of the origin of its code folder, which can be a synced copy that lags the repo where pull requests merge) to this live server with the standard update flow (update.sh: backup first, then verify.sh and a public health check; automatic rollback to the backup if either fails). The app restarts, so chat drops briefly. Only when the person asks to deploy. ' +
    'The result says what is live before the deploy and whether there is anything new to deploy (`expect_change`). Starting a deploy is not a finished deploy: call dev_deploy_status afterwards.',
    { note: NOTE }),
  fn('dev_deploy_status',
    'Read-only. The real end state, in one call: how the latest deploys ended (each says whether the commit changed; "deploy ran, nothing changed" when it did not — unchanged = nothing new at the code source so NO new code went live), the live commit this server runs (same as GET /api/health), ' +
    'the head of the repo the server updates from (public main), the head of private main, and the open sync pull request between them. `end_state.summary` is the state in plain words (deployed / merged, not deployed). ' +
    'With `id` (a card number) it also reads that card\'s pull request from GitHub: merged or not, the merge commit, the checks. Call it after every merge and after every deploy, before you say done.',
    { id: { type: 'integer', description: "Optional card number: also verify that card's pull request (merged? merge sha, checks)." } }),
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

const REPO = { type: 'string', description: 'The GitHub repo, written owner/name. Only a repo an admin switched on under GitHub repo rights.' }
const PR_NUMBER = { type: 'integer', description: 'Pull request number in that repo.' }

function repoSpecs(repos: string[]): ToolSpec[] {
  const list = repos.join(', ')
  return [
    fn('dev_merge_repo_pr',
      `Squash-merge a pull request by repo and number, with no card needed (granted repos: ${list}). Use it for a PR that is not linked to one of your cards, such as the public "Sync from upstream" PR. ` +
      'Only when the person asks for this merge. It merges only an open, cleanly mergeable PR whose CI is green; a behind branch is updated first and merged once CI is green on the new head. ' +
      'Refused: reserved PRs (645) and anything that carries their content, PRs from forks, a linked card with a failed AI review, and CodeQL high findings outside test files. No admin bypass. It never deploys.',
      { repo: REPO, number: PR_NUMBER, note: NOTE }, ['repo', 'number']),
    fn('dev_refresh_pr_ci',
      `Update a pull request's branch if it is behind and make sure CI really runs on its head (granted repos: ${list}): a cancelled run is restarted and a failed run has its failed jobs re-run (at most 3 attempts). Never merges. Reserved PRs are never touched.`,
      { repo: REPO, number: PR_NUMBER, note: NOTE }, ['repo', 'number']),
  ]
}

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
  const out = SPECS.map(s => ({ ...s, function: { ...s.function } }))
  let repos: string[] = []
  try { repos = listRepoGrants(ctx.agent.slug).map(g => g.repo) } catch { repos = [] }
  if (repos.length) out.push(...repoSpecs(repos))
  return out
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
  if (!DEV_OPS_ALL_FNS.has(fnName)) throw new ToolUseError(`Unknown tool "${fnName}".`)
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
    if (DEV_REPO_FNS.has(fnName)) {
      // The grant, the reserved list and every other wall are checked (and audited) inside.
      const target = { repo: args.repo, number: args.number, workspace: botMayUseWorkspace(ctx.agent.slug, ctx.workspace) ? ctx.workspace : null }
      const r = fnName === 'dev_merge_repo_pr' ? await devRepoMerge(target, actor) : await devRefreshPrCi(target, actor)
      const what = fnName === 'dev_merge_repo_pr' ? 'merge' : 'refresh CI on'
      return { result: r, summary: r.ok ? r.message : `Did not ${what} ${r.repo ?? String(args.repo)}#${r.pr_number ?? String(args.number)}: ${r.message}`, ...(r.objective_id ? { objective_id: r.objective_id } : {}) }
    }
    return await runAllowed(fnName, args, actor, cardCall, ctx.workspace ?? null)
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
  workspace: string | null,
): Promise<ToolOutcome> {
  const endState = async (): Promise<EndState | null> => {
    try {
      return await readEndState({ workspace, userId: actor.userId, botSlug: actor.botSlug })
    } catch {
      return null
    }
  }
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
      // What is live now, read BEFORE the deploy, so the result can say whether there is anything to ship.
      const before = await endState()
      const r = await startDevDeploy(actor, str(args.note))
      const nothingNew = before?.live_matches_public_main === true
      const expect_change = before?.live_matches_public_main == null ? null : !nothingNew
      const heads = !r.ok ? '' : nothingNew
        ? ` Heads-up: this deploy is expected to change nothing. ${before!.summary}`
        : before?.summary ? ` Before: ${before.summary}` : ''
      const result = {
        ...r, message: `${r.message}${heads}`, expect_change,
        before: before ? { live_commit: before.live_commit, public_main: before.public_main, private_main: before.private_main, sync_pr: before.sync_pr, summary: before.summary } : null,
      }
      return {
        result,
        summary: r.ok
          ? `Deploy #${r.deploy_id} started (update.sh with backup, verify, health, auto-rollback)${nothingNew ? '; expected to change nothing: the live commit is already the head of the repo the server updates from' : ''}`
          : `Did not deploy: ${r.message}`,
      }
    }
    case 'dev_deploy_status': {
      const rows = deployStatus(3)
      let pr: MergeFacts | { error: string } | undefined
      let cardId: number | undefined
      if (args.id != null) {
        const id = Number(args.id)
        if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a card number.')
        cardId = id
        const card = cardCall('deploy_status', id)
        const repo = repoFromPrUrl(card.pr_url)
        const n = prNumberOf(card)
        if (!repo || !n) {
          pr = { error: `Card #${id} has no pull request on GitHub.` }
        } else {
          let exec = null
          try { exec = resolveMergeGithubAuth({ workspace: card.workspace, grantorUserId: actor.userId, agent: actor.botSlug })?.exec ?? null } catch { exec = null }
          if (!exec) pr = { error: 'The server has no GitHub credential, so the pull request was not read.' }
          else {
            try { pr = await readMergeFacts(exec, repo, n) } catch (err) { pr = { error: `Could not read PR #${n} on ${repo}: ${(err as Error).message.split('\n')[0].slice(0, 200)}` } }
          }
        }
      }
      const end_state = await endState()
      writeDevOpsAudit({ bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action: 'deploy_status', outcome: 'allowed', code: 'read', ...(cardId ? { objective_id: cardId, target: `card #${cardId}` } : {}), detail: end_state?.summary ?? null })
      const last = rows[0]
      const lines = [
        last ? `Deploy #${last.id}: ${last.outcome}` : 'No deploys from chat yet.',
        end_state ? end_state.summary : 'The end state could not be read.',
        pr ? ('summary' in pr ? pr.summary : pr.error) : '',
      ].filter(Boolean)
      return { result: { deploys: rows, end_state, ...(pr ? { pr } : {}) }, summary: lines.join(' '), ...(cardId ? { objective_id: cardId } : {}) }
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
