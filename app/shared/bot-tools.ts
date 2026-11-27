// The ONE list of bot tools (obj 900966). The server (agent-file importer, chat
// engine, bot "about" text), the client (bot page, info panel) and the docs test
// all read this file. Add a tool here and nowhere else:
//   1. its name in a *_TOOLS group below (and so in KNOWN_TOOL_NAMES),
//   2. a TOOL_CATALOG row (what the bot page shows),
//   3. a TOOL_REACH line (what the info panel and the About text say),
//   4. a row in docs/agents/agent-file-format.md (a test checks it).
// No imports: it must load in the browser and in Node alike.
//
// Tool names an agent file may list under `tools:` (obj 719987). Shared with
// the agent-templates card: knowledge + board names match the MCP connector's
// tool names; `email` and `calendar` are connectors that only ever draft.
export const KNOWLEDGE_TOOLS = ['search', 'list_folders', 'read_file', 'write_doc', 'file_answer', 'flag_knowledge'] as const
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
// obj 901764: propose a breakdown (card, done-when, acceptance criteria, child
// split, standing rules) for an outcome the person states. Files nothing: the
// person edits and approves it in the chat. Implied by create_objective.
export const OUTCOME_TOOLS = ['propose_outcome'] as const
// obj 901493: where a page, tab or setting is in the app right now, from the
// generated app map (shared/app-map.generated.json). Read-only and static.
export const APP_TOOLS = ['app_routes'] as const

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
  ...OUTCOME_TOOLS,
  ...APP_TOOLS,
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

export type ToolGroup = 'web' | 'app' | 'knowledge' | 'board' | 'bots' | 'connectors' | 'integrations' | 'secrets' | 'sandbox' | 'images'

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
  { name: 'app_routes', label: 'App map (pages and settings)', description: 'Look up where a page, tab or setting is in this app right now, so the click paths the bot gives are never out of date.', group: 'app' },
  { name: 'search', label: 'Search knowledge', description: 'Search the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'list_folders', label: 'Browse knowledge', description: 'List files in the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'read_file', label: 'Read notes', description: 'Read a text file in the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'write_doc', label: 'Write notes', description: 'Create or replace a note in the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'file_answer', label: 'Save answers to the wiki', description: 'Save a useful answer as a wiki page.', group: 'knowledge' },
  { name: 'flag_knowledge', label: 'Flag knowledge gaps', description: 'Report something missing, wrong or out of date in the knowledge base, with an optional fix. It lands on the Cleanup tab; no page is changed. A bot that can search or read notes gets it automatically.', group: 'knowledge' },
  { name: 'create_objective', label: 'File board cards', description: 'Hand a bigger job to the board as a card.', group: 'board' },
  { name: 'get_objective', label: 'Read a card', description: 'Read one board card the person can see.', group: 'board' },
  { name: 'list_objectives', label: 'List cards', description: 'List board cards the person can see.', group: 'board' },
  { name: 'board_briefing', label: 'Board briefing', description: 'What is waiting on the person across their boards.', group: 'board' },
  { name: 'raise_decision', label: 'Ask for decisions', description: 'Ask the person to decide on a card with a short briefing: the question, options with pros and cons, a recommendation and a Q&A thread.', group: 'board' },
  { name: 'propose_outcome', label: 'Propose work for approval', description: 'Turn an outcome you describe into proposed cards with a done-when and acceptance criteria. Nothing is filed until you edit and approve it in the chat.', group: 'board' },
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

/** Names an agent file may list under `tools:` without a warning: every built-in tool, plus `all` and `*`. */
export const AGENT_FILE_TOOL_NAMES: readonly string[] = [...KNOWN_TOOL_NAMES, ...ALL_TOOLS_TOKENS]

/**
 * Plain-language lines for what a bot can do, one per tool family, in display
 * order. A line applies when the bot has ANY of its `tools`.
 *   - `reach`: the info panel's "what it can reach" line.
 *   - `about`: the "how to use" bullet in the generated About text.
 * `folders` is the bot's knowledge folders (already shortened by the caller if it wants).
 */
export interface ToolReachEntry {
  tools: readonly string[]
  reach: (folders: string) => string
  about: (folders: string) => string
}

export const TOOL_REACH: readonly ToolReachEntry[] = [
  {
    tools: ['search', 'list_folders', 'read_file'],
    reach: f => (f ? `Reads your Context folders: ${f}` : 'Reads your Context'),
    about: f => `Ask about anything in ${f ? `your notes in ${f}` : 'your knowledge base'}; it looks there before it answers.`,
  },
  {
    tools: ['write_doc', 'file_answer'],
    reach: () => 'Saves notes into those folders — each save shows up in the conversation',
    about: () => 'Ask it to save a note or a useful answer; each save shows up in the conversation.',
  },
  {
    tools: ['flag_knowledge'],
    reach: () => 'Flags missing, wrong or out-of-date notes for the Cleanup tab — it never edits them',
    about: () => 'When it finds a note that is missing, wrong or out of date it flags it on the Cleanup tab instead of rewriting it.',
  },
  {
    tools: ['web_search', 'web_fetch'],
    reach: () => 'Searches the public web and reads public pages',
    about: () => 'Ask it to look something up on the web or read a public page.',
  },
  {
    tools: ['list_objectives', 'get_objective', 'board_briefing'],
    reach: () => 'Reads the board cards you can see',
    about: () => 'Ask what is waiting on you on the board, or about a card by its number.',
  },
  {
    tools: ['create_objective'],
    reach: () => 'Files bigger jobs as board cards for the team’s coding tools',
    about: () => 'For bigger work, ask it to put a task on the board; the team’s coding tools pick it up.',
  },
  {
    tools: ['propose_outcome'],
    reach: () => 'Proposes cards and acceptance criteria for an outcome you describe — nothing is filed until you approve',
    about: () => 'Tell it the outcome you want; it proposes the cards and how done is checked, and you approve or edit them.',
  },
  {
    tools: ['raise_decision'],
    reach: () => 'Asks you for decisions on a card with a short briefing — it never decides for you',
    about: () => 'When a card needs your decision it sends a short briefing with options; you choose.',
  },
  {
    tools: ['attach_image'],
    reach: () => 'Attaches screenshots and images to its replies',
    about: () => 'Ask it to show a screenshot or image; it appears in the reply.',
  },
  {
    tools: ['bot_messages'],
    reach: () => 'Messages other bots in the same workspace and brings their replies back here',
    about: () => 'Ask it to check with another bot; the reply comes back into this conversation.',
  },
  {
    tools: ['email'],
    reach: () => 'Reads your inbox and writes email drafts — nothing is sent until you press Send',
    about: () => 'Ask it to draft email replies; you review each one and press Send yourself.',
  },
  {
    tools: ['calendar'],
    reach: () => 'Reads your calendar and drafts invites — nothing is added until you press Add',
    about: () => 'Ask it to plan a meeting; it drafts the invite and nothing is added until you press Add.',
  },
  {
    tools: ['mcp'],
    reach: () => 'Uses the MCP servers connected for this workspace in Settings → Integrations',
    about: () => 'It can use the integrations connected to this workspace in Settings → Integrations.',
  },
  {
    tools: ['secrets'],
    reach: () => 'Calls outside services with secrets you have allowed, by name — it never sees a value',
    about: () => 'It can call outside services with the secrets you have allowed, by name; it never sees a value.',
  },
  {
    tools: ['card_sandbox'],
    reach: () => 'Looks inside the sandbox of cards it owns: files, log, and commands (every call is logged)',
    about: () => 'Ask it to look inside one of its own cards: the files, the log, or a command in the sandbox.',
  },
  {
    tools: ['card_browser'],
    reach: () => 'Opens public web pages in a sandboxed browser and takes screenshots',
    about: () => 'Ask it to open a public page and take a screenshot.',
  },
  {
    tools: ['followups'],
    reach: () => 'Sets itself a one-off follow-up in this chat and checks back when it is due',
    about: () => 'Ask it to check back later; it schedules its own follow-up and answers here when it fires.',
  },
  {
    tools: ['app_routes'],
    reach: () => 'Looks up where a page, tab or setting is in this app right now',
    about: () => 'Ask it where to find a page or setting; it checks the current app map before it answers.',
  },
]

/** The TOOL_REACH lines that apply to a bot with these (effective) tools. */
export function toolReachFor(tools: readonly string[]): ToolReachEntry[] {
  const have = new Set(tools)
  return TOOL_REACH.filter(r => r.tools.some(t => have.has(t)))
}
