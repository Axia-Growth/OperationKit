/**
 * Decision options that need a CHAT-ONLY operator tool (obj 901453).
 *
 * WHY. On card #901383 the owner answered decision #44 ("When should Dev
 * deploy?") with option A, "Deploy the four now". Operation Kit Dev had raised
 * it from chat, but the answer restarted the CARD session, and a card session
 * has no deploy tool: `dev_deploy` / `dev_merge_pr` (and the grant-gated
 * `merge_approved_pr`) are chat tools behind `devOpsGate`, which only opens for
 * an admin TYPING in the browser chat. So "Deploy now" deployed nothing.
 *
 * Two rules use this one classifier, so they cannot drift apart:
 *   1. routing: an answer naming a deploy / merge option on a decision a bot
 *      raised from chat goes to that bot's chat as a plain line ("You chose
 *      Deploy. Type deploy here to run it."), never to a card restart;
 *   2. raising: a bot may not offer an option whose `next` promises it will
 *      deploy or merge on the click. Its `next` must say the person types the
 *      word in the chat (the only path that can run it).
 *
 * The decision button itself never runs anything, and nothing here widens
 * `devOpsGate`. Pure functions, no I/O.
 */
import type { DecisionOption } from './decision-briefing.js'

export const CHAT_ONLY_ACTIONS = ['merge', 'deploy'] as const
export type ChatOnlyAction = (typeof CHAT_ONLY_ACTIONS)[number]

/** Words before the verb that keep it a promise: "I", "I'll", "Dev will", "we then"… */
const SUBJECT = String.raw`(?:\bI|\bI['’]ll|\bI will|\bwe|\bwe['’]ll|\bwe will|\bDev|\bDev will|\bthe bot|\bthe bot will)`
const FILLER = String.raw`(?:\s+(?:then|now|immediately|right away|straight away|go ahead and|run the|start the|do the|kick off the|trigger the|run))*`

const VERB: Record<ChatOnlyAction, string> = {
  deploy: String.raw`(?:re-?)?deploy`,
  merge: String.raw`(?:squash[- ]?)?merg(?:e|es|ing)`,
}
/** Tool names that run it. */
const TOOL: Record<ChatOnlyAction, RegExp> = {
  deploy: /\bdev_deploy\b/i,
  merge: /\b(?:dev_merge_pr|merge_approved_pr)\b/i,
}

function labelRe(a: ChatOnlyAction): RegExp {
  // The label LEADS with the verb: "Deploy the four now", "Yes, merge #812".
  return new RegExp(String.raw`^\s*(?:(?:yes|ok|okay|go)[,:\s—–-]+)?(?:go ahead and\s+)?${VERB[a]}\b`, 'i')
}
function promiseRe(a: ChatOnlyAction): RegExp {
  // The next PROMISES the act: "I deploy the four", "Dev will then merge PR 812".
  // "I will not deploy" / "nothing is deployed" do not match.
  return new RegExp(String.raw`${SUBJECT}${FILLER}\s+${VERB[a]}\w*\b`, 'i')
}

/**
 * The chat-only operator actions an option promises, in a stable order
 * (merge before deploy). Empty for an option that only asks, waits or holds.
 */
export function optionChatActions(opt: Pick<DecisionOption, 'label' | 'next'> | null | undefined): ChatOnlyAction[] {
  if (!opt) return []
  const label = String(opt.label ?? '')
  const next = String(opt.next ?? '')
  return CHAT_ONLY_ACTIONS.filter(a => labelRe(a).test(label) || promiseRe(a).test(next) || TOOL[a].test(next) || TOOL[a].test(label))
}

/** The `next` already says the person types the word in the chat to run it. */
export function nextSaysTypeInChat(next: string | null | undefined): boolean {
  const n = String(next ?? '')
  return /\btype\b[^.;]{0,60}\b(?:chat|here)\b/i.test(n) || /\b(?:in|into)\s+(?:this|the|my|our)\s+chat\b[^.;]{0,60}\btype\b/i.test(n)
}

/**
 * The raise-time wording rule: every option that promises a deploy or merge
 * must say the person types the word in this chat. Returns one plain error per
 * offending option (empty = fine).
 */
export function chatActionWordingErrors(options: Array<Pick<DecisionOption, 'label' | 'next'> & { key?: string }> | null | undefined): string[] {
  const errs: string[] = []
  ;(options ?? []).forEach((o, i) => {
    const acts = optionChatActions(o)
    if (!acts.length || nextSaysTypeInChat(o.next)) return
    const key = o.key || String.fromCharCode(65 + i)
    const words = acts.join(' and ')
    errs.push(
      `option ${key} ("${String(o.label ?? '').slice(0, 60)}") promises a ${words}, but answering a decision cannot run one: ${words} runs only when the person types it in this chat. ` +
        `Reword its next like: "You type ${acts[0]} in this chat and I run it."`,
    )
  })
  return errs
}

/** The line the bot's chat gets when the person picks such an option. */
export function chatActionLine(p: { action: ChatOnlyAction; optionKey: string; optionLabel: string; objectiveId: number; decisionId: number }): string {
  const verb = p.action === 'deploy' ? 'Deploy' : 'Merge'
  return [
    `You chose ${verb} (${p.optionKey}: ${p.optionLabel}) on decision #${p.decisionId}, card #${p.objectiveId}. Type ${p.action} here to run it.`,
    `Nothing has run yet: a ${p.action} only runs from a message you type in this chat, not from the decision button.`,
  ].join(' ')
}
