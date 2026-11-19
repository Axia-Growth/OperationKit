// Tool names an agent file may list under `tools:` (obj 719987). Shared with
// the agent-templates card: knowledge + board names match the MCP connector's
// tool names; `email` and `calendar` are connectors that only ever draft.
export const KNOWLEDGE_TOOLS = ['search', 'list_folders', 'read_file', 'write_doc', 'file_answer'] as const
export const BOARD_TOOLS = ['create_objective', 'get_objective', 'list_objectives', 'board_briefing'] as const
// obj 901028: attach a screenshot (a card artifact, a knowledge-base path, or
// generated image data) to the bot's reply so it renders inline in chat.
export const IMAGE_TOOLS = ['attach_image'] as const
export const CONNECTOR_TOOLS = ['email', 'calendar'] as const
// obj 900620: `mcp` = the remote MCP servers connected for the chat's
// workspace in Settings → Integrations. Opt-in per agent file, so no existing
// agent gains a tool it did not list.
export const MCP_TOOLS = ['mcp'] as const
// obj 900671: the public web. `web_search` asks a search backend configured on
// the install; `web_fetch` reads one public page through the SSRF-guarded
// fetch. Opt-in like every other tool (or via "all tools").
export const WEB_TOOLS = ['web_search', 'web_fetch'] as const
// obj 900749: use a named secret through the broker (secrets_list, secret_http).
// The bot names a secret; the server injects the value into the outbound HTTPS
// request and redacts the reply. The value never reaches the model, the chat
// history or a log.
export const SECRET_TOOLS = ['secrets'] as const
// obj 900859: message another bot (message_bot), list / read those threads.
// The other bot is woken with the message and its reply comes back on the same
// thread. Only bots that may work in the same workspace can be reached.
export const BOT_MESSAGE_TOOLS = ['bot_messages'] as const
// obj 901027: look inside a card's own sandbox (list/read its objective-memory
// files, read its progress log and transcript, run a command in its live
// jail) — gated to cards this bot owns or has Full access to, explicit opt-in
// only because sandbox_run executes a shell command.
export const CARD_SANDBOX_TOOLS = ['card_sandbox'] as const
// obj 901027: a disposable headless-browser screenshot tool for chat, so an
// any-model bot can look at a page directly instead of asking a card session
// to do it. Explicit opt-in (security review, obj 901027): it can reach
// arbitrary URLs and name a card to screenshot "for", so — like card_sandbox —
// "All tools" must not hand it to a bot that was never meant to have it.
export const CARD_BROWSER_TOOLS = ['card_browser'] as const
// obj 901059: ask the person for a decision on a card, with a structured briefing
// (context, one question, 2-4 options with pros/cons/next, recommendation). It
// only ASKS: the person answers on the card or in chat, never the bot.
export const DECISION_TOOLS = ['raise_decision'] as const
// obj 901392: the bot sets itself a one-off follow-up wake in the chat it is in
// (schedule_followup / list_followups / cancel_followup). When it is due the
// bot runs an ordinary turn there and posts its answer; no new permission.
// Implied by create_objective (tools.ts IMPLIED_TOOLS), like raise_decision.
export const FOLLOWUP_TOOLS = ['followups'] as const

/**
 * Tools "All tools" does NOT grant (obj 900749). A bot gets one only when it is
 * named — in the agent file (`tools: [all, secrets]` works) or ticked on the bot
 * page — so switching on "All tools" never also hands a bot your credentials.
 */
export const EXPLICIT_ONLY_TOOLS: ReadonlySet<string> = new Set<string>([...SECRET_TOOLS, ...CARD_SANDBOX_TOOLS, ...CARD_BROWSER_TOOLS])

export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...KNOWLEDGE_TOOLS,
  ...BOARD_TOOLS,
  ...IMAGE_TOOLS,
  ...CONNECTOR_TOOLS,
  ...MCP_TOOLS,
  ...WEB_TOOLS,
  ...SECRET_TOOLS,
  ...BOT_MESSAGE_TOOLS,
  ...CARD_SANDBOX_TOOLS,
  ...CARD_BROWSER_TOOLS,
  ...DECISION_TOOLS,
  ...FOLLOWUP_TOOLS,
])

/** What "All tools" grants: every known tool except the explicit-only ones. */
export const ALL_TOOLS_GRANT: ReadonlySet<string> = new Set<string>([...KNOWN_TOOL_NAMES].filter(t => !EXPLICIT_ONLY_TOOLS.has(t)))

/**
 * "All tools" (obj 900671). An agent file may say `tools: [all]` (or `*`), and
 * the bot page has an "All tools" switch. Either way the bot gets every tool in
 * ALL_TOOLS_GRANT — including tools added in later releases — without its
 * file being edited again. Explicit-only tools (secret use) are the exception. Email and calendar stay draft-only and board reads
 * stay limited to what the chatting person can see: "all" widens WHICH tools a
 * bot has, never what a tool may do.
 */
export const ALL_TOOLS_TOKENS: ReadonlySet<string> = new Set(['all', '*'])

export function listsAllTools(tools: readonly string[]): boolean {
  return tools.some(t => ALL_TOOLS_TOKENS.has(t.trim().toLowerCase()))
}

export type ToolGroup = 'web' | 'knowledge' | 'board' | 'bots' | 'connectors' | 'integrations' | 'secrets' | 'sandbox' | 'images'

export interface ToolCatalogEntry {
  name: string
  label: string
  description: string
  group: ToolGroup
  /** Not included by "All tools"; must be ticked on its own (obj 900749). */
  explicit_only?: boolean
}

/** What the bot page shows for each tool, in display order. */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { name: 'web_search', label: 'Web search', description: 'Search the public web for current information.', group: 'web' },
  { name: 'web_fetch', label: 'Read web pages', description: 'Open one public web page and read its text.', group: 'web' },
  { name: 'search', label: 'Search knowledge', description: 'Search the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'list_folders', label: 'Browse knowledge', description: 'List files in the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'read_file', label: 'Read notes', description: 'Read a text file in the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'write_doc', label: 'Write notes', description: 'Create or replace a note in the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'file_answer', label: 'Save answers to the wiki', description: 'Save a useful answer as a wiki page.', group: 'knowledge' },
  { name: 'create_objective', label: 'File board cards', description: 'Hand a bigger job to the board as a card.', group: 'board' },
  { name: 'get_objective', label: 'Read a card', description: 'Read one board card the person can see.', group: 'board' },
  { name: 'list_objectives', label: 'List cards', description: 'List board cards the person can see.', group: 'board' },
  { name: 'board_briefing', label: 'Board briefing', description: 'What is waiting on the person across their boards.', group: 'board' },
  { name: 'raise_decision', label: 'Ask for decisions', description: 'Ask the person to decide on a card with a short briefing: the question, options with pros and cons, a recommendation and a Q&A thread.', group: 'board' },
  { name: 'followups', label: 'Check back later (follow-ups)', description: 'Set itself a one-off follow-up in the chat ("check back in 10 minutes") and answer there when it is due, with its normal permissions. Limits: 5 waiting per chat, 6 in a row without a message from you.', group: 'board' },
  { name: 'attach_image', label: 'Attach images', description: 'Attach a screenshot (a card artifact, a knowledge-base path, or a generated image) so it renders inline in the reply.', group: 'images' },
  { name: 'bot_messages', label: 'Message other bots', description: 'Send another bot a message in the same workspace and get its reply on a shared thread.', group: 'bots' },
  { name: 'email', label: 'Email (drafts only)', description: 'Read the inbox and draft replies. Nothing is sent without a click.', group: 'connectors' },
  { name: 'calendar', label: 'Calendar (drafts only)', description: 'Read the calendar and draft events. Nothing is added without a click.', group: 'connectors' },
  { name: 'mcp', label: 'Workspace integrations (MCP)', description: 'Tools from the MCP servers connected to the workspace.', group: 'integrations' },
  { name: 'secrets', label: 'Use secrets by name', description: 'Call an API with a named secret. The server adds the key; the bot never sees it. Only hosts allowed in Settings → Secrets.', group: 'secrets', explicit_only: true },
  { name: 'card_sandbox', label: 'Inspect card sandboxes', description: 'Look inside a card you own (or have Full access to): list its files, read its log and transcript, and run a command in its live sandbox. Every call is logged. Never has Shared secrets.', group: 'sandbox', explicit_only: true },
  { name: 'card_browser', label: 'Browser (screenshots)', description: 'Open a web page in a disposable, sandboxed headless browser and take a screenshot. Loopback, private-network and metadata destinations are always refused.', group: 'sandbox', explicit_only: true },
]
