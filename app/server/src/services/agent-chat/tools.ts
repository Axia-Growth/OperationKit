// ── What a chat agent can DO (obj 719987) ──
//
// Every tool runs inside this Node process with three hard limits that the
// model cannot talk its way around:
//   1. Knowledge: paths are relative to the knowledge-base root and must fall
//      inside one of the agent's knowledge_folders (checked after resolving
//      symlinks). Nothing else on disk is reachable.
//   2. Email / calendar: draft-only. Drafts are stored; nothing is delivered
//      until the person clicks Send in the chat (routes/agent-chat.ts).
//   3. Board: an agent can file cards in the person's workspace (writes are
//      unchanged: one workspace, recorded in agent_chat_cards). READS see the
//      real board, but only what the chatting person could see on the board UI
//      themselves — the visibility rule of GET /api/agent/attention and the
//      Command Center connector (lib/agent-control visibilityClause), with the
//      role re-read from the DB on every call. Never wider. (obj 900623)
//      The card then runs like any other card — sandboxed
//      (SESSION_ISOLATION=docker) on a client install.
// An agent only gets the tools its file lists under `tools:`.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getDb } from '../../db/index.js'
import { getDefaultModelId } from '../model-registry.js'
import { cardModelForBot } from './bot-card-model.js'
import { CHILD_CAP_PER_PARENT, depthForParent, openChildCount } from '../../lib/objective-depth.js'
import { checkAgentInWorkspacePool, defaultAgentForWorkspace } from '../../routes/objectives-helpers.js'
import { broadcast } from '../../ws/index.js'
import { KB_FLAG_KINDS, chatActionWordingErrors, getInitialStatus, validateKbFlagInput, validateOwnerBot, type Objective } from '@operationkit/shared'
import { raiseDecision } from '../decisions.js'
import type { ChatAgent } from './agent-defs.js'
import { createDraft, type Connectors, type EmailDraft, type EventDraft } from './connectors.js'
import { workspaceKbRoot } from '../doc-ingest/kb-paths.js'
import { ingestEnabled } from '../doc-ingest/service.js'
import { checkAndFileAnswer, fileAnswer, type FiledAnswer } from '../kb-wiki/answers.js'
import { wikiLlm } from '../kb-wiki/llm.js'
import { heldAnswerReleaseRefusal, isHeldAnswerText } from '../../lib/kb-answer-hold.js'
import { fileKbFlag } from '../kb-wiki/flags.js'
import { botForAgentSlug, resolveBot } from '../bots/bot-registry.js'
import { createBotJob, findJobByIdempotency } from '../bots/bot-jobs.js'
import { isDuplicateGuardEnabled, recordDedupe } from '../../lib/objective-dedupe.js'
import { explicitKey, findPossibleDuplicate, NEAR_DUPLICATE_THRESHOLD, parseFilingKey, possibleDuplicateResult, titleSimilarity, type PossibleDuplicate } from './card-filing-guard.js'
import { composeCardBrief, normalizeDoneWhen } from '../../../../shared/card-brief.js'
import { CARD_BRIEF_TOOL_HINT, DONE_WHEN_ARG, STOP_CONDITIONS_ARG } from './card-brief-args.js'
import { buildAttention, oneLine, visibilityClause, type ControlUser } from '../../lib/agent-control.js'
import { ALL_TOOLS_GRANT, EXPLICIT_ONLY_TOOLS, KNOWN_TOOL_NAMES, listsAllTools } from './tool-names.js'
import { callerForChat, executeHttp, listForCaller, recordBrokerUse } from '../secrets-broker.js'
import { botSecretGrants } from './bot-secret-access.js'
import { rateLimit } from '../file-access.js'
import { userHasWorkspace } from '../../middleware/workspace.js'
import { webFetch, webSearch, WebToolError, MAX_SEARCH_RESULTS, DEFAULT_SEARCH_RESULTS, type WebToolDeps } from './web-tools.js'
import { botMayUseWorkspace, botWorkspaceAllowlist, personaOwnershipBlocked } from './bot-workspaces.js'
import { withResolvedKnowledgeFolders } from './knowledge-folders.js'
import { containedIn, realpathOrNull, resolveVaultPath, workspaceScopeRoots } from '../../lib/kb-workspace-scope.js'
import { searchKnowledgeBase } from '../kb-semantic/search.js'
import { noteKbChanged } from '../kb-semantic/service.js'
import type { ChatLane } from './threads.js'
import { fullAccessActive, fullAccessAnywhere, protectedCardRefusal, protectedPrTextRefusal, refuseExclusion } from './bot-full-access.js'
import { exclusionGate, type OutboundCall } from './full-access-exclusions.js'
import type { DeployStatus } from '../deploy-waiting.js'
import { FULL_ACCESS_FNS, fullAccessToolSpecs, runFullAccessTool, withFullAccess, type FullAccessHost } from './full-access-tools.js'
import { CARD_WAKE_FNS, runCardWakeTool, type CardWakeScope } from './card-wake-tools.js'
import { beginSelfAction, endSelfAction, SELF_ACTION_TOOLS } from './card-wake-routing.js'
import { CARD_SANDBOX_FNS, cardSandboxToolSpecs, runCardSandboxTool } from './card-sandbox-tools.js'
import { GRANT_MERGE_FNS, grantMergeToolSpecs, runGrantMergeTool } from './grant-merge-tool.js'
import { CHAT_DEPLOY_FNS, chatDeployToolSpecs, runChatDeployTool } from './chat-deploy-tool.js'
import { DEV_OPS_ALL_FNS, devOpsToolSpecs, runDevOpsTool } from './dev-ops-tools.js'
import { FOLLOWUP_FNS, followupToolSpecs, runFollowupTool } from './followups.js'
import { writeDevOpsAudit } from '../dev-ops/audit.js'
import { CARD_BROWSER_FNS, cardBrowserToolSpecs, runCardBrowserTool } from './card-browser-tools.js'
import {
  BotMessageRefused,
  botMessageWorkspaces,
  conversationInScope,
  conversationMessages,
  listConversations,
  sendBotMessage,
  type BotRef,
} from './bot-messaging.js'
import { ArtifactError, readArtifactImage } from '../live-artifacts.js'
import { ImageRejected, MAX_IMAGE_BYTES, parseIncomingImages, validateImageBytes, type IncomingImage } from './attachments.js'
import { publicCardUrl } from '../../lib/public-url.js'
import { APP_ROUTES_DEFAULT_BOTS, APP_ROUTES_DESCRIPTION, APP_ROUTES_TOOL, appRoutesSummary, searchAppMap } from './app-routes-tool.js'
import { offsetArg, pageNote, pageText } from './text-page.js'
import { createProposal, listRules } from '../outcome-intake.js'
import { MAX_CHILDREN, MAX_CRITERIA, MAX_SUGGESTED_RULES } from '../../../../shared/outcome-intake.js'
import { cardDecisionsForBot, cardOwnerAndGrants, cardThreadForBot, holdView, type BotCardOwner, type BotDecisionView, type BotThreadEntry } from './card-context.js'

export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolContext {
  userId: number
  username: string
  /**
   * The chat's workspace: where create_objective / file_answer write and whose
   * secrets and MCP servers the bot may use. Always one the bot is granted
   * (obj 900797); '' when the person and the bot share no workspace, and then
   * every workspace-bound tool refuses.
   */
  workspace: string
  agent: ChatAgent
  kbRoot: string
  connectors: Connectors
  now?: () => Date
  /** web_search / web_fetch plumbing (obj 900671): tests inject fetches; the engine passes the turn's abort signal. */
  web?: WebToolDeps
  /** The chat lane this turn runs in (obj 900859): where a bot message's reply is posted back. */
  lane?: ChatLane
  /**
   * Set when this turn is a bot-to-bot WAKE (bot-wake.ts): the conversation that
   * woke the bot and how deep the chain already is. Narrows the bot-message tools
   * to that conversation's ONE workspace.
   */
  botWake?: { conversationId: number; depth: number }
  /** obj 900972: how a Full access tool starts or messages a card. Tests pass a stub; the host default uses the internal routes. */
  fullAccessHost?: FullAccessHost
  /** obj 901389: reads the "merged, waiting for deploy" picture for `release_status`; tests pass a stub. */
  deployStatusReader?: () => DeployStatus
  /**
   * obj 901328: set when this turn is a needs_agent CARD WAKE (card-wakes.ts).
   * With `toolScope: 'chat'` (obj 901394, the default) the turn has the own-card
   * tools plus this bot's normal chat tools, with the permissions of a normal chat
   * turn for this person and no more. Otherwise it has ONLY the own-card tools
   * (card-wake-tools.ts) and runChatTool refuses every other tool name.
   */
  cardWake?: CardWakeScope
  /**
   * obj 901393: the ids of the person's messages THIS turn delivers (the typed
   * message plus any queued ones). Set by runTurn only — a wake turn has none.
   * The chat deploy tool requires the owner's ask to be one of these, so a
   * say-so never carries over to a later turn.
   */
  turnMessageIds?: number[]
  /**
   * obj 901392: set when this turn was started by one of the bot's own
   * follow-ups (followup-wake.ts) rather than a typed message. It changes NO
   * permission: the turn is an ordinary chat turn. It only carries the chain
   * length, so schedule_followup can stop a runaway chain. `personSpoke` =
   * a queued message from the person was delivered in this same turn.
   */
  followup?: { id: number; hop: number; personSpoke: boolean }
  /**
   * obj 901424: this turn's message came from the person's signed-in browser
   * (cookie session), not an API key / bearer token / queued drain. Required by
   * the operator tools (dev-ops-tools.ts).
   */
  browserSession?: boolean
}

/** What the chat UI shows for a tool call (drafts get buttons, cards get a status chip). */
export interface ToolOutcome {
  /** Fed back to the model. */
  result: unknown
  /** One plain-language line for the person. */
  summary: string
  draft_id?: number
  objective_id?: number
  /** A bot-to-bot conversation this call started or used (obj 900859) — the chat shows an "Open thread" link. */
  bot_conversation_id?: number
  /** obj 901059: a decision this call raised — the chat renders its briefing, Q&A thread and Approve/Deny. */
  decision_id?: number
  /** obj 901392: a follow-up this call scheduled or cancelled — the chat renders its live state and a Cancel control. */
  followup_id?: number
  /** obj 901764: a breakdown this call proposed — the chat renders it, editable, with Approve and start. */
  outcome_proposal_id?: number
  /** obj 901028: an image this tool call attaches to the reply — rendered inline, same as a pasted screenshot. */
  images?: IncomingImage[]
}

export class ToolUseError extends Error {}

const LIST_DEFAULT = 25
const LIST_MAX = 100
/** Columns list_objectives can filter to. 'blocked' is the blocker flag, not a status column. */
const BOARD_STATUSES = ['planning', 'queue', 'working', 'ai_review', 'review', 'blocked', 'done', 'cancelled'] as const
/** The live pipeline: everything but the two terminal columns. */
const OPEN_STATUSES = ['planning', 'queue', 'working', 'ai_review', 'review']

const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.json', '.yaml', '.yml'])
const WRITE_EXT = new Set(['.md', '.txt', '.csv'])
/** One read_file page. A longer file is read page by page (text-page.ts). */
export const MAX_READ_CHARS = 20_000
const MAX_WRITE_BYTES = 200_000

function obj(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false }
}
function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { type: 'function', function: { name, description, parameters } }
}

const SPECS: Record<string, ToolSpec[]> = {
  search: [fn('search', 'Search your knowledge folders by meaning and by exact words (hybrid). Returns matching files with a short snippet and score. Open one with read_file.',
    obj({
      q: { type: 'string', description: 'What to look for: a question, a topic, or exact words / IDs' },
      mode: { type: 'string', enum: ['hybrid', 'keyword', 'semantic'], description: 'hybrid (default) = meaning + exact words; keyword = exact words only; semantic = meaning only' },
    }, ['q']))],
  list_folders: [fn('list_folders', 'List the files and folders inside one of your knowledge folders. Omit path to see your top-level folders.',
    obj({ path: { type: 'string', description: 'Folder path relative to the knowledge base, e.g. "notes/clients"' } }))],
  read_file: [fn('read_file', `Read one text file from your knowledge folders. A long file comes back one page at a time (about ${MAX_READ_CHARS} characters): when the result has "truncated": true, call again with "offset" set to the "next_offset" it returned, until next_offset is null.`,
    obj({
      path: { type: 'string', description: 'File path relative to the knowledge base' },
      offset: { type: 'integer', minimum: 0, description: 'Character position to start from. Omit for the start of the file; for the next page pass the next_offset of the previous result.' },
    }, ['path']))],
  write_doc: [fn('write_doc', 'Create or replace one .md/.txt/.csv file in your knowledge folders. Send the FULL new content; read the file first when editing.',
    obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']))],
  file_answer: [fn('file_answer', 'Save a good answer into the workspace knowledge base as a wiki page, linked from the pages it used, so later questions can build on it. Only save answers the person found useful. The answer is checked against the pages it cites first: one that cites a missing page, or makes claims its pages do not back up, is saved but kept out of search until a person reviews it.',
    obj({ question: { type: 'string' }, answer: { type: 'string', description: 'The answer in markdown; cite pages as [[folder/page.md]]' }, sources: { type: 'array', items: { type: 'string' }, description: 'Knowledge-base paths of the pages the answer used, e.g. "people/dana-ruiz.md"' } }, ['question', 'answer']))],
  // obj 901767: report a knowledge defect to the Cleanup queue. Never edits a page.
  flag_knowledge: [fn('flag_knowledge', 'Report that something in the knowledge base is MISSING, WRONG or OUT OF DATE, so a person or the curator can fix it later. This does NOT edit any page: use it instead of quietly rewriting a fact you are unsure about. Add a suggested fix when you know the right answer, and the card number you were working on when there is one. Filing the same defect again just counts it again.',
    obj({
      kind: { type: 'string', enum: [...KB_FLAG_KINDS], description: 'missing = not written down anywhere; wrong = a page says something untrue; stale = was true, now out of date' },
      subject: { type: 'string', description: 'What knowledge is affected, in a few words, e.g. "Acme billing contact"' },
      detail: { type: 'string', description: 'What is missing / wrong / out of date, and how you noticed' },
      page: { type: 'string', description: 'Optional knowledge-base-relative page path the defect is on (or belongs on), e.g. "organizations/acme.md"' },
      suggested_fix: { type: 'string', description: 'Optional: the correct fact or the text you would add. It is NOT applied automatically.' },
      card_id: { type: 'integer', description: 'Optional: the board card you were working on when you noticed' },
    }, ['kind', 'subject', 'detail']))],
  attach_image: [fn('attach_image', 'Attach an image so it renders inline in chat as a thumbnail the person can open full size. source "kb" = a path in your knowledge folders; "card_artifact" = a screenshot a board card saved to its objective memory (give objective_id and the artifact path, e.g. "live/screenshot.png" — list a card\'s files with get_objective first if unsure); "data" = base64 image bytes you generated yourself (e.g. a chart). PNG, JPEG, GIF or WebP only, 5 MB max.',
    obj({
      source: { type: 'string', enum: ['kb', 'card_artifact', 'data'] },
      path: { type: 'string', description: 'Required for "kb" and "card_artifact": the file path. For "data", an optional file name.' },
      objective_id: { type: 'integer', description: 'Required for "card_artifact": the card number the screenshot belongs to.' },
      data: { type: 'string', description: 'Required for "data": base64 image bytes (bare, or a data: URL).' },
      media_type: { type: 'string', description: 'Optional declared type for "data" — checked against the real bytes, never trusted alone.' },
      alt_text: { type: 'string', description: 'Short description of the image, for accessibility and the caption shown under it.' },
    }, ['source']))],
  create_objective: [fn('create_objective', 'Hand a bigger job to the team board as a card. Coding tools pick it up and do the work; you can check its status later with get_objective. Use for anything that takes more than a few minutes. Look at the board first (list_objectives) so you do not file work that is already there. A retry never means file again: the same request returns the card already filed, and an open card with a near-identical title comes back as "possible duplicate #N" with nothing filed. The result says whether the card will start by itself; a card that did not start still EXISTS, so start or follow that card, never re-create it. ' + CARD_BRIEF_TOOL_HINT,
    obj({
      title: { type: 'string', description: 'Short, specific title' },
      description: { type: 'string', description: 'What to do and the context. Put what "done" looks like in done_when and the stop cases in stop_conditions, not here.' },
      done_when: DONE_WHEN_ARG,
      stop_conditions: STOP_CONDITIONS_ARG,
      workspace: { type: 'string', description: 'Workspace slug to file the card in. Omit for this chat\'s workspace. Only workspaces this bot is granted and the person belongs to are accepted.' },
      parent_id: { type: 'integer', description: 'File this card UNDER another card: that card\'s number. Use it whenever the work belongs to an existing card, instead of writing "Parent: #N" in the text. The parent must be a top-level card you can see; the new card lands in the parent\'s workspace.' },
      idempotency_key: { type: 'string', description: 'One key per card you intend to file (any short unique string, no spaces). Reuse it word for word if you call again for the SAME card: you get the card already filed, never a second one. Use a new key for a different card.' },
      file_anyway: { type: 'boolean', description: 'Only after a result said "possible duplicate #N" and you checked that card is different work: true files the new card anyway.' },
    }, ['title', 'description']))],
  propose_outcome: [fn('propose_outcome', 'When the person states an OUTCOME they want (a result, not a quick question), propose how the board will deliver it, for them to approve. Nothing is filed: they see the breakdown in this chat, can edit every line, and press "Approve and start"; only then are the cards filed and started. Give ONE outcome card in their words, a checkable done_when, and acceptance criteria a reviewer can test; split into child cards only when the parts are genuinely independent. Never ask them to pick skills, tools or knowledge folders: that is your job. A standing rule they want on every card (for example "before-and-after screenshots on every PR") goes in standing_rules, never in a skill file. Do not also file these cards with create_objective.',
    obj({
      outcome: { type: 'string', description: 'The outcome in the person\'s own words, verbatim or near it.' },
      title: { type: 'string', description: 'Short title of the outcome card, saying the result ("Contact form on the website emails sales").' },
      brief: { type: 'string', description: 'What to build or change, where, and the context a stranger needs. Not the definition of done.' },
      done_when: DONE_WHEN_ARG,
      criteria: {
        type: 'array', minItems: 1, maxItems: MAX_CRITERIA,
        description: 'Acceptance criteria: each ONE concrete, testable statement an independent reviewer checks (not "it works").',
        items: obj({
          criterion: { type: 'string' },
          type: { type: 'string', enum: ['functional', 'visual', 'data'] },
          method: { type: 'string', enum: ['browser', 'api', 'doc'], description: 'How the reviewer verifies it' },
        }, ['criterion']),
      },
      stop_conditions: STOP_CONDITIONS_ARG,
      children: {
        type: 'array', maxItems: MAX_CHILDREN,
        description: 'Only when the outcome has independent parts that can run in parallel: one child card per part, each with its own done_when and criteria. Leave out for a single piece of work.',
        items: obj({
          title: { type: 'string' },
          brief: { type: 'string' },
          done_when: { type: 'string' },
          criteria: { type: 'array', items: obj({ criterion: { type: 'string' }, type: { type: 'string', enum: ['functional', 'visual', 'data'] }, method: { type: 'string', enum: ['browser', 'api', 'doc'] } }, ['criterion']) },
          stop_conditions: { type: 'array', items: { type: 'string' } },
        }, ['title', 'brief', 'done_when', 'criteria']),
      },
      standing_rules: {
        type: 'array', maxItems: MAX_SUGGESTED_RULES,
        description: 'Rules the person asked to apply to EVERY future card in this workspace, e.g. "before-and-after screenshots in the pull request". They are saved only when the person approves. applies_to "pr" (default) = only cards that open a pull request.',
        items: obj({ text: { type: 'string' }, applies_to: { type: 'string', enum: ['pr', 'all'] } }, ['text']),
      },
      workspace: { type: 'string', description: 'Workspace slug for the cards. Omit for this chat\'s workspace.' },
    }, ['outcome', 'title', 'brief', 'done_when', 'criteria']))],
  raise_decision: [fn('raise_decision', 'Ask the person to DECIDE something on a board card, with a short briefing. It shows at the top of the card and in this chat with a Q&A thread and Approve/Deny; their choice is sent to the card. Use this instead of asking for a decision in prose. Under about 200 words in total. Refused if the question or options are missing. A deploy or merge never runs from the answer: an option that deploys or merges must say in its next that the person types deploy / merge in this chat (e.g. "You type deploy in this chat and I run it.").',
    obj({
      card_id: { type: 'integer', description: 'The card the decision is about' },
      context: { type: 'string', description: '2-3 sentences: where we are, what the decision is for, where it fits in the system' },
      question: { type: 'string', description: 'The decision as ONE question' },
      options: {
        type: 'array', minItems: 2, maxItems: 4, description: '2-4 options',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'A, B, C or D' },
            label: { type: 'string', description: 'Short name of the option' },
            pros: { type: 'array', items: { type: 'string' }, description: '1-3 short pros' },
            cons: { type: 'array', items: { type: 'string' }, description: '1-3 short cons' },
            next: { type: 'string', description: 'What happens right after if this is chosen' },
          },
          required: ['label', 'pros', 'cons', 'next'],
          additionalProperties: false,
        },
      },
      recommended: { type: 'string', description: 'The key of the option you recommend' },
      recommended_why: { type: 'string', description: 'One sentence: why' },
    }, ['card_id', 'context', 'question', 'options', 'recommended', 'recommended_why']))],
  get_objective: [fn('get_objective', 'Read one board card by number: status, workspace, latest result, AI review verdict, PR link, hold (queue_hold / blocked_by), owner bot, its decisions with what the owner chose (who, when, result) and the recent card thread. Works for any card on a board the person can see, not only cards this chat filed.',
    obj({ id: { type: 'integer' } }, ['id']))],
  list_objectives: [fn('list_objectives', 'List the real board cards the person can see (every workspace they belong to, most recently updated first). Default: the open pipeline (planning, queue, working, ai_review, review — not done/cancelled). Pass workspace to narrow to one board, status for one column ("blocked" = a blocker is raised). counts covers ALL matching cards even when the list is cut short.',
    obj({
      workspace: { type: 'string', description: 'Workspace slug to narrow to. Omit for every workspace the person can see.' },
      status: { type: 'string', enum: [...BOARD_STATUSES], description: 'One column only.' },
      limit: { type: 'integer', minimum: 1, maximum: LIST_MAX, description: `Default ${LIST_DEFAULT}` },
    }))],
  board_briefing: [fn('board_briefing', 'What is waiting on the person, on the boards they can see: cards in review (accept or bounce), failed AI reviews, blockers, secrets a worker needs, stuck workers — plus how many open cards sit in each column. Use for "what is waiting on me?", "what is blocked?" or a daily summary.',
    obj({
      workspace: { type: 'string', description: 'Workspace slug to narrow to. Omit for every workspace the person can see.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most items to return. Default 20' },
    }))],
  // obj 901493: where a page, tab or setting is in the app, from the generated app map.
  app_routes: [fn('app_routes', APP_ROUTES_DESCRIPTION,
    obj({ query: { type: 'string', description: 'A page, panel or setting name, or an old path to check (for example "queue auto-start"). Omit to list every page.' } }))],
  // obj 900671: the public web.
  web_search: [fn('web_search', 'Search the public web for current information (news, prices, docs, companies, people in the news). Returns titles, URLs and snippets; open a result with web_fetch to read it in full. Cite the URLs you use.',
    obj({
      query: { type: 'string', description: 'What to search for' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: `Number of results. Default ${DEFAULT_SEARCH_RESULTS}` },
    }, ['query']))],
  web_fetch: [fn('web_fetch', 'Read one public web page (http or https) and return its text. Use it to open a search result or a link the person gives you. Private and internal addresses cannot be read.',
    obj({ url: { type: 'string', description: 'The full page URL, e.g. https://example.com/pricing' } }, ['url']))],
  // obj 900749: use a named secret without seeing it (the secrets broker).
  secrets: [
    fn('secrets_list', 'List the secrets you may USE in this workspace, by NAME, with the hosts each one may be sent to. You never see a value. usable=false means no host is allowed yet (an admin gives this bot the secret under Secret access on the bot settings page).',
      obj({})),
    fn('secret_http', 'Call an HTTPS API with a named secret. Write {{secret:NAME}} where the key goes (a header value, the URL path/query, or a body string), e.g. headers {"Authorization": "Bearer {{secret:STRIPE_KEY}}"}. The server adds the real value only on the outgoing request, only to a host that secret allows, and gives you the reply with the value blanked out. NEVER ask the person to paste a key and never write one into a message.',
      obj({
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'Default GET' },
        url: { type: 'string', description: 'Absolute https:// URL' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'Request body. For JSON, send the JSON text and a Content-Type: application/json header.' },
      }, ['url']))],
  // obj 900859: talk to another bot. The message wakes the other bot; its reply comes back on the same thread.
  bot_messages: [
    fn('message_bot', 'Send a message to ANOTHER BOT on this install (by its slug or name) and get its answer. The other bot is woken with your message, works on it with its own tools, and its reply is posted back into this chat on the same thread — usually within a minute. To follow up on a thread, pass its conversation_id instead of "to". Messages go only to bots that may work in the same workspace. The thread is readable by the people of that workspace in the Bots page, so do not put anything there they should not see.',
      obj({
        to: { type: 'string', description: 'The other bot\'s slug (e.g. "dev") or name. Omit when replying on conversation_id.' },
        text: { type: 'string', description: 'What you want the other bot to know or do. Be specific: it does not see this chat.' },
        conversation_id: { type: 'integer', description: 'Continue an existing bot conversation instead of starting one.' },
        workspace: { type: 'string', description: 'Workspace slug to hold the conversation in. Omit for this chat\'s workspace.' },
        subject: { type: 'string', description: 'A short title for a new conversation.' },
      }, ['text'])),
    fn('list_bot_conversations', 'List your conversations with other bots (newest first): who, which workspace, the last message and whether a message is still waiting for a reply.',
      obj({
        with: { type: 'string', description: 'Only conversations with this bot (slug).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20' },
      })),
    fn('read_bot_conversation', 'Read one of your bot conversations in full: every message, reply and delivery status.',
      obj({ conversation_id: { type: 'integer' } }, ['conversation_id'])),
  ],
  email: [
    fn('email_list_inbox', 'List recent emails in the inbox (newest first).',
      obj({ limit: { type: 'integer', minimum: 1, maximum: 50 }, unread_only: { type: 'boolean' } })),
    fn('email_read', 'Read one email in full.', obj({ id: { type: 'string' } }, ['id'])),
    fn('email_create_draft', 'Prepare an email DRAFT. It is NOT sent: the person reviews it and presses Send themselves.',
      obj({ to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, in_reply_to: { type: 'string', description: 'Email id this replies to, if any' } }, ['to', 'subject', 'body'])),
  ],
  calendar: [
    fn('calendar_list_events', 'List calendar events between two dates (ISO 8601). Defaults to the next 7 days.',
      obj({ from: { type: 'string' }, to: { type: 'string' } })),
    fn('calendar_draft_event', 'Prepare a calendar event or invite as a DRAFT. It is NOT added: the person reviews it and presses "Add to calendar".',
      obj({ title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 date-time' }, end: { type: 'string', description: 'ISO 8601 date-time' }, with: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, ['title', 'start', 'end'])),
  ],
}

/**
 * Read-only board tools an agent gets because it already lists a board read
 * (obj 900623). board_briefing reads under exactly the same visibility rule as
 * list_objectives, so an agent file written before it existed (the trial Chief
 * of Staff lists get_objective/list_objectives) gets it without an edit.
 * Write tools are never implied.
 */
const IMPLIED_TOOLS: Record<string, string[]> = {
  list_objectives: ['board_briefing'],
  get_objective: ['board_briefing'],
  // obj 901059: a bot that can file cards can ask the person to decide on one.
  // raise_decision only ASKS (a briefing on the card); it never acts, so it is
  // the one "write" implied: without it the bot asks for decisions in prose,
  // which is exactly what left Operator unable to see what he was approving.
  // obj 901392: a bot that can file cards can also set itself a one-off
  // follow-up to check back on them, instead of asking the person to say
  // "check". A follow-up turn has exactly a normal turn's permissions, so this
  // implies no new reach, only a timer (limits: followups.ts).
  // obj 901764: and it can PROPOSE a breakdown for an outcome the person states.
  // propose_outcome files nothing: the person edits and approves it in the chat,
  // and only their click files the cards (through createCard below).
  create_objective: ['raise_decision', 'followups', 'propose_outcome'],
  // obj 901767: a bot that reads the knowledge base can report a defect it
  // finds there. A flag is a queue row, never a page edit, so this implies no
  // new reach into the knowledge base.
  search: ['flag_knowledge'],
  read_file: ['flag_knowledge'],
}

/**
 * Every agent-file tool name this agent may use: what its file (or its bot-page
 * settings) lists, plus implied reads. `all` / `*` (obj 900671) = every tool
 * this release knows, so an "all tools" bot gains new tools without an edit.
 */
export function effectiveTools(agent: Pick<ChatAgent, 'tools'> & { slug?: string }): string[] {
  // obj 900749: "all" never includes an explicit-only tool (secret use) — it must be named too.
  if (listsAllTools(agent.tools)) return [...ALL_TOOLS_GRANT, ...agent.tools.filter(t => EXPLICIT_ONLY_TOOLS.has(t))]
  const out = new Set(agent.tools.filter(t => KNOWN_TOOL_NAMES.has(t)))
  for (const t of agent.tools) for (const extra of IMPLIED_TOOLS[t] ?? []) out.add(extra)
  // obj 901493: the setup bot always has the app map, whatever its file or bot page lists
  // (an install's own copy of the file was written before the tool existed).
  if (agent.slug && APP_ROUTES_DEFAULT_BOTS.includes(agent.slug)) out.add(APP_ROUTES_TOOL)
  return [...out]
}

/** Does this agent have one agent-file tool (e.g. 'mcp', 'web_search')? */
export function agentHasTool(agent: Pick<ChatAgent, 'tools'> & { slug?: string }, tool: string): boolean {
  return effectiveTools(agent).includes(tool)
}

/** The function specs this agent may call — only what its file lists (plus implied board reads). */
export function toolSpecsFor(agent: ChatAgent): ToolSpec[] {
  const out: ToolSpec[] = []
  for (const t of effectiveTools(agent)) out.push(...(SPECS[t] ?? []))
  return out
}

/**
 * The function specs for one TURN (obj 900972): what the bot's file lists, plus
 * what Full access adds while it counts for this bot, this person and this
 * workspace — the knowledge and board tools it implies, the Full access tool
 * family. Full access NEVER adds the secrets tools.
 * With no Full access this is exactly toolSpecsFor(agent).
 */
export function toolSpecsForContext(ctx: ToolContext): ToolSpec[] {
  const elevated = withFullAccess(ctx)
  const out = toolSpecsFor(elevated.agent)
  out.push(...fullAccessToolSpecs(ctx), ...cardSandboxToolSpecs(ctx), ...cardBrowserToolSpecs(ctx))
  // obj 901347: merge one of the bot's own cards under the person's merge grant.
  // Offered by the grant, never by Full access or "all tools".
  out.push(...grantMergeToolSpecs(ctx))
  // obj 901393: deploy on the owner's word. Offered by its own switch, never by Full access or "all tools".
  out.push(...chatDeployToolSpecs(ctx))
  // obj 901392: schedule / list / cancel the bot's own one-off follow-up wakes.
  out.push(...followupToolSpecs(ctx))
  // obj 901424: Operation Kit Dev's operator tools, behind their one admin switch.
  out.push(...devOpsToolSpecs(ctx))
  return out
}

/** Which agent-file tool name a function belongs to (email_read → email). */
function owningTool(fnName: string): string | null {
  for (const [tool, specs] of Object.entries(SPECS)) if (specs.some(s => s.function.name === fnName)) return tool
  return null
}

// ── knowledge-folder confinement ──

function realOrParent(p: string): string {
  // Resolve symlinks on the longest existing prefix, then re-append the rest.
  let cur = p
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse())
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return p
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Resolve a model-supplied path; throws unless it is inside an allowed folder. */
export function resolveKnowledgePath(ctx: Pick<ToolContext, 'kbRoot' | 'agent'> & { userId?: number; workspace?: string }, raw: string): { abs: string; rel: string } {
  if (ctx.agent.knowledge_folders.length === 0) throw new ToolUseError('This agent has no knowledge folders.')
  const cleaned = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned) throw new ToolUseError('A path is required.')
  const root = realOrParent(path.resolve(ctx.kbRoot))
  const allowedAt = (p: string) => ctx.agent.knowledge_folders.some(f => inside(p, realOrParent(path.resolve(root, f))))
  let abs = realOrParent(path.resolve(root, cleaned))
  // obj 900948: on a workspaces/<ws>/ knowledge base a bot's folders resolve to
  // `workspaces/<ws>/business` etc. (knowledge-folders.ts), while its own
  // instructions still say `business/profile.md`. A short path that is not
  // itself allowed is read as the same path inside THIS chat's workspace folder.
  // Still subject to the folder check below and the workspace wall.
  if (!allowedAt(abs) && ctx.workspace && !cleaned.startsWith('workspaces/')) {
    const aliased = realOrParent(path.resolve(root, 'workspaces', ctx.workspace, cleaned))
    if (inside(aliased, root) && allowedAt(aliased)) abs = aliased
  }
  const allowed = allowedAt(abs)
  if (!inside(abs, root) || !allowed) {
    throw new ToolUseError(`"${cleaned}" is outside this agent's knowledge folders (${ctx.agent.knowledge_folders.join(', ')}).`)
  }
  const rel = path.relative(root, abs).split(path.sep).join('/')
  const denied = kbWorkspaceGuard(ctx).deniedWorkspace(abs)
  if (denied) throw new ToolUseError(`"${rel}" is in the ${denied} workspace, which ${ctx.agent.name || ctx.agent.slug} has no access to.`)
  return { abs, rel }
}

/**
 * The workspace wall on knowledge paths (obj 900797). knowledge_folders are
 * relative to the WHOLE knowledge base, and a workspace's notes are a folder
 * inside it (`workspaces/<slug>`, `<slug>`, or the workspace's vault_path —
 * the same roots lib/kb-workspace-scope.ts uses). A path inside a workspace the
 * bot is not granted is refused, whatever its knowledge_folders say. A path in
 * no workspace (shared notes) is governed by knowledge_folders alone, as
 * before.
 *
 * Given the person (`userId`), a workspace counts only if the person may reach
 * it too — the same person ∩ bot rule as the board. Admins reach every
 * workspace. That holds for an UNRESTRICTED bot as well (review of PR 797): its
 * own list is "every workspace", so the wall is the person's memberships — a
 * member of workspace A never reads or writes workspace B's notes through a
 * bot nobody has restricted yet. Only with no person at all (a caller that
 * passes no userId) is an unrestricted bot left unwalled, as before.
 */
export function kbWorkspaceGuard(ctx: Pick<ToolContext, 'kbRoot' | 'agent'> & { userId?: number }): { deniedWorkspace: (abs: string) => string | null } {
  const botAllow = botWorkspaceAllowlist(ctx.agent.slug)
  if (botAllow === null && ctx.userId === undefined) return { deniedWorkspace: () => null }
  const db = getDb()
  let allow = botAllow ?? []
  if (ctx.userId !== undefined) {
    const user = boardUser({ userId: ctx.userId, agent: ctx.agent })
    allow = user ? visibleWorkspaces(user) : []
  }
  let rows: { slug: string; vault_path: string | null }[] = []
  try {
    rows = db.prepare('SELECT slug, vault_path FROM workspaces').all() as { slug: string; vault_path: string | null }[]
  } catch {
    rows = (db.prepare('SELECT slug FROM workspaces').all() as { slug: string }[]).map(r => ({ ...r, vault_path: null }))
  }
  // Every workspace's root(s), pinned to their real location. A root that is
  // the whole knowledge base (or above it) is not a workspace folder — a
  // vault_path pointed at the KB root would otherwise wall off everything — so
  // it is left out; the more specific folders still decide.
  //
  // A vault_path the scope rule refuses (it overlaps another workspace's
  // folder: inside it, equal to it or containing it — obj 901152) is never a
  // GRANT: it stays in the list as a deny-only wall, so a bot granted that
  // workspace cannot reach another workspace's notes through it, and a path
  // under it is still refused to bots that do not hold its workspace.
  const kb = realpathOrNull(ctx.kbRoot) ?? path.resolve(ctx.kbRoot)
  const roots: { slug: string; root: string; allowed: boolean }[] = []
  for (const r of rows) {
    const scope = workspaceScopeRoots(r.slug, ctx.kbRoot)
    const granted = allow.includes(r.slug)
    for (const root of new Set(scope)) {
      if (containedIn(kb, root)) continue
      roots.push({ slug: r.slug, root, allowed: granted })
    }
    if (r.vault_path && !r.vault_path.includes('\0')) {
      const raw = resolveVaultPath(r.vault_path)
      if (!scope.includes(raw) && !containedIn(kb, raw)) roots.push({ slug: r.slug, root: raw, allowed: false })
    }
  }
  return {
    deniedWorkspace(abs: string): string | null {
      // The DEEPEST workspace folder holding the path decides (a nested or
      // shared folder must not be decided by its parent); a tie is allowed if
      // any workspace sharing that exact folder is granted.
      const real = realpathOrNull(abs) ?? path.resolve(abs)
      let best: { len: number; allowed: boolean; slug: string } | null = null
      for (const r of roots) {
        if (real !== r.root && !real.startsWith(r.root + path.sep)) continue
        if (!best || r.root.length > best.len) best = { len: r.root.length, allowed: r.allowed, slug: r.slug }
        else if (r.root.length === best.len && r.allowed) best.allowed = true
      }
      return best && !best.allowed ? best.slug : null
    },
  }
}

/**
 * The error a bot sees when a knowledge path is missing (obj 900745).
 *
 * A note nobody has written yet — Operation Kit Dev's business/profile.md on a
 * fresh install is the case that bit us — is a normal state, not a dead end. A
 * bare "File … does not exist." let one model stop there ("I don't have a
 * profile for your business yet") while another listed the folders and the
 * board and answered. So the error itself names the next step, using only the
 * tools THIS agent has, so the recovery is the same whichever model answers.
 */
export function missingPathError(ctx: Pick<ToolContext, 'agent'>, kind: 'File' | 'Folder', rel: string): ToolUseError {
  const tools = new Set(effectiveTools(ctx.agent))
  const next: string[] = []
  if (tools.has('list_folders')) next.push('call list_folders (no path) to see which folders and files exist')
  if (tools.has('search')) next.push('search the knowledge folders for the topic')
  const board = ['board_briefing', 'list_objectives'].filter(t => tools.has(t))
  if (board.length) next.push(`use ${board.join(' or ')} to read the board cards`)
  const hint = next.length
    ? ` That is normal for a note nobody has written yet, so do not stop or tell the person you have nothing: ${next.join(', ')}, and answer from what you find.`
    : ''
  return new ToolUseError(`${kind} "${rel}" does not exist.${hint}`)
}

/** attach_image's "kb" source: the same 5 MB cap a pasted chat image gets, checked before reading. */
function readImageFileCapped(abs: string): Buffer {
  let st: fs.Stats
  try { st = fs.statSync(abs) } catch { throw new ToolUseError('That image could not be found.') }
  if (!st.isFile()) throw new ToolUseError('That path is not a file.')
  if (st.size > MAX_IMAGE_BYTES) throw new ToolUseError('That image is too big (5 MB max).')
  try { return fs.readFileSync(abs) } catch { throw new ToolUseError('That image could not be read.') }
}

/** The label under an attach_image "card_artifact" thumbnail: the file name, not the whole card path. */
function cleanArtifactName(relPath: string): string {
  return relPath.split('/').pop() || 'screenshot.png'
}

function walk(dir: string, out: string[], cap: number): void {
  if (out.length >= cap) return
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out, cap)
    else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p)
    if (out.length >= cap) return
  }
}

/** obj 900951: the one-line message a model gets when the search index throws. */
function searchIndexUnavailable(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const reason = raw.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error'
  return `search index unavailable: ${reason}`
}

/**
 * obj 900816: hybrid (keyword + semantic) search confined to THIS bot's knowledge
 * folders and granted workspaces — the same two walls the word search applies.
 */
async function hybridKnowledgeSearch(ctx: ToolContext, q: string, mode: 'hybrid' | 'semantic') {
  const root = path.resolve(ctx.kbRoot)
  const folders = ctx.agent.knowledge_folders.map(f => path.resolve(root, f))
  const guard = kbWorkspaceGuard(ctx)
  const allow = (file: string) => folders.some(f => containedIn(file, f)) && !guard.deniedWorkspace(file)
  let found: Awaited<ReturnType<typeof searchKnowledgeBase>>
  try {
    found = await searchKnowledgeBase(q, { mode, limit: 8, allow, root })
  } catch (err) {
    // obj 900951: a broken index must not look like "nothing found". The caller
    // still runs the word search, and tells the model the index is down.
    return { results: [], index_error: searchIndexUnavailable(err) }
  }
  return {
    results: found.results.map(h => ({
      path: path.relative(root, h.path).split(path.sep).join('/'),
      score: h.score,
      match: h.match,
      ...(h.heading ? { heading: h.heading } : {}),
      snippet: h.snippet.slice(0, 240),
    })),
    mode_used: found.mode_used,
  }
}

function knowledgeSearch(ctx: ToolContext, q: string) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 1)
  if (terms.length === 0) throw new ToolUseError('Search needs at least one word.')
  const root = path.resolve(ctx.kbRoot)
  const files: string[] = []
  for (const f of ctx.agent.knowledge_folders) walk(path.resolve(root, f), files, 2000)
  const guard = kbWorkspaceGuard(ctx)
  const hits: { path: string; score: number; snippet: string }[] = []
  for (const file of files) {
    // obj 900797: a note in a workspace this bot is not granted is never a hit.
    if (guard.deniedWorkspace(file)) continue
    let text: string
    try {
      const st = fs.statSync(file)
      if (st.size > 1_000_000) continue
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // obj 901746: a saved answer held for review is never a hit.
    if (isHeldAnswerText(text)) continue
    const lower = text.toLowerCase()
    const rel = path.relative(root, file).split(path.sep).join('/')
    let score = 0
    for (const t of terms) {
      if (rel.toLowerCase().includes(t)) score += 3
      let idx = lower.indexOf(t)
      while (idx >= 0 && score < 50) { score++; idx = lower.indexOf(t, idx + t.length) }
    }
    if (score === 0) continue
    const at = Math.max(0, Math.min(...terms.map(t => { const i = lower.indexOf(t); return i < 0 ? Infinity : i })) - 80)
    hits.push({ path: rel, score, snippet: text.slice(Number.isFinite(at) ? at : 0, (Number.isFinite(at) ? at : 0) + 240).replace(/\s+/g, ' ').trim() })
  }
  hits.sort((a, b) => b.score - a.score)
  return { results: hits.slice(0, 8) }
}

// ── board ──

function cardUrl(id: number): string {
  return publicCardUrl(id)
}

/**
 * File a card from a chat turn.
 *
 * One path for every bot (obj 900960): the guarded bot-job path (obj 900323).
 * Idempotency enforced, duplicate guard applied, start decided against an
 * explicit finite ceiling, and the origin recorded so the result can come back
 * to THIS conversation. The registry decides only WHO owns the card:
 *
 *  - The agent is a REGISTERED BOT → owner validated against the registry, job
 *    mode pinned to read-only in the card footer.
 *  - The agent is not in the registry → no registry owner (owner_bot is the
 *    bot's own name when it works the card, else empty) and the footer its
 *    cards always had. Before 900960 this was a second, unguarded INSERT, so a
 *    retried tool call filed a duplicate card.
 *
 * The idempotency key is derived, not supplied, because the model cannot be
 * trusted to invent a stable one: it is a content fingerprint of (title, body),
 * so a retried identical tool call collapses onto the same card while a
 * genuinely different ask does not.
 *
 * The THREAD is deliberately not part of the hashed input. The key is only ever
 * looked up together with the thread (`findJobByIdempotency` and the UNIQUE
 * index `uq_bot_job_origins_idem` are both on (thread_user_id,
 * thread_agent_slug, idempotency_key)), so two threads with the same ask still
 * get separate cards. Hashing identity data on top of that bought nothing and
 * was what CodeQL flagged as an insecure password hash (#149, obj 900838): it
 * followed the user record from `userFromApiKey()` into sha256. Only the
 * model-written text is hashed now, which is a fingerprint, not a credential.
 */
export function botJobIdempotencyKey(title: string, description: string): string {
  return crypto
    .createHash('sha256')
    .update(`${title.trim()}\u0000${description.trim()}`)
    .digest('hex')
    .slice(0, 40)
}

/**
 * Where a chat card lands (obj 900797): the chat's workspace, or a named one
 * the person may write to AND the bot is granted. Same refusal whether the
 * workspace exists or not, so the model learns nothing about other boards.
 */
function cardWorkspace(ctx: ToolContext, raw: unknown): string {
  const wanted = typeof raw === 'string' && raw.trim() && raw.trim() !== 'all' ? raw.trim() : ''
  if (!wanted) {
    if (!ctx.workspace) throw new ToolUseError(noWorkspaceMessage(ctx))
    return ctx.workspace
  }
  const user = boardUser(ctx)
  if (!user) throw new ToolUseError('Your account was not found.')
  const options = writableWorkspaces(user, ctx.workspace)
  if (!options.includes(wanted)) {
    throw new ToolUseError(`${ctx.agent.name} can't file cards in "${wanted}". Workspaces it may file in for you: ${options.join(', ') || '(none)'}.`)
  }
  return wanted
}

/**
 * Who works a chat-filed card (obj 900948). The filing bot itself — agent_context
 * = its slug — when it may work in that workspace (it is allowed there AND its
 * slug passes the same workspace agent-pool gate card create/update apply, which
 * a granted bot does). Otherwise the workspace's default agent, as before, so a
 * card is never filed with an agent the board would refuse on its next edit.
 *
 * obj 901026 ("a bot and an agent are the same thing"): a bot whose slug is
 * ALSO a worker persona (a chat bot called `cfo`) now owns its OWN chat-filed
 * cards exactly like any other bot, as long as it is explicitly granted the
 * workspace AND the persona is not one of the five protected default-roster
 * slugs (`personaOwnershipBlocked`, obj 901026 review fix) — without a grant,
 * or for cto/cmo/coo/cfo/general, this still falls back to the workspace
 * default exactly as before 901026, even when the pool would otherwise pass
 * (those slugs are normally IN the pool on their own account). `resolveCardWorker`
 * (prompt-builder-workdir.ts) is what then keeps a genuinely bot-owned card's
 * persona from silently running it: it resolves agent_context to the BOT, not
 * the persona, whenever the grant is what let the slug in.
 */
export function chatCardAgent(agent: Pick<ChatAgent, 'slug'>, workspace: string): { agentContext: string; ownedByBot: boolean } {
  if (
    !personaOwnershipBlocked(agent.slug, workspace) &&
    botMayUseWorkspace(agent.slug, workspace) &&
    checkAgentInWorkspacePool(workspace, agent.slug) === null
  ) {
    return { agentContext: agent.slug, ownedByBot: true }
  }
  return { agentContext: defaultAgentForWorkspace(workspace), ownedByBot: false }
}

/**
 * The model a chat-filed card runs on (obj 900948): the filing bot's own model
 * when it is an enabled board model (cardModelForBot, the same rule High Agency
 * wakes use), else the registry default. Never left to the objectives.model
 * column default, which is a stale literal on old installs.
 */
export function chatCardModel(agent: Pick<ChatAgent, 'model'>): string {
  return cardModelForBot(agent) ?? getDefaultModelId()
}

/**
 * The owner_bot a chat bot OUTSIDE the bot registry puts on its card: its name,
 * else its slug — but never a value the bot registry resolves to a registered
 * bot. owner_bot is matched against the registry by id, name and alias when a
 * bot asks to close a reviewed card, so a registered bot that merely shares
 * this chat bot's display name would otherwise own (and could close) its cards
 * (review of PR 797). With both taken the card is filed unowned; the slug in
 * agent_context still says who works it.
 */
export function chatOwnerBotName(agent: Pick<ChatAgent, 'slug' | 'name'>, db: ReturnType<typeof getDb> = getDb()): string | null {
  for (const candidate of [agent.name, agent.slug]) {
    const v = validateOwnerBot(candidate)
    if (!v.ok || typeof v.value !== 'string') continue
    if (resolveBot(v.value, db).ok) continue
    return v.value
  }
  return null
}

/**
 * The parent a chat card is filed under (obj 900958), and the workspace that
 * follows from it. Same rules as the internal create route, plus the chat's own
 * scope: the parent must be a card this person AND this bot can see (a card in
 * a workspace the bot is not granted reads exactly like a missing one), must be
 * top-level (one level of nesting only), and must be under the child cap. The
 * child lands in the parent's workspace, which still has to be one the bot may
 * file in for this person.
 */
function cardParent(ctx: ToolContext, parentRaw: unknown, workspaceRaw: unknown): { parentId: number | null; workspace: string } {
  if (parentRaw === undefined || parentRaw === null || parentRaw === '') return { parentId: null, workspace: cardWorkspace(ctx, workspaceRaw) }
  const parentId = typeof parentRaw === 'string' && /^#?\d+$/.test(parentRaw.trim()) ? Number(parentRaw.trim().replace('#', '')) : parentRaw
  if (typeof parentId !== 'number' || !Number.isInteger(parentId) || parentId <= 0) throw new ToolUseError('parent_id must be a card number. The card was NOT filed.')
  const notFound = () => new ToolUseError(`Parent card #${parentId} was not found on a board you can see. The card was NOT filed.`)
  try {
    getBoardCard(ctx, parentId)
  } catch (e) {
    if (e instanceof ToolUseError) throw notFound()
    throw e
  }
  const db = getDb()
  const parent = db.prepare('SELECT workspace, parent_id FROM objectives WHERE id = ? AND deleted_at IS NULL').get(parentId) as { workspace: string | null; parent_id: number | null } | undefined
  if (!parent?.workspace) throw notFound()
  const named = typeof workspaceRaw === 'string' && workspaceRaw.trim() && workspaceRaw.trim() !== 'all' ? workspaceRaw.trim() : ''
  if (named && named !== parent.workspace) {
    throw new ToolUseError(`A card filed under #${parentId} lands in that card's workspace (${parent.workspace}), not "${named}". Leave workspace out, or drop parent_id. The card was NOT filed.`)
  }
  const workspace = cardWorkspace(ctx, parent.workspace)
  if (parent.parent_id != null) {
    throw new ToolUseError(`Card #${parentId} is itself filed under #${parent.parent_id}; cards nest one level only. File under #${parent.parent_id} instead, or leave parent_id out. The card was NOT filed.`)
  }
  const open = openChildCount(db, parentId)
  if (open >= CHILD_CAP_PER_PARENT) {
    throw new ToolUseError(`Card #${parentId} already has ${open} open cards under it (the limit is ${CHILD_CAP_PER_PARENT}). Finish or cancel some first. The card was NOT filed.`)
  }
  return { parentId, workspace }
}

/** What create_objective did: filed a card (new or the one already filed), or held back on a possible duplicate. */
export type CreateCardOutcome =
  | { filed: true; id: number; status: string; reused: boolean; will_start: boolean; note: string; workspace: string; parent_id?: number }
  | { filed: false; duplicate: Pick<PossibleDuplicate, 'id' | 'title' | 'status'>; workspace: string }

/** How a bot follows an existing card instead of filing a second one, in the words of the tools it has. */
function followUpHint(ctx: ToolContext, id: number): string {
  const full = fullAccessToolSpecs(ctx).length > 0
  return full
    ? `read it with card_read ${id}, add to it with card_comment, or take it with card_take_over / card_reown.`
    : `check it with get_objective ${id} and tell the person its number; they can add to it on the card.`
}

export function createCard(
  ctx: ToolContext,
  title: string,
  rawDescription: string,
  workspaceRaw?: unknown,
  parentRaw?: unknown,
  opts: { idempotencyKey?: unknown; fileAnyway?: boolean; doneWhen?: unknown; stopConditions?: unknown } = {},
): CreateCardOutcome {
  const db = getDb()
  let given: string | null
  try {
    given = parseFilingKey(opts.idempotencyKey)
  } catch (e) {
    throw new ToolUseError((e as Error).message)
  }
  // obj 901496: the stop conditions become one fixed section of the card text
  // and "done" goes in the board's existing completion goal. With neither
  // given, the description and the idempotency key are exactly what they were.
  const description = composeCardBrief(rawDescription, opts.stopConditions)
  const doneWhen = normalizeDoneWhen(opts.doneWhen)
  const { parentId, workspace } = cardParent(ctx, parentRaw, workspaceRaw)
  // The same protected pull request text check as repo_session_start, for every bot.
  const textRefusal = protectedPrTextRefusal({ slug: ctx.agent.slug, workspace, ability: 'create_objective', title, description, actorUserId: ctx.userId })
  if (textRefusal) throw new ToolUseError(textRefusal)
  const under = parentId != null ? { parent_id: parentId } : {}
  const worker = chatCardAgent(ctx.agent, workspace)
  const bot = botForAgentSlug(ctx.agent.slug, db)
  // The same request under a different parent is a different job, not a replay.
  const fingerprint = botJobIdempotencyKey(title, doneWhen ? `${description}\u0000${doneWhen}` : description) + (parentId != null ? `:p${parentId}` : '')

  // (1) One key per card (obj 901498). The bot's own key wins; the content
  // fingerprint still catches a retry that dropped the key. A key names ONE
  // card: the same key with a different title is refused, never answered with
  // the old card (that would lose the second filing without a word).
  let key = given ? explicitKey(given) : fingerprint
  if (given) {
    const mine = findJobByIdempotency(db, ctx.userId, ctx.agent.slug, key)
    if (mine) {
      const prior = db.prepare('SELECT title FROM objectives WHERE id = ?').get(mine.objective_id) as { title: string } | undefined
      if (prior && titleSimilarity(prior.title, title) < NEAR_DUPLICATE_THRESHOLD) {
        throw new ToolUseError(`idempotency_key "${given}" already belongs to card #${mine.objective_id} ("${prior.title}"). Use a new key for a different card. The card was NOT filed.`)
      }
    } else if (findJobByIdempotency(db, ctx.userId, ctx.agent.slug, fingerprint)) {
      key = fingerprint
    }
  }
  const replay = !!findJobByIdempotency(db, ctx.userId, ctx.agent.slug, key)

  // (2) Search first: an open card with a near-identical title is handed back
  // as a possible duplicate and nothing is filed. Said out loud, with the way
  // through (file_anyway), so it is never a silent block.
  if (!replay && !opts.fileAnyway && isDuplicateGuardEnabled(db)) {
    const dup = findPossibleDuplicate(db, {
      title,
      workspace,
      excludeParentId: parentId,
      visible: id => {
        try { getBoardCard(ctx, id); return true } catch { return false }
      },
    })
    if (dup) {
      recordDedupe({ event: 'duplicate_refused', existingId: dup.id, title, workspace, source: 'chat create_objective (possible duplicate)' })
      return { filed: false, duplicate: dup, workspace }
    }
  }

  // One guarded path for every bot (obj 900960). A bot in the registry owns the
  // card as itself. A bot outside it passes no owner bot: the card's owner_bot
  // is its name when it works the card itself (obj 900948: chatOwnerBotName
  // runs the shape check every owner_bot write uses and falls back to the
  // slug), and a card handed to the workspace default agent stays unowned.
  const r = createBotJob(db, {
    userId: ctx.userId,
    agentSlug: ctx.agent.slug,
    ownerBot: bot ? bot.id : null,
    ...(bot ? {} : { chatBot: { name: ctx.agent.name, ownerBot: worker.ownedByBot ? chatOwnerBotName(ctx.agent, db) : null } }),
    workspace,
    title,
    description,
    idempotencyKey: key,
    completionGoal: doneWhen || null,
    parentId,
    agentContext: worker.agentContext,
    model: chatCardModel(ctx.agent),
    force: !!opts.fileAnyway,
  })
  if (!r.ok) {
    // The board's own same-title guard found a twin this person cannot be shown
    // by title (the search above only names cards on their board).
    if (r.code === 'duplicate' && r.existingId != null) {
      const twin = db.prepare('SELECT id, status FROM objectives WHERE id = ?').get(r.existingId) as { id: number; status: string } | undefined
      if (twin) return { filed: false, duplicate: { id: twin.id, title, status: twin.status }, workspace }
    }
    throw new ToolUseError(r.error)
  }
  const row = db.prepare('SELECT * FROM objectives WHERE id = ?').get(r.objectiveId) as Objective
  if (!r.reused) {
    try {
      broadcast({ type: 'objective_updated', payload: row })
    } catch {
      /* no WS server in tests */
    }
  }
  const id = r.objectiveId
  // (3) Filed is not started. Say which, so the bot never re-files to "start" it.
  const note = r.reused
    ? `This is card #${id}, which you already filed for this request. It is ${row.status}. NOTHING new was filed. Do not file it again; follow this card.`
    : r.start.allowed
      ? `Filed as card #${id} and cleared to start.`
      : `Card #${id} EXISTS on the board. It will NOT start by itself: ${r.start.reason} Do not file it again. It starts when the person presses Start on the card or the queue picks it up; follow it with get_objective.`
  return { filed: true, id, status: row.status, reused: r.reused, will_start: !r.reused && r.start.allowed, workspace, ...under, note }
}

export interface ChatCardStatus { id: number; title: string; status: string; summary: string | null; pr_url: string | null; updated_at: string; url: string }

// ── board reads (obj 900623) ──
//
// Before this, list_objectives / get_objective only read agent_chat_cards, so a
// General asked "what is waiting on me?" saw zero rows and told the
// person the board was empty while their workspace had cards in review. These
// reads now use the board's own visibility rule (visibilityClause):
//   admin                       → every workspace
//   member, visibility 'all'    → every card in that workspace
//   member, visibility 'own'    → cards they created / are assigned to there
//   not a member                → nothing (and naming it is refused)
// The role is re-read from the DB on each call, so a demotion or a removed
// membership takes effect mid-conversation.

/**
 * Who is chatting, as the board's visibility rule needs them, narrowed to the
 * workspaces this BOT is granted (obj 900797): `allowWorkspaces` is the same
 * allowlist an agent key's workspace scope uses, so every board read
 * (visibilityClause, buildAttention) is the person's view ∩ the bot's list.
 * null = no such user.
 */
function boardUser(ctx: Pick<ToolContext, 'userId'> & { agent?: Pick<ChatAgent, 'slug'> }): ControlUser | null {
  const row = getDb().prepare('SELECT id, role FROM users WHERE id = ?').get(ctx.userId) as { id: number; role: string } | undefined
  if (!row) return null
  return { id: row.id, role: row.role, allowWorkspaces: ctx.agent ? botWorkspaceAllowlist(ctx.agent.slug) : null }
}

/** Workspaces the person can read cards in (admins: every workspace on the install), narrowed to the bot's list. */
function visibleWorkspaces(user: ControlUser): string[] {
  const db = getDb()
  const rows = user.role === 'admin'
    ? (db.prepare('SELECT slug AS workspace FROM workspaces ORDER BY slug').all() as { workspace: string }[])
    : (db.prepare('SELECT workspace FROM user_workspaces WHERE user_id = ? ORDER BY workspace').all(user.id) as { workspace: string }[])
  const all = rows.map(r => r.workspace)
  return user.allowWorkspaces ? all.filter(w => user.allowWorkspaces!.includes(w)) : all
}

/**
 * Workspaces a chat card may be filed in: member (or admin) AND granted to the
 * bot. An unrestricted bot (predates access lists) keeps its old behaviour:
 * only the chat's own workspace.
 */
function writableWorkspaces(user: ControlUser, chatWorkspace: string): string[] {
  if (!user.allowWorkspaces) return chatWorkspace ? [chatWorkspace] : []
  return visibleWorkspaces(user)
}

/**
 * The workspaces this bot may work in WITH this person (person ∩ bot list), for
 * the system prompt — never names a workspace the person cannot see. null =
 * an unrestricted bot (no list to state).
 */
export function botWorkspacesForPerson(userId: number, agentSlug: string): string[] | null {
  const user = boardUser({ userId, agent: { slug: agentSlug } })
  if (!user) return []
  if (!user.allowWorkspaces) return null
  return visibleWorkspaces(user)
}

/**
 * The workspaces a bot's knowledge folders may be remapped into for THIS person
 * (knowledge-folders.ts): the bot's granted workspaces — every workspace for an
 * unrestricted bot — ∩ the workspaces the person may reach (admins: all). No
 * such user = none. Re-read per call, so a removed membership applies at once.
 */
export function kbWorkspacesForChat(userId: number | undefined, agentSlug: string): string[] {
  if (userId === undefined) return []
  const user = boardUser({ userId, agent: { slug: agentSlug } })
  return user ? visibleWorkspaces(user) : []
}

/** Validate an optional workspace argument against what the person — and this bot — may read. */
function workspaceArg(user: ControlUser, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const ws = String(raw).trim()
  if (!ws || ws === 'all') return undefined
  if (user.role === 'admin' && !user.allowWorkspaces) return ws
  const mine = visibleWorkspaces(user)
  // Same answer whether or not the workspace exists: no existence oracle.
  if (!mine.includes(ws)) throw new ToolUseError(`You can't see the "${ws}" board from this chat. Boards you can see here: ${mine.join(', ') || '(none)'}.`)
  return ws
}

/** What a workspace-bound tool says when the bot and the person share no workspace. */
function noWorkspaceMessage(ctx: Pick<ToolContext, 'agent'>): string {
  return `${ctx.agent.name} has no workspace it may work in with you. An admin grants workspaces to this bot on its settings panel (Workspace access).`
}

export interface BoardCard {
  id: number
  title: string
  status: string
  workspace: string
  has_blockers: boolean
  ai_review_verdict: string | null
  pr_url: string | null
  updated_at: string
  url: string
  /** True when this chat filed the card. */
  from_this_chat: boolean
}

interface BoardRow { id: number; title: string; status: string; workspace: string; has_blockers: number; ai_review_verdict: string | null; pr_url: string | null; updated_at: string; mine: number }

const BOARD_ROW_SQL = `o.id, o.title, o.status, o.workspace, o.has_blockers, o.ai_review_verdict, o.pr_url, o.updated_at,
  EXISTS (SELECT 1 FROM agent_chat_cards c WHERE c.objective_id = o.id AND c.user_id = ? AND c.agent_slug = ?) AS mine`

function toBoardCard(r: BoardRow): BoardCard {
  return {
    id: r.id,
    title: oneLine(r.title, 160) ?? '',
    status: r.status,
    workspace: r.workspace,
    has_blockers: Number(r.has_blockers) > 0,
    ai_review_verdict: r.ai_review_verdict ?? null,
    pr_url: r.pr_url ?? null,
    updated_at: r.updated_at,
    url: cardUrl(r.id),
    from_this_chat: Number(r.mine) > 0,
  }
}

export interface BoardList {
  /** What was read, in words the model can repeat. */
  scope: string
  workspaces: string[]
  /** Cards per status over everything that matched (not just the returned page); `blocked` = blocker raised. */
  counts: Record<string, number>
  total: number
  cards: BoardCard[]
  truncated: boolean
  /** True only when the board really has no matching card the person can see. */
  empty: boolean
  note?: string
}

/** Cards on the real board that `ctx`'s person can see. Read-only. */
export function listBoardCards(
  ctx: Pick<ToolContext, 'userId' | 'agent'>,
  opts: { workspace?: unknown; status?: unknown; limit?: unknown } = {},
): BoardList {
  const user = boardUser(ctx)
  if (!user) throw new ToolUseError('Your account was not found.')
  const workspace = workspaceArg(user, opts.workspace)
  const status = opts.status === undefined || opts.status === null || opts.status === '' ? undefined : String(opts.status)
  if (status && !(BOARD_STATUSES as readonly string[]).includes(status)) {
    throw new ToolUseError(`status must be one of ${BOARD_STATUSES.join(', ')}.`)
  }
  const n = Math.floor(Number(opts.limit))
  const limit = Number.isFinite(n) && n > 0 ? Math.min(LIST_MAX, n) : LIST_DEFAULT
  const workspaces = workspace ? [workspace] : visibleWorkspaces(user)
  const what = status ? `"${status}" cards` : 'open cards (planning, queue, working, ai_review, review)'
  const where_ = workspace ? `the ${workspace} board` : `the boards you can see (${workspaces.join(', ') || 'none'})`
  const scope = `${what} on ${where_}`

  const vis = visibilityClause(user, workspace)
  if (!vis) {
    return {
      scope, workspaces, counts: {}, total: 0, cards: [], truncated: false, empty: true,
      note: user.allowWorkspaces && user.allowWorkspaces.length === 0
        ? 'This bot has not been granted any workspace, so there is no board it may read. An admin grants workspaces on the bot\'s settings panel.'
        : 'You are not a member of any workspace this bot may use, so there is no board to read.',
    }
  }
  let statusSql: string
  let statusParams: unknown[]
  if (status === 'blocked') {
    statusSql = `o.has_blockers = 1 AND o.status NOT IN ('done', 'cancelled')`
    statusParams = []
  } else if (status) {
    statusSql = 'o.status = ?'
    statusParams = [status]
  } else {
    statusSql = `o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`
    statusParams = OPEN_STATUSES
  }
  const where = `o.deleted_at IS NULL AND ${statusSql} AND ${vis.sql}`
  const db = getDb()
  const countRows = db
    .prepare(`SELECT o.status AS status, COUNT(*) AS n, SUM(CASE WHEN o.has_blockers = 1 THEN 1 ELSE 0 END) AS blocked FROM objectives o WHERE ${where} GROUP BY o.status`)
    .all(...statusParams, ...vis.params) as { status: string; n: number; blocked: number | null }[]
  const counts: Record<string, number> = {}
  let total = 0
  let blocked = 0
  for (const r of countRows) {
    counts[r.status] = r.n
    total += r.n
    blocked += Number(r.blocked) || 0
  }
  if (blocked > 0) counts.blocked = blocked
  const rows = db
    .prepare(`SELECT ${BOARD_ROW_SQL} FROM objectives o WHERE ${where} ORDER BY o.updated_at DESC, o.id DESC LIMIT ?`)
    .all(ctx.userId, ctx.agent.slug, ...statusParams, ...vis.params, limit) as BoardRow[]
  const out: BoardList = { scope, workspaces, counts, total, cards: rows.map(toBoardCard), truncated: total > rows.length, empty: total === 0 }
  if (out.empty) out.note = `There are no ${scope}. This is the real board, not just cards from this chat.`
  else if (out.truncated) out.note = `Showing the ${rows.length} most recently updated of ${total}. Use counts for totals; pass status or workspace to see the rest.`
  return out
}

/** One card, only if the person could open it on the board. Read-only. */
export function getBoardCard(
  ctx: Pick<ToolContext, 'userId' | 'agent'>,
  id: number,
): BoardCard & { summary: string | null; ai_review_findings: string | null } & CardContextExtras {
  const notFound = () => new ToolUseError(`Card #${id} is not on a board you can see.`)
  if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a card number.')
  const user = boardUser(ctx)
  if (!user) throw notFound()
  const vis = visibilityClause(user)
  if (!vis) throw notFound()
  const row = getDb()
    .prepare(
      `SELECT ${BOARD_ROW_SQL}, substr(o.last_session_summary, 1, 1500) AS summary, substr(o.ai_review_findings, 1, 800) AS ai_review_findings,
              o.queue_hold, o.blocked_by, o.owner_bot, o.agent_context, o.session_id
         FROM objectives o WHERE o.id = ? AND o.deleted_at IS NULL AND ${vis.sql}`,
    )
    .get(ctx.userId, ctx.agent.slug, id, ...vis.params) as (BoardRow & CardExtraRow & { summary: string | null; ai_review_findings: string | null }) | undefined
  // A missing card and a card in someone else's workspace read the same.
  if (!row) throw notFound()
  const db = getDb()
  // obj 901277: enough for ANY bot to answer "what did the owner choose on #N",
  // "is it still held" and "who owns it" — without Full access.
  const { owner_bot, owner_grants } = cardOwnerAndGrants(db, { id: row.id, workspace: row.workspace, owner_bot: row.owner_bot, agent_context: row.agent_context })
  return {
    ...toBoardCard(row),
    summary: row.summary ?? null,
    ai_review_findings: row.ai_review_findings ?? null,
    ...holdView(row.queue_hold, row.blocked_by),
    owner_bot,
    owner_grants,
    decisions: cardDecisionsForBot(db, row.id, { full: false }),
    recent_thread: cardThreadForBot(db, { id: row.id, session_id: row.session_id }, { limit: 5, maxChars: 400 }),
  }
}

interface CardExtraRow { queue_hold: string | null; blocked_by: number | null; owner_bot: string | null; agent_context: string | null; session_id: string | null }

/** What get_objective adds on top of the board row (obj 901277). */
export interface CardContextExtras {
  queue_hold: string | null
  blocked_by: number | null
  owner_bot: string | null
  owner_grants: BotCardOwner['owner_grants']
  decisions: BotDecisionView[]
  recent_thread: BotThreadEntry[]
}

/** Card chips for chat messages: only cards the person can still see on the board, in a workspace the bot may still use. */
export function visibleCardStatuses(userId: number, ids: number[], agentSlug?: string): ChatCardStatus[] {
  if (ids.length === 0) return []
  const user = boardUser({ userId, agent: agentSlug ? { slug: agentSlug } : undefined })
  if (!user) return []
  const vis = visibilityClause(user)
  if (!vis) return []
  const rows = getDb()
    .prepare(
      `SELECT o.id, o.title, o.status, o.last_session_summary AS summary, o.pr_url, o.updated_at
         FROM objectives o WHERE o.id IN (${ids.map(() => '?').join(',')}) AND o.deleted_at IS NULL AND ${vis.sql}
        ORDER BY o.id DESC`,
    )
    .all(...ids, ...vis.params) as Omit<ChatCardStatus, 'url'>[]
  return rows.map(r => ({ ...r, url: cardUrl(r.id) }))
}

/** "What is waiting on me": the board's attention brief + column counts, same visibility. */
export function boardBriefing(
  ctx: Pick<ToolContext, 'userId' | 'agent'> & { now?: () => Date },
  opts: { workspace?: unknown; limit?: unknown } = {},
) {
  const user = boardUser(ctx)
  if (!user) throw new ToolUseError('Your account was not found.')
  const workspace = workspaceArg(user, opts.workspace)
  const n = Math.floor(Number(opts.limit))
  const limit = Number.isFinite(n) && n > 0 ? Math.min(50, n) : 20
  const brief = buildAttention(getDb(), user, { workspace, limit, now: ctx.now?.() })
  const board = listBoardCards(ctx, { workspace, limit: 1 })
  return {
    as_of: brief.as_of,
    scope: board.scope,
    workspaces: board.workspaces,
    columns: board.counts,
    open_total: board.total,
    waiting_on_you: brief.items.map(i => ({ ...i, url: cardUrl(i.id) })),
    waiting_counts: brief.counts,
    truncated: brief.truncated,
    empty: board.empty,
    note: board.empty
      ? board.note
      : brief.items.length === 0
        ? `Nothing needs a decision right now, but ${board.total} open card(s) are on the board.`
        : undefined,
  }
}

// ── dispatch ──

function s(args: Record<string, unknown>, key: string, required = false): string {
  const v = args[key]
  if (typeof v === 'string' && v.trim()) return v
  if (required) throw new ToolUseError(`"${key}" is required.`)
  return ''
}

/**
 * The engine's single entry point for a built-in tool call (obj 900671). Web
 * tools are network calls and therefore async; everything else is the
 * synchronous runTool below, unchanged.
 */
/** The mail + calendar tools (obj 901331): async, because a real mailbox is a network call. */
const MAIL_CALENDAR_FNS = new Set(['email_list_inbox', 'email_read', 'email_create_draft', 'calendar_list_events', 'calendar_draft_event'])

/**
 * Read the inbox / calendar and save DRAFTS. There is no send and no insert
 * here, by design: `ctx.connectors` has no such method. Delivery happens only
 * on the person's own click (routes/agent-chat.ts, the drafts send route).
 */
async function runMailCalendarTool(ctx: ToolContext, fnName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const now = ctx.now ?? (() => new Date())
  switch (fnName) {
    case 'email_list_inbox': {
      const mail = ctx.connectors.mail
      if (!mail) throw new ToolUseError('No email account is connected for this bot. Connect Google at Settings → Account → Google Workspace, and check its "Who can use it" list includes this bot.')
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10))
      const msgs = await mail.listInbox(limit, args.unread_only === true)
      return { result: { source: mail.label, messages: msgs }, summary: `Checked inbox (${msgs.length} emails)` }
    }
    case 'email_read': {
      const mail = ctx.connectors.mail
      if (!mail) throw new ToolUseError('No email account is connected for this bot. Connect Google at Settings → Account → Google Workspace, and check its "Who can use it" list includes this bot.')
      const m = await mail.read(s(args, 'id', true))
      if (!m) throw new ToolUseError(`No email with id "${args.id}".`)
      return { result: m, summary: `Read email "${m.subject}"` }
    }
    case 'email_create_draft': {
      const mail = ctx.connectors.mail
      if (!mail) throw new ToolUseError('No email account is connected for this bot. Connect Google at Settings → Account → Google Workspace, and check its "Who can use it" list includes this bot.')
      const draft: EmailDraft = { to: s(args, 'to', true), subject: s(args, 'subject', true), body: s(args, 'body', true), in_reply_to: s(args, 'in_reply_to') || null }
      // obj 901331: a real mailbox also keeps the draft in its own Drafts folder.
      // saveDraft only ever creates a DRAFT; sending stays the person's click.
      if (mail.saveDraft) draft.remote_id = (await mail.saveDraft(draft)).remote_id
      const row = createDraft(ctx.userId, ctx.agent.slug, 'email', mail.id, draft)
      const where = draft.remote_id ? ' It is also in the Drafts folder of the connected mailbox.' : ''
      return { result: { draft_id: row.id, status: 'draft', note: `Saved as a draft. It is NOT sent — the person must press Send.${where}` }, summary: `Drafted email to ${draft.to}`, draft_id: row.id }
    }
    case 'calendar_list_events': {
      const cal = ctx.connectors.calendar
      if (!cal) throw new ToolUseError('No calendar is connected for this bot. Connect Google at Settings → Account → Google Workspace, and check its "Who can use it" list includes this bot.')
      const from = s(args, 'from') || now().toISOString()
      const to = s(args, 'to') || new Date(Date.parse(from) + 7 * 86400_000).toISOString()
      if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new ToolUseError('from/to must be ISO dates.')
      const events = await cal.listEvents(from, to)
      return { result: { source: cal.label, events }, summary: `Checked calendar (${events.length} events)` }
    }
    case 'calendar_draft_event': {
      const cal = ctx.connectors.calendar
      if (!cal) throw new ToolUseError('No calendar is connected for this bot. Connect Google at Settings → Account → Google Workspace, and check its "Who can use it" list includes this bot.')
      const start = s(args, 'start', true)
      const end = s(args, 'end', true)
      if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) throw new ToolUseError('start/end must be ISO date-times.')
      const withList = Array.isArray(args.with) ? args.with.filter((x): x is string => typeof x === 'string') : []
      const draft: EventDraft = { title: s(args, 'title', true), start, end, with: withList, note: s(args, 'note') || null }
      const row = createDraft(ctx.userId, ctx.agent.slug, 'event', cal.id, draft)
      return { result: { draft_id: row.id, status: 'draft', note: 'Saved as a draft. It is NOT on the calendar until the person presses "Add to calendar".' }, summary: `Drafted event "${draft.title}"`, draft_id: row.id }
    }
  }
  throw new ToolUseError(`Unknown tool "${fnName}".`)
}

export async function runChatTool(ctxIn: ToolContext, fnName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  // obj 900948: knowledge folders resolved for this KB's layout (workspaces/<ws>/…).
  // obj 901328: a card wake is confined to the own-card tools, before anything else.
  // obj 901394: with the `chat` tool scope a card wake is a normal turn of this bot
  // for this person, plus the own-card tools. Everything below applies unchanged.
  if (ctxIn.cardWake) {
    // obj 901424: an operator tool asked for in a card wake is refused, under either
    // tool scope (a wake is never the person's browser session); audit the attempt.
    if (DEV_OPS_ALL_FNS.has(fnName)) {
      writeDevOpsAudit({ bot_slug: ctxIn.agent.slug, user_id: ctxIn.userId, username: ctxIn.username, action: fnName, outcome: 'refused', code: 'wake_turn', detail: 'asked for in a card wake' })
      return runCardWakeTool(ctxIn, fnName, args)
    }
    if (ctxIn.cardWake.toolScope !== 'chat' || CARD_WAKE_FNS.has(fnName)) return withSelfAction(ctxIn, fnName, args, () => runCardWakeTool(ctxIn, fnName, args))
  }
  return withSelfAction(ctxIn, fnName, args, () => runChatToolInner(ctxIn, fnName, args))
}

/**
 * obj 901394: bracket a tool call that changes a card, so the objective_events it
 * writes are known to be the bot's own doing and never wake the bot for them.
 */
async function withSelfAction(ctx: ToolContext, fnName: string, args: Record<string, unknown>, run: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  const cardId = Number(args.id ?? args.objective_id ?? args.card_id)
  if (!SELF_ACTION_TOOLS.has(fnName) || !Number.isInteger(cardId) || cardId <= 0) return run()
  const action = beginSelfAction(getDb(), { slug: ctx.agent.slug, objectiveId: cardId, tool: fnName }, ctx.now?.() ?? new Date())
  try {
    return await run()
  } finally {
    endSelfAction(getDb(), action)
  }
}

/** What the model sees after file_answer: a held answer says so, with the reason (obj 901746). */
function fileAnswerOutcome(saved: FiledAnswer): ToolOutcome {
  const held = saved.check.status === 'held'
  return {
    result: { saved: saved.rel, title: saved.title, check: saved.check.status, ...(held ? { kept_out_of_search: true, reason: saved.check.reason } : {}) },
    summary: held
      ? `Saved ${saved.rel}, but it is kept out of search until someone reviews it: ${saved.check.reason}`
      : `Saved the answer to the wiki as ${saved.rel}`,
  }
}

/** file_answer in a chat turn: the answer is checked against its pages by the AI before it is saved (obj 901746). */
async function runFileAnswerChecked(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const tool = owningTool('file_answer')
  if (!tool || !effectiveTools(ctx.agent).includes(tool)) throw new ToolUseError('Tool "file_answer" is not allowed for this agent.')
  if (!ingestEnabled()) throw new ToolUseError('The knowledge base is switched off on this install.')
  if (!ctx.workspace) throw new ToolUseError(noWorkspaceMessage(ctx))
  const now = ctx.now ?? (() => new Date())
  const sources = Array.isArray(args.sources) ? args.sources.filter((x): x is string => typeof x === 'string') : []
  let llm: ReturnType<typeof wikiLlm> | null = null
  try { llm = wikiLlm() } catch { llm = null }
  try {
    return fileAnswerOutcome(await checkAndFileAnswer(workspaceKbRoot(ctx.workspace), {
      question: s(args, 'question', true), answer: s(args, 'answer', true), sources, filedBy: `${ctx.username} (chat: ${ctx.agent.slug})`, now: now(),
    }, llm, { workspace: ctx.workspace }))
  } catch (err) {
    if (err instanceof ToolUseError) throw err
    throw new ToolUseError((err as Error).message)
  }
}

async function runChatToolInner(ctxIn: ToolContext, fnName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const ctx = withKbFolders(ctxIn)
  // obj 900972: the Full access tool family. Checked again inside, on every call.
  if (FULL_ACCESS_FNS.has(fnName)) return runFullAccessTool(ctx, fnName, args)
  if (CARD_SANDBOX_FNS.has(fnName)) return runCardSandboxTool(ctx, fnName, args)
  if (GRANT_MERGE_FNS.has(fnName)) return runGrantMergeTool(ctx, fnName, args)
  if (CHAT_DEPLOY_FNS.has(fnName)) return runChatDeployTool(ctx, fnName, args)
  if (FOLLOWUP_FNS.has(fnName)) return runFollowupTool(ctx, fnName, args)
  if (DEV_OPS_ALL_FNS.has(fnName)) return runDevOpsTool(ctx, fnName, args)
  if (CARD_BROWSER_FNS.has(fnName)) return runCardBrowserTool(ctx, fnName, args)
  if (BOT_MESSAGE_FNS.has(fnName)) return runBotMessageTool(ctx, fnName, args)
  if (fnName === 'secrets_list' || fnName === 'secret_http') return runSecretTool(ctx, fnName, args)
  if (fnName === 'search' && args.mode !== 'keyword' && agentHasTool(ctx.agent, 'search')) {
    // obj 900816: hybrid knowledge search (async: the query is embedded). Falls back
    // to the synchronous word search below when it finds nothing in scope.
    const q = s(args, 'q', true)
    const r = await hybridKnowledgeSearch(ctx, q, args.mode === 'semantic' ? 'semantic' : 'hybrid')
    if (r.results.length > 0) return { result: r, summary: `Searched knowledge for "${q}" (${r.results.length} found)` }
    if ('index_error' in r && r.index_error && agentHasTool(ctx.agent, 'search')) {
      // obj 900951: the index failed. Answer from the plain word search and say so,
      // so an empty list here is never mistaken for an empty knowledge base.
      const kw = knowledgeSearch(ctx, q)
      const warning = `${r.index_error}. These results come from a plain word match over your knowledge folders instead`
        + (kw.results.length === 0 ? '; no results here does NOT mean the knowledge base is empty. Tell the person search is not working right now.' : '.')
      return { result: { ...kw, mode_used: 'keyword', warning }, summary: `Searched knowledge for "${q}" (${kw.results.length} found, search index unavailable)` }
    }
  }
  if (MAIL_CALENDAR_FNS.has(fnName)) {
    const tool = owningTool(fnName)
    if (!tool || !effectiveTools(ctx.agent).includes(tool)) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)
    return runMailCalendarTool(ctx, fnName, args)
  }
  if (fnName === 'file_answer') return runFileAnswerChecked(ctx, args)
  if (fnName !== 'web_search' && fnName !== 'web_fetch') return runTool(ctx, fnName, args)
  if (!agentHasTool(ctx.agent, fnName)) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)
  try {
    if (fnName === 'web_search') {
      const r = await webSearch(args.query ?? args.q, args.limit, ctx.web)
      return { result: r, summary: `Searched the web for "${r.query}" (${r.results.length} found)` }
    }
    const r = await webFetch(args.url, ctx.web)
    let host = r.final_url
    try { host = new URL(r.final_url).host } catch { /* keep the url */ }
    return { result: r, summary: `Read ${r.title ? `"${r.title.slice(0, 80)}" (${host})` : host}` }
  } catch (err) {
    if (err instanceof WebToolError) throw new ToolUseError(err.message)
    throw err
  }
}

// ── bot-to-bot messaging (obj 900859) ──

const BOT_MESSAGE_FNS: ReadonlySet<string> = new Set(['message_bot', 'list_bot_conversations', 'read_bot_conversation'])

/**
 * Where this bot may read and write bot messages in THIS turn: (person ∩ bot),
 * and in a wake only the workspace of the conversation that woke it.
 */
function botMessageScope(ctx: ToolContext): string[] {
  const scope = botMessageWorkspaces(ctx.userId, ctx.agent.slug)
  return ctx.botWake ? scope.filter(w => w === ctx.workspace) : scope
}

/** Every bot on the install, as addressing needs it. Loaded lazily: the engine imports this file. */
async function allBotRefs(): Promise<BotRef[]> {
  const { listAgents } = await import('./engine.js')
  return listAgents().agents.map(a => ({ slug: a.slug, name: a.name }))
}

async function runBotMessageTool(ctx: ToolContext, fnName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!agentHasTool(ctx.agent, 'bot_messages')) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)
  const bots = await allBotRefs()
  const nameOf = (slug: string) => bots.find(b => b.slug === slug)?.name ?? slug
  const scope = botMessageScope(ctx)

  if (fnName === 'message_bot') {
    if (!ctx.workspace && !args.conversation_id && !args.workspace) throw new ToolUseError(noWorkspaceMessage(ctx))
    try {
      const lane = ctx.lane ?? { kind: 'main' as const }
      const r = sendBotMessage({
        from: { slug: ctx.agent.slug, name: ctx.agent.name },
        userId: ctx.userId,
        to: args.to,
        conversationId: args.conversation_id,
        workspace: args.workspace,
        defaultWorkspace: ctx.workspace,
        text: args.text,
        subject: args.subject,
        bots,
        // Inside a wake there is no chat lane to answer into: the reply stays on the thread.
        origin: ctx.botWake ? null : { userId: ctx.userId, agentSlug: ctx.agent.slug, threadId: lane.kind === 'thread' ? lane.id : null },
        wake: ctx.botWake ?? null,
      })
      return {
        result: {
          conversation_id: r.conversation.id,
          message_id: r.message.id,
          to: { slug: r.recipient.slug, name: r.recipient.name },
          workspace: r.conversation.workspace,
          status: 'queued',
          note: ctx.botWake
            ? `${r.recipient.name} will answer on bot conversation #${r.conversation.id}; read it later with read_bot_conversation.`
            : `${r.recipient.name} is being woken now. Its reply will be posted into this chat when it arrives. Tell the person you asked it and that the answer will appear here.`,
        },
        summary: `${r.created ? 'Messaged' : 'Followed up with'} ${r.recipient.name} in ${r.conversation.workspace} (bot conversation #${r.conversation.id})`,
        bot_conversation_id: r.conversation.id,
      }
    } catch (err) {
      if (err instanceof BotMessageRefused) throw new ToolUseError(err.message)
      throw err
    }
  }

  if (fnName === 'list_bot_conversations') {
    const withSlug = typeof args.with === 'string' && args.with.trim() ? args.with.trim() : undefined
    const limit = Math.min(50, Math.max(1, Math.trunc(Number(args.limit) || 20)))
    const rows = listConversations({ workspaces: scope, bot: ctx.agent.slug, withBot: withSlug, limit })
    const conversations = rows.map(c => {
      const other = c.initiator_slug === ctx.agent.slug ? c.recipient_slug : c.initiator_slug
      return {
        conversation_id: c.id,
        workspace: c.workspace,
        with: { slug: other, name: nameOf(other) },
        started_by_you: c.initiator_slug === ctx.agent.slug,
        subject: c.subject,
        messages: c.message_count,
        waiting_for_reply: c.pending,
        failed: c.failed,
        last: c.last_preview,
        last_activity: c.last_message_at,
      }
    })
    return { result: { conversations }, summary: `Listed bot conversations (${conversations.length})` }
  }

  // read_bot_conversation
  const id = Math.trunc(Number(args.conversation_id))
  const c = conversationInScope(id, scope, ctx.agent.slug)
  // Same answer for "no such conversation" and "not yours / not this workspace": no existence oracle.
  if (!c) throw new ToolUseError(`Bot conversation #${args.conversation_id} not found.`)
  const entries = conversationMessages(c, { limit: 100 }).map(m => ({
    id: m.id,
    kind: m.kind,
    from: m.from_slug === ctx.agent.slug ? 'you' : nameOf(m.from_slug),
    ...(m.tool_name ? { tool: m.tool_name } : {}),
    text: m.body.length > MAX_READ_CHARS ? `${m.body.slice(0, MAX_READ_CHARS)}… [cut]` : m.body,
    ...(m.kind === 'message' ? { status: m.status } : {}),
    at: m.created_at,
  }))
  const other = c.initiator_slug === ctx.agent.slug ? c.recipient_slug : c.initiator_slug
  return {
    result: { conversation_id: c.id, workspace: c.workspace, with: { slug: other, name: nameOf(other) }, subject: c.subject, entries },
    summary: `Read bot conversation #${c.id} with ${nameOf(other)}`,
    bot_conversation_id: c.id,
  }
}

/** Same per-person budget as POST /api/secrets-broker/http, shared across both doors. */
const SECRET_USE_RATE = () => Number(process.env.CC_SECRETS_BROKER_RATE_PER_MIN) || 30

/**
 * secrets_list / secret_http (obj 900749) — the chat bot's last mile to the
 * secrets broker. The model only ever handles NAMES: the broker resolves the
 * value in-process, puts it on the outbound request, and redacts it from the
 * reply before the reply becomes this tool's result (which is what the model,
 * the chat history and the UI see). The caller is the chatting person inside
 * the chat's ONE workspace and never an admin view, whatever their role. The
 * workspace comes from the chat, never from the model's arguments.
 */
async function runSecretTool(ctx: ToolContext, fnName: 'secrets_list' | 'secret_http', args: Record<string, unknown>): Promise<ToolOutcome> {
  // obj 900972: for a bot with Full access here, every secret use is a PERMANENT
  // hard exclusion — refused and logged before anything is sent, whatever the
  // bot's file lists. Full access never adds the secrets tool either.
  const fullAccessHere = !!ctx.workspace && fullAccessActive(ctx.agent.slug, ctx.workspace, ctx.now?.())
  if (fullAccessHere) {
    const refusal = exclusionGate({ slug: ctx.agent.slug, botName: ctx.agent.name, workspace: ctx.workspace, userId: ctx.userId, call: secretCallShape(fnName, args), now: ctx.now?.() })
    if (refusal) throw new ToolUseError(refusal)
  }
  if (!agentHasTool(ctx.agent, 'secrets')) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)
  if (!ctx.workspace) throw new ToolUseError(noWorkspaceMessage(ctx))
  const role = (getDb().prepare('SELECT role FROM users WHERE id = ?').get(ctx.userId) as { role?: string } | undefined)?.role
  if (role !== 'admin' && !userHasWorkspace(ctx.userId, ctx.workspace)) {
    throw new ToolUseError(`You are not a member of workspace '${ctx.workspace}', so no secrets are available here.`)
  }
  // obj 901484: this bot's own grants in this workspace add to the workspace-wide Bot access entries.
  const caller = { ...callerForChat(ctx.userId, ctx.workspace), botGrants: botSecretGrants(ctx.agent.slug, ctx.workspace) }
  // obj 900972: a bot that has Full access in ANY workspace never reaches a
  // Shared (install-wide) secret, in any chat. Its file's own secrets tool keeps
  // working here for this workspace's secrets only.
  const noShared = !fullAccessHere && fullAccessAnywhere(ctx.agent.slug, ctx.now?.())
  if (noShared && fnName === 'secret_http') {
    const shared = new Set(listForCaller(caller, { workspace: ctx.workspace }).filter(x => x.scope === 'global').map(x => x.name))
    const hit = (secretCallShape(fnName, args).secretNames ?? []).filter(n => shared.has(n))
    if (hit.length > 0) {
      throw new ToolUseError(refuseExclusion({
        slug: ctx.agent.slug, botName: ctx.agent.name, workspace: ctx.workspace, exclusion: 'secret_values', actorUserId: ctx.userId,
        what: `secret_http with the Shared secret ${hit.join(', ')}`,
      }))
    }
  }
  if (fnName === 'secrets_list') {
    const secrets = listForCaller(caller, { workspace: ctx.workspace }).filter(x => !(noShared && x.scope === 'global')).map(x => ({
      name: x.name,
      description: x.description,
      allowed_hosts: x.allowed_hosts,
      allowed_methods: x.allowed_methods,
      usable: x.usable,
    }))
    const usable = secrets.filter(x => x.usable).length
    return { result: { secrets }, summary: `Listed secret names (${usable} usable, ${secrets.length} total) — no values` }
  }
  if (rateLimit(`broker-use:${ctx.userId}`, SECRET_USE_RATE()) !== null) {
    throw new ToolUseError('Too many secret calls in the last minute. Wait a moment and try again.')
  }
  let outcome
  try {
    outcome = await executeHttp({
      method: args.method,
      url: args.url,
      headers: args.headers,
      body: args.body,
      workspace: ctx.workspace,
    }, caller)
  } catch (err) {
    // Same rule as the REST route: never echo an unexpected error's message —
    // it would land in the chat history and the model's context.
    console.error('[secrets-broker] chat internal error', err instanceof Error ? err.name : 'unknown')
    throw new ToolUseError('The secrets broker hit an internal error. Nothing was sent.')
  }
  recordBrokerUse(outcome, caller, { auth: 'chat', key_last4: `bot:${ctx.agent.slug}`, username: ctx.username })
  const a = outcome.audit
  if (outcome.httpStatus !== 200) {
    // A refusal names secrets/hosts, never a value (executeHttp contract).
    throw new ToolUseError(String((outcome.body as { error?: unknown }).error ?? 'The secrets broker refused this call.'))
  }
  const r = outcome.body as { body?: unknown }
  const text = typeof r.body === 'string' && r.body.length > MAX_READ_CHARS ? `${r.body.slice(0, MAX_READ_CHARS)}… [cut]` : r.body
  return {
    result: { ...outcome.body, body: text },
    summary: `Called ${a.method} ${a.host ?? '?'} with ${a.secrets.join(', ')} (value hidden) → ${a.status}`,
  }
}

/** What a secrets call is aimed at, for the Full access exclusion gate. Reads only names, hosts and paths — never a value. */
function secretCallShape(fnName: 'secrets_list' | 'secret_http', args: Record<string, unknown>): OutboundCall {
  if (fnName === 'secrets_list') return { what: 'listing the secrets this bot may use', usesSecret: true }
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET'
  let host: string | null = null
  let pathname: string | null = null
  const url = typeof args.url === 'string' ? args.url : ''
  try {
    // A {{secret:NAME}} placeholder in the URL must not break parsing of the host.
    const u = new URL(url.replace(/\{\{\s*secret:[^}]*\}\}/gi, 'x'))
    host = u.hostname
    pathname = u.pathname
  } catch { /* an unparsable URL is refused by the broker itself */ }
  const text = [url, typeof args.body === 'string' ? args.body : '', ...(args.headers && typeof args.headers === 'object' ? Object.values(args.headers as Record<string, unknown>).map(String) : [])].join('\n')
  const secretNames = [...new Set([...text.matchAll(/\{\{\s*secret:\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map(m => m[1]))]
  return { what: `secret_http ${method} ${host ?? '(unreadable url)'}${secretNames.length ? ` with ${secretNames.join(', ')}` : ''}`, host, path: pathname, method, secretNames, usesSecret: true }
}

/**
 * obj 900948: the context with the agent's knowledge folders resolved for this
 * knowledge base (a built-in bot's `business` → `workspaces/<ws>/business` on a
 * per-workspace KB; see knowledge-folders.ts). Idempotent.
 */
function withKbFolders(ctx: ToolContext): ToolContext {
  const agent = withResolvedKnowledgeFolders(ctx.agent, ctx.kbRoot, kbWorkspacesForChat(ctx.userId, ctx.agent.slug))
  // obj 900972: while Full access counts, the whole workspace knowledge folder
  // and the knowledge / board tools it implies. Idempotent.
  return withFullAccess(agent === ctx.agent ? ctx : { ...ctx, agent })
}

export function runTool(ctxIn: ToolContext, fnName: string, args: Record<string, unknown>): ToolOutcome {
  const ctx = withKbFolders(ctxIn)
  const tool = owningTool(fnName)
  if (!tool || !effectiveTools(ctx.agent).includes(tool)) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)
  if (MAIL_CALENDAR_FNS.has(fnName)) throw new ToolUseError(`Tool "${fnName}" runs through runChatTool (it may call the connected mailbox).`)
  const now = ctx.now ?? (() => new Date())

  switch (fnName) {
    case 'search': {
      const q = s(args, 'q', true)
      const r = knowledgeSearch(ctx, q)
      return { result: r, summary: `Searched knowledge for "${q}" (${r.results.length} found)` }
    }
    case 'list_folders': {
      const p = s(args, 'path')
      const guard = kbWorkspaceGuard(ctx)
      const kbRootAbs = path.resolve(ctx.kbRoot)
      if (!p) {
        // obj 900797: a knowledge folder inside a workspace the bot is not granted is not shown.
        const declared = ctx.agent.knowledge_folders.filter(f => !guard.deniedWorkspace(path.resolve(kbRootAbs, f)))
        // obj 900951: only folders that are on disk are listed. The declared ones that
        // are not there yet go under `missing`, so the model does not open them one by
        // one and cannot mistake a knowledge base that is not set up for an empty one.
        const isDir = (f: string) => { try { return fs.statSync(path.resolve(kbRootAbs, f)).isDirectory() } catch { return false } }
        const folders = declared.filter(isDir)
        const missing = declared.filter(f => !folders.includes(f))
        const note = missing.length === 0
          ? undefined
          : `The folders under "missing" are set for this bot but do not exist in the knowledge base yet, so there is nothing to read in them.${
            effectiveTools(ctx.agent).includes('write_doc') ? ' write_doc creates a folder when you save the first note into it.' : ''}`
        return { result: { folders, missing, ...(note ? { note } : {}) }, summary: 'Listed knowledge folders' }
      }
      const { abs, rel } = resolveKnowledgePath(ctx, p)
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        throw missingPathError(ctx, 'Folder', rel)
      }
      const items = entries
        .filter(e => !e.name.startsWith('.') && !guard.deniedWorkspace(path.join(abs, e.name)))
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'folder' : 'file' }))
      return { result: { path: rel, items }, summary: `Opened folder ${rel}` }
    }
    case 'read_file': {
      const { abs, rel } = resolveKnowledgePath(ctx, s(args, 'path', true))
      if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) throw new ToolUseError('Only text files (.md, .txt, .csv, .json, .yaml) can be read in chat.')
      let text: string
      try {
        text = fs.readFileSync(abs, 'utf8')
      } catch {
        throw missingPathError(ctx, 'File', rel)
      }
      // obj 901494: a long file is paged, never silently cut. The result says
      // where the next page starts, so a bot can read to the end before it writes.
      const page = pageText(text, offsetArg(args.offset), MAX_READ_CHARS)
      const note = pageNote(page, rel)
      const paged = page.truncated || page.offset > 0
      return {
        result: {
          path: rel,
          content: page.content,
          truncated: page.truncated,
          ...(paged ? { offset: page.offset, next_offset: page.next_offset, total_chars: page.total_chars, note } : {}),
        },
        summary: paged ? `Read ${rel} (characters ${page.offset} to ${page.offset + page.content.length} of ${page.total_chars})` : `Read ${rel}`,
      }
    }
    case 'write_doc': {
      const { abs, rel } = resolveKnowledgePath(ctx, s(args, 'path', true))
      if (!WRITE_EXT.has(path.extname(abs).toLowerCase())) throw new ToolUseError('Only .md, .txt or .csv files can be written.')
      const content = typeof args.content === 'string' ? args.content : ''
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ToolUseError('That file is too large to write from chat.')
      // obj 901746: a bot never releases a held saved answer by rewriting it.
      const heldRefusal = heldAnswerReleaseRefusal(abs, content)
      if (heldRefusal) throw new ToolUseError(heldRefusal)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      noteKbChanged(abs) // semantic index + link graph
      return { result: { saved: rel, bytes: Buffer.byteLength(content) }, summary: `Saved ${rel}` }
    }
    case 'file_answer': {
      if (!ingestEnabled()) throw new ToolUseError('The knowledge base is switched off on this install.')
      if (!ctx.workspace) throw new ToolUseError(noWorkspaceMessage(ctx))
      const sources = Array.isArray(args.sources) ? args.sources.filter((x): x is string => typeof x === 'string') : []
      let saved: FiledAnswer
      try {
        // Rules only on this synchronous path; runChatTool adds the AI check (obj 901746).
        saved = fileAnswer(workspaceKbRoot(ctx.workspace), { question: s(args, 'question', true), answer: s(args, 'answer', true), sources, filedBy: `${ctx.username} (chat: ${ctx.agent.slug})`, now: now() })
      } catch (err) {
        throw new ToolUseError((err as Error).message)
      }
      return fileAnswerOutcome(saved)
    }
    case 'flag_knowledge': {
      if (!ctx.workspace) throw new ToolUseError(noWorkspaceMessage(ctx))
      const cardRaw = args.card_id
      let objectiveId: number | null = null
      if (cardRaw !== undefined && cardRaw !== null && cardRaw !== '') {
        const card = getBoardCard(ctx, Number(cardRaw))
        if (card.workspace !== ctx.workspace) throw new ToolUseError(`Card #${card.id} is in another workspace than this chat (${ctx.workspace}).`)
        objectiveId = card.id
      }
      const { errors, input } = validateKbFlagInput({
        kind: args.kind, subject: args.subject, detail: args.detail, page: args.page,
        suggested_fix: args.suggested_fix, objective_id: objectiveId,
        trace: ctx.lane ? `chat:${ctx.agent.slug}` : null,
      })
      if (!input) throw new ToolUseError(errors.join(' '))
      const out = fileKbFlag(getDb(), input, { workspace: ctx.workspace, source: 'bot', filedBy: `${ctx.username} (chat: ${ctx.agent.slug})` })
      return {
        result: { flag_id: out.flag.id, status: out.flag.status, reused: out.reused, seen_count: out.flag.seen_count, note: 'Flag filed for the Cleanup queue. No page was changed.' },
        summary: out.reused ? `Counted knowledge flag #${out.flag.id} again (${out.flag.kind}: ${out.flag.subject})` : `Flagged knowledge #${out.flag.id} (${out.flag.kind}: ${out.flag.subject})`,
      }
    }
    case 'attach_image': {
      const source = s(args, 'source', true)
      const altText = s(args, 'alt_text') || undefined
      let incoming: IncomingImage
      try {
        if (source === 'kb') {
          const { abs, rel } = resolveKnowledgePath(ctx, s(args, 'path', true))
          incoming = validateImageBytes(readImageFileCapped(abs), rel)
        } else if (source === 'card_artifact') {
          const objectiveId = Number(args.objective_id)
          if (!Number.isInteger(objectiveId) || objectiveId <= 0) throw new ToolUseError('objective_id (a card number) is required for a card_artifact image.')
          // Same person ∩ bot visibility get_objective enforces — a bot cannot read
          // a card's screenshots it could not otherwise see.
          getBoardCard(ctx, objectiveId)
          const relPath = s(args, 'path', true)
          const image = readArtifactImage(objectiveId, relPath)
          incoming = { name: cleanArtifactName(image.path), media_type: image.media_type as IncomingImage['media_type'], data: image.bytes.toString('base64'), bytes: image.bytes }
        } else if (source === 'data') {
          incoming = parseIncomingImages([{ name: s(args, 'path') || undefined, media_type: s(args, 'media_type') || undefined, data: s(args, 'data', true) }])[0]
        } else {
          throw new ToolUseError('source must be "kb", "card_artifact" or "data".')
        }
      } catch (err) {
        if (err instanceof ArtifactError) throw new ToolUseError(err.message)
        if (err instanceof ImageRejected) throw new ToolUseError(err.message)
        throw err
      }
      incoming.alt_text = altText ?? null
      return {
        result: { attached: incoming.name, media_type: incoming.media_type, size: incoming.bytes.length, alt_text: incoming.alt_text ?? null },
        summary: `Attached image ${incoming.name}`,
        images: [incoming],
      }
    }
    case 'create_objective': {
      const title = s(args, 'title', true)
      const card = createCard(ctx, title, s(args, 'description'), args.workspace, args.parent_id, {
        idempotencyKey: args.idempotency_key,
        fileAnyway: args.file_anyway === true,
        doneWhen: args.done_when,
        stopConditions: args.stop_conditions,
      })
      if (!card.filed) {
        return {
          result: possibleDuplicateResult(card.duplicate, { tool: 'create_objective', workspace: card.workspace, followUp: followUpHint(ctx, card.duplicate.id) }),
          summary: `Possible duplicate of card #${card.duplicate.id}: nothing new was filed`,
        }
      }
      return {
        result: { filed: true, id: card.id, status: card.status, workspace: card.workspace, ...(card.parent_id ? { parent_id: card.parent_id } : {}), reused: card.reused, will_start: card.will_start, note: card.note },
        summary: card.reused ? `Card #${card.id} was already filed for this request: ${title}` : `Created card #${card.id}: ${title}`,
        objective_id: card.id,
      }
    }
    case 'propose_outcome': {
      // A proposal waits for the person's click in THIS chat; a wake has nobody watching.
      if (ctx.botWake || ctx.cardWake) throw new ToolUseError('propose_outcome is only for a chat with the person, who approves the breakdown there. Nothing was proposed.')
      const workspace = cardWorkspace(ctx, args.workspace)
      const out = createProposal(getDb() as never, {
        userId: ctx.userId,
        agentSlug: ctx.agent.slug,
        threadId: ctx.lane && ctx.lane.kind === 'thread' ? ctx.lane.id : null,
        workspace,
        raw: {
          outcome: args.outcome,
          card: { title: args.title, brief: args.brief, done_when: args.done_when, criteria: args.criteria, stop_conditions: args.stop_conditions },
          children: args.children,
          suggested_rules: args.standing_rules,
        },
      })
      if (!out.ok) throw new ToolUseError(`Nothing was proposed. Fix these and call propose_outcome again: ${out.errors.join('; ')}`)
      const p = out.row.proposal
      const rules = listRules(getDb() as never, workspace)
      return {
        result: {
          proposal_id: out.row.id,
          workspace,
          cards: 1 + p.children.length,
          standing_rules_in_force: rules.map(r => ({ id: r.id, text: r.text, applies_to: r.applies_to })),
          note: 'The person now sees this breakdown in the chat, can edit any line, and presses "Approve and start". NOTHING is filed until they do; do not file these cards with create_objective. Tell them in one line that it is waiting for their approval. Standing rules in force are added to every card as criteria on approval.',
        },
        summary: `Proposed a breakdown for approval: ${p.card.title}${p.children.length ? ` (${p.children.length} child card${p.children.length === 1 ? '' : 's'})` : ''}`,
        outcome_proposal_id: out.row.id,
      }
    }
    case 'raise_decision': {
      const id = Number(args.card_id)
      // Only a card this person (and this bot) can see — the same rule as get_objective.
      const card = getBoardCard(ctx, id)
      // obj 901453: an option may not promise a deploy / merge the Approve click
      // cannot run. Those tools run only from a message the person types here.
      const wording = chatActionWordingErrors(Array.isArray(args.options) ? (args.options as Array<{ key?: string; label: string; next: string }>) : [])
      if (wording.length) throw new ToolUseError(`The decision was not raised. Fix these and call raise_decision again: ${wording.join('; ')}`)
      const out = raiseDecision(getDb(), {
        objective_id: card.id,
        workspace: card.workspace ?? '',
        source: 'bot',
        agent_slug: ctx.agent.slug,
        briefing: { context: args.context, question: args.question, options: args.options, recommended: args.recommended, recommended_why: args.recommended_why },
      })
      if (!out.ok) throw new ToolUseError(`The decision was not raised. Fix these and call raise_decision again: ${out.errors.join('; ')}`)
      return {
        result: {
          decision_id: out.decision.id,
          card: card.id,
          note: 'The person now sees the briefing on the card and in this chat, can ask you questions in its thread, and picks an option. Do not act on any option until they choose; tell them in one line that the decision is waiting.',
          ...(out.decision.flags.includes('long') ? { warning: 'The briefing is long. Aim for under about 200 words next time.' } : {}),
        },
        summary: `Asked for a decision on card #${card.id}: ${out.decision.briefing.question}`,
        objective_id: card.id,
        decision_id: out.decision.id,
      }
    }
    case 'get_objective': {
      const id = Number(args.id)
      // obj 900972: a bot with Full access in the card's workspace never reads a
      // card that carries a protected pull request, through this tool either.
      const guarded = Number.isInteger(id) && id > 0
        ? (getDb().prepare('SELECT id, workspace, pr_number, pr_url FROM objectives WHERE id = ? AND deleted_at IS NULL').get(id) as { id: number; workspace: string; pr_number: number | null; pr_url: string | null } | undefined)
        : undefined
      if (guarded && fullAccessActive(ctx.agent.slug, guarded.workspace, ctx.now?.())) {
        const refusal = protectedCardRefusal({ slug: ctx.agent.slug, workspace: guarded.workspace, ability: 'get_objective', card: guarded, actorUserId: ctx.userId })
        if (refusal) throw new ToolUseError(refusal)
      }
      const card = getBoardCard(ctx, id)
      return { result: card, summary: `Checked card #${id} (${card.status})`, objective_id: id }
    }
    case 'list_objectives': {
      const r = listBoardCards(ctx, { workspace: args.workspace, status: args.status, limit: args.limit })
      return { result: r, summary: r.empty ? `Board check: no ${r.scope}` : `Listed ${r.cards.length} of ${r.total} board card(s)` }
    }
    case 'app_routes': {
      const r = searchAppMap(args.query)
      return { result: r, summary: appRoutesSummary(r) }
    }
    case 'board_briefing': {
      const r = boardBriefing({ ...ctx, now }, { workspace: args.workspace, limit: args.limit })
      return { result: r, summary: r.empty ? 'Board briefing: no open cards' : `Board briefing: ${r.waiting_on_you.length} waiting on you, ${r.open_total} open` }
    }
  }
  throw new ToolUseError(`Unknown tool "${fnName}".`)
}
