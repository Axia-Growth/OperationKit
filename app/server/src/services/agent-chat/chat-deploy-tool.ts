// ── "Deploy on your word" — the chat tool (obj 901393) ──
//
// The owner chose option C on decision #34 (card #901383): Operation Kit Dev
// may hot-deploy from chat, but only when the owner asks for it in that chat,
// each time. This is a thin door onto services/chat-deploy.ts, which re-checks
// every gate on the server and writes the audit row:
//
//   chat turn → deploy_on_owner_word {}
//     → runChatDeploy: switch on, live turn, allowed bot, admin, the owner's own
//       browser-typed message in THIS turn asks for a deploy and was not used
//       before, workspace owns the install's repo, live checkout clean and not
//       ahead, something to deploy, no migration, no rebuild, no working cards
//       when the backend restarts → self-deploy.sh (detached, health-gated,
//       auto-rollback), pinned to the commit the owner is shown.
//
// What it is NOT:
//  - Not a Full access tool: Full access never adds it and never stands in for
//    the owner's word (the Full access name pin in bot-full-access.test.ts holds).
//  - Not a grant: delegation grants are not consulted.
//  - A card wake or a bot-to-bot wake never reaches it (runChatTool sends card
//    wakes elsewhere; a bot wake is refused here and in the service).
//
// Offered only when the switch is on, the bot is allowed, the person is an
// admin and the chat's workspace owns the install's repo. That is a convenience:
// every call is re-checked.
import { getDb } from '../../db/index.js'
import { chatDeployOfferable, runChatDeploy } from '../chat-deploy.js'
import { laneThreadId, MAIN_LANE } from './threads.js'
import { ToolUseError, type ToolContext, type ToolOutcome, type ToolSpec } from './tools.js'

export const CHAT_DEPLOY_FN = 'deploy_on_owner_word'
export const CHAT_DEPLOY_FNS: ReadonlySet<string> = new Set([CHAT_DEPLOY_FN])

const SPEC: ToolSpec = {
  type: 'function',
  function: {
    name: CHAT_DEPLOY_FN,
    description:
      'Hot-deploy what is merged to main but not live yet, ONLY because the owner just asked you to deploy in this chat. ' +
      'The server checks the owner\'s own latest message, then refuses if a database migration or a container rebuild is needed, the live checkout is dirty, ' +
      'a deploy is already running, nothing is waiting, or cards are working and the server would restart. ' +
      'On success it answers with exactly what goes live (PRs, cards, mode) and posts the final result into this chat after the restart. ' +
      'Never call it unless the owner asked to deploy in their latest message. One ask = one call.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}

/** Offered only to a live chat turn of an allowed bot, for an admin, in the repo-owning workspace, while the switch is on. */
export function chatDeployToolSpecs(ctx: ToolContext): ToolSpec[] {
  if (ctx.cardWake || ctx.botWake) return []
  if (!chatDeployOfferable(getDb(), { slug: ctx.agent.slug, userId: ctx.userId, workspace: ctx.workspace })) return []
  return [{ ...SPEC, function: { ...SPEC.function } }]
}

export async function runChatDeployTool(ctx: ToolContext, fnName: string, _args: Record<string, unknown>): Promise<ToolOutcome> {
  if (fnName !== CHAT_DEPLOY_FN) throw new ToolUseError(`Unknown tool "${fnName}".`)
  const r = runChatDeploy(getDb(), {
    userId: ctx.userId,
    username: ctx.username,
    agentSlug: ctx.agent.slug,
    botName: ctx.agent.name || ctx.agent.slug,
    workspace: ctx.workspace,
    threadId: laneThreadId(ctx.lane ?? MAIN_LANE),
    turnMessageIds: ctx.turnMessageIds ?? [],
    wake: !!(ctx.cardWake || ctx.botWake),
  })
  const result = {
    deploy_id: r.deploy_id,
    deployed: false,
    started: r.outcome === 'started',
    outcome: r.outcome,
    code: r.code,
    message: r.message,
    mode: r.mode,
    from_commit: r.from_commit,
    to_commit: r.to_commit,
    going_live: r.prs,
    ...(r.paths ? { paths: r.paths } : {}),
    ...(r.working_cards != null ? { working_cards: r.working_cards } : {}),
    note: r.outcome === 'started'
      ? 'Tell the owner exactly what is going live (the list above) and that the result will be posted here.'
      : 'Nothing was deployed. Tell the owner the reason in one line, and that the owner deploys this one.',
  }
  const summary = r.outcome === 'started' ? `Deploy #${r.deploy_id} started: ${r.message}` : `Did not deploy: ${r.message}`
  return { result, summary }
}
