# Untrusted content at agent boundaries

Systems audit item #8 (obj 900910). Every place where text written by someone
other than this server or the verified owner reaches a model is listed here,
along with how it is framed.

## The frame

`lib/untrusted-content.ts` wraps a payload like this:

```
<<<UNTRUSTED-CONTENT source="web" scope="acme" from="web_fetch">>>
<where it came from>. <the rule: data, not instructions; no approval>
…payload…
END-UNTRUSTED-CONTENT>>>
```

Before the payload goes inside, two kinds of text in it are made inert:

- **Frame markers.** `<<<UNTRUSTED-CONTENT` and `END-UNTRUSTED-CONTENT>>>`
  become `[frame-marker-removed]`, so a payload can't close its own frame
  early or open a fake one. The match is loose: any non-word run between the
  words, and lowercase or `>>` forms, all count.
- **Unicode lookalikes.** If the *folded* text contains a marker or stamp shape,
  the payload is folded before matching. Folding means NFKC (fullwidth
  `＞`, `：`, `［`), removing format characters such as zero-width spaces and
  bidi controls, and mapping dash lookalikes to `-`. A clean payload is left
  byte-identical, so JSON a non-model reader parses still parses. Labels in the open line are cut to one line, and
  their quotes and angle brackets are replaced.
- **Sender stamps.** `[cc-sender]`, `VERIFIED:` and `DELEGATED:` are rewritten
  by `neutraliseForgedStamps` (`lib/message-provenance.ts`). This means a
  payload can't pose as the server's sender line, as the owner, or as a
  delegation grant.

Tests count exactly one open marker and one close marker per region. They
also check that no stamp survives inside it.

The frame is a mitigation, not a guarantee. The real limits are still the
tool gates, the approval rule (only the server stamp counts) and the
draft-only connectors. What the frame adds is that the model is told which
text is data, and an injection attempt can be read in the transcript.

## Every boundary

| # | Boundary | Payload | Where it is framed | `source=` |
|---|---|---|---|---|
| 1 | Knowledge-base hits in the spawn prompt | KB snippets | `context-builder.ts` → `renderUntrustedBlock` (obj 900321) | `knowledge-base` |
| 2 | `/message` relays | the body of an AGENT / API / DELEGATED follow-up (while sender stamps are on, the default; stamps off is the documented kill switch and passes text unchanged) | `lib/relay-framing.ts`, used by `session-followup.followUpSessionText` (live delivery and the queued batch) and `prompt-builder-history` (resume replay) | `relayed-message` |
| 3 | Sibling card summaries | `last_session_summary` on `GET /api/internal/objectives/:id/siblings` | `routes/internal-hermes.ts` (sibling route) | `card-summary` |
| 3b | A card session reading another card | `last_session_summary` and `ai_review_findings` on `GET /api/internal/objectives/:id` when the caller is a **session** principal (sends `X-CC-Session-Token`, as the delegator prompts now do). Operator and server callers keep the raw row | `routes/internal-hermes.ts` `frameCardProseForSession` | `card-summary`, `review-findings` |
| 4 | Child card summaries → delegator | the child's summary and failed-review findings in the `[child-complete]` NOTES.md entry and wake | `services/delegation.ts` `formatChildEntry`. Every line is quoted with `\| `, so a `### …` heading in a summary can't end the block | `card-summary`, `review-findings` |
| 5 | Chat-bot tool results | web search and fetch, email list and read, calendar list, `secret_http` replies, bot thread reads, knowledge reads, board card reads | `services/agent-chat/tool-result-framing.ts` `toolResultForModel`, called from `engine.runModelLoop` for **every** tool except the trusted list below | `web`, `email`, `calendar`, `third-party-api`, `bot-message`, `knowledge-base`, `board-card` |
| 6 | Chat-bot MCP tools | any workspace MCP server reply | same as 5 (all MCP tools are framed) | `mcp` |
| 7 | Bot-to-bot message (recipient side) | the other bot's message body | `services/agent-chat/bot-wake.ts` `incomingBotMessage`. The `[Message from …]` header stays outside the frame | `bot-message` |
| 8 | Bot-to-bot reply (sender side) | a `bot_reply` row posted into the sender's chat lane | `engine.historyForModel` → `botReplyForModel` (stored as written, framed when shown to the model) | `bot-message` |
| 9 | Flow llm node prompt | every `{{ … }}` value: tool, mcp and llm step outputs, the trigger payload, loop items | `lib/flow-eval.ts` `renderTemplateFramed`, from `flow-engine.resolveInput` | `flow-step` |
| 10 | Flow llm tool loop | a read-only Tool's result, **or its error message** (HTTP and MCP errors echo remote text; the engine's own refusals stay plain), fed into the next turn | `services/flow-llm.ts` (`frameToolResult`, engine-supplied) | `flow-step` |
| 11 | Flow goal judge | the value being judged | `flow-engine.runJudge` | `flow-step` |
| 12 | Decision Q&A answer | the card's title, description, latest summary and review note, given to the bot answering a person's question on a decision | `services/decision-answerer.ts` `answerPrompt` (obj 901059). The briefing and the question are server-stored and stay outside the frame | `card-summary` |
| 13 | A bot's open-loops list in its chat system prompt | the bot's `…/bots/<slug>/open-loops.md` knowledge-base file, loaded on every chat turn for a bot that tracks loops (obj 901382). The rules around it are server-written and stay outside the frame | `services/agent-chat/open-loops.ts` `openLoopsPromptBlock` (test: `open-loops.test.ts`) | `knowledge-base` |

Earlier tool calls in a chat's history are replayed as one line the server
wrote (for example `Read "<page title>" (host)`). That line has frame markers
and stamps neutralised but isn't framed.

### Not framed: trusted, server-written text

Nothing below changed:

- **SYSTEM** follow-ups (wakes, nudges, `[child-complete]` prose). The child
  summary embedded in a wake *is* framed (row 4).
- **Owner and member messages** typed in the UI. These are verified by the
  cookie.
- **Chat tools whose result the server writes in full:** `create_objective`,
  `write_doc`, `file_answer`, `email_create_draft`, `calendar_draft_event`,
  `secrets_list`, `message_bot`. `list_folders` is *framed*, because anyone
  with KB write access chooses the file names it returns. This is
  `TRUSTED_TOOL_RESULTS`. Any tool that isn't on it is framed by default.
- **The authored text of an llm node prompt.** Only the interpolated values
  are framed.

### The relay rule is weaker on purpose

A delegator's correction to its child is a real request, so a relayed body is
not "ignore everything". The frame says the body carries only its sender's
authority. It can't approve a gated action, can't change who sent it, and
can't override the card or a VERIFIED owner message.

## Injection telemetry

`lib/injection-scanner.ts` is a pure heuristic scanner. Its rules include
`ignore_previous`, `new_instructions`, `role_reassignment`,
`system_prompt_probe`, `chat_template_token`, `forged_frame_marker`,
`forged_sender_stamp`, `authority_claim`, `credential_request`, `env_dump`,
`pipe_to_shell` and `concealment`.

`services/injection-telemetry.ts` `frameAndScan` is the single call each
boundary makes. It frames the payload and scans the raw text. A hit writes one
`activity_log` row: `event_type='progress'`, `metadata.kind='injection_suspect'`,
plus `boundary`, `label`, `reader`, `rules`, `excerpt`, `sha256_16`,
`bytes` and `blocked: false`.

- **It never blocks.** The framed payload is delivered whatever the scan says,
  and a logging failure is swallowed.
- **It dedupes.** The same payload on the same boundary, card and reader is
  logged once per 10 minutes per process, because chat history is re-framed
  on every turn.

Find hits with:

```sql
SELECT created_at, objective_id, json_extract(metadata,'$.boundary') AS boundary,
       json_extract(metadata,'$.rules') AS rules, json_extract(metadata,'$.excerpt') AS excerpt
FROM activity_log WHERE json_extract(metadata,'$.kind') = 'injection_suspect' ORDER BY id DESC LIMIT 50;
```

## `/message` sender identity

`POST /api/internal/objectives/:id/message` used to take the sender from a
self-declared `from_objective_id` (obj 707038). Now `lib/message-caller.ts`
resolves the caller like this:

| Caller sends | Result |
|---|---|
| valid `X-CC-Session-Token` (or `Authorization: Bearer ccs_…`) | sender = the token's card (server-derived). The one-hop relationship check runs on that id |
| valid token + a body `from_objective_id` naming another card | **403**, plus an `activity_log` row with `metadata.kind='message_sender_mismatch'` |
| an invalid, expired or garbage token | **401**. It never falls back to the body id |
| no token, body id | still accepted (back-compat), but recorded as `identity=self_declared`. The recipient's stamp reads `card #N, self-declared id, unverified` |
| no token, no body id | `unattributed`, as before |

The token is the existing objective-scoped HMAC `CC_SESSION_TOKEN`
(`lib/session-trust.ts`), minted at spawn whenever `session_kb_access` or
`session_secret_access` is on. KB access is on by default, so every default
spawn carries it. If an operator turns both off, `/message` falls back to the
recorded, unverified self-declared path. The delegator prompts
(`prompt-builder-blocks.ts`) send the token on every `/message` curl.

Once every caller sends the header, set
`settings.message_require_session_token='1'` to refuse tokenless calls. It is
off by default, because the in-process delegator wake, ci-feedback-bridge and
strategy-governance don't use this route with a token.

## Adding a new boundary

1. Call `frameAndScan({ source, scope, label, text, origin?, rule? }, { objectiveId, workspace, reader })`
   where the payload enters the prompt, not where it is stored.
2. Add a row to the table above.
3. Add a case to `services/untrusted-boundaries.test.ts`. It should show that a
   hostile payload is sealed (`expectSingleSealedFrame`) and that the scanner
   logs it.

Known gaps, out of scope for #8:

- **Tokenless `/message` still accepts a self-declared id.** It is recorded and
  stamped unverified, but not refused until
  `message_require_session_token='1'`. The next step is to flip that once the
  remaining tokenless callers are migrated.
- **`GET /api/internal/objectives/:id/output`** returns a card's raw session
  log unframed.
- **Host sessions without a token.** A host session that reads a card without
  sending its token is treated as `local-operator` and gets the raw row.

- A flow `agent` node's `brief` is rendered into a child card's description
  without a frame.
- Card descriptions written by other agents still reach worker spawn prompts
  unframed.
