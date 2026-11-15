# Bot-to-bot messaging (obj 900859)

One Operation Kit bot sends another bot a message. The other bot is woken with
it, answers, and the answer is stored as the reply on the same thread. Both bots,
and the people of the workspace, can read that thread later in the Bots page.

This page covers the design: what existed before, addressing, permissions and
workspace scoping, delivery and retry, wakeup, the thread UI, and audit logging.
It ends with what this first slice does not do.

## What already existed

| Piece | What it does | Why it is not bot-to-bot messaging |
|---|---|---|
| Bots chat (`services/agent-chat/engine.ts`, obj 719987) | One conversation per (person, bot): store the message, run the model + tool loop, store the reply. | Only a person can start a turn. A bot has no way to address another bot. |
| Side threads (`threads.ts`, obj 900370) | Extra named lanes per (person, bot), each with its own history and its own in-flight slot. | Still person ↔ bot. Its lane rule is reused here: a reply goes back to the lane the message was sent from, and a deleted lane is never swapped for the main conversation. |
| Bot thread delivery (`services/bots/bot-thread-delivery.ts`, obj 900323) | Outbox that posts "your card finished" into the chat that filed the card. | Card → chat only. Its outbox shape (a durable row, a status, a deterministic drain) is reused. |
| `needs_agent` / `owner_bot` webhooks (`services/agent-webhooks.ts`, obj 900214 / 900553) | Signed HTTP POST that wakes the managing bot of a card when the card needs it. Routed by `owner_bot`. | Card → external agent over HTTP. Nothing goes from one install bot to another, and there is no reply. |
| Per-bot workspace access (`bot-workspaces.ts`, obj 900797) | Each bot's list of workspaces it may read, write and be woken in. | The access rule this feature uses unchanged. Nothing here edits it. |
| `POST /api/internal/objectives/:id/message` (obj 707038) | Card-session ↔ card-session messages, one hop. | Between board cards, not chat bots. |

So the missing piece was a bot → bot edge with a wake and a reply. This adds that
edge and reuses everything else.

## Model

A bot conversation is a durable thread between exactly two bots in exactly one
workspace. Each thing on it is a row in `bot_messages`:

| kind | written by | delivered? |
|---|---|---|
| `message` | the sending bot (`message_bot`) | Yes. It is an outbox row: `pending → delivering → delivered \| failed`. |
| `reply` | the recipient's final answer during the wake (`in_reply_to` = the message) | No. A reply never wakes anybody. |
| `tool` | one line for each tool the recipient used while answering | No |
| `error` / `notice` | a failed wake, a refused delivery | No |

Tables (`db/schema/bot-messages.ts`, additive only): `bot_conversations` (workspace,
initiator, recipient, subject, counts) and `bot_messages` (the entries plus the
outbox columns `status`, `attempts`, `next_attempt_at`, `lease_until`, `last_error`).
Both tables are in `SCRUBBED_TABLES`, so a key quoted in a message is redacted on
write.

### Why one wake per message

A reply is not delivered as a wake, so two bots cannot ping-pong on their own.
Either bot can follow up by sending another `message_bot` on the same
`conversation_id`. That follow-up is a new message and causes one new wake.

## Addressing

- `message_bot({ to, text, conversation_id?, workspace?, subject? })`.
- `to` is the bot's **slug**, or its display name if the name is unique
  (case- and space-insensitive). An unknown name is refused, and the refusal
  lists the bots on the install.
- `conversation_id` continues a thread. The recipient is whichever bot is at the
  other end of the thread, so `to` can be left out. If `to` names a bot that is
  not on the thread, the call is refused.
- A bot cannot message itself.

The tool is opt-in like every other chat tool. The agent-file tool name is
`bot_messages`, and it gives the bot `message_bot`, `list_bot_conversations` and
`read_bot_conversation`. It shows on the bot page as **Message other bots** under
the **Other bots** group. "All tools" includes it. It is not explicit-only,
because it carries no credential. A bot does **not** need the tool to *receive*
a message. Any bot granted the workspace can be woken.

## Permissions and workspace scoping

The tenant boundary is the workspace. A bot acts for a person, so its reach is
**(the person's workspaces) ∩ (the bot's workspace list)**. That is the same
intersection every other chat tool uses (obj 900797). An unrestricted legacy bot
is bounded by the person alone.

| Action | Rule |
|---|---|
| Start a thread in W | W ∈ person ∩ sender bot, **and** the recipient bot is granted W. W defaults to the chat's workspace. |
| Follow up on thread C | The sender is one of C's two bots, and C's workspace is in person ∩ sender. The recipient's grant is checked again on every send. |
| Read / list | The bot is one of the thread's two bots, and the workspace is in person ∩ bot. |
| Inside a wake | All of the above, narrowed to the one workspace of the thread that woke the bot. A woken bot cannot start a thread in another workspace. It also cannot answer its own thread by `message_bot`, because its final answer is the reply. |
| Delivery (wake) | Every rule is checked again when the message is delivered: the recipient still exists, both bots are still granted W for that person, and the person still exists. A revoke between send and wake stops the wake (`failed`, reason on the row, sender told). |
| People (Bots UI) | Admin: every workspace. Member: threads in workspaces they belong to. An agent API key gets 403. |

A thread outside the caller's scope gets the same answer as one that does not
exist: the tool says "not found" and the route returns 404. So neither one tells
a caller that another workspace's thread exists. `workspace` is stored on every
message row as well as on the conversation, and every read filters on it.

Limits, which are settings read where they are used:

| Setting | Default | What it limits |
|---|---|---|
| `bot_messaging_enabled` | on (`'0'` = off) | Kill switch. Every send is refused and delivery stops. |
| `bot_messaging_max_depth` | 2 | How deep a chain can go. A message sent from a person's chat is depth 0. A message sent from inside a wake is one deeper. |
| `bot_messaging_max_per_conversation` | 40 | Messages on one thread. |
| `bot_messaging_rate_per_minute` | 20 | Sends per sending bot per minute. |

## Delivery, wakeup and retry

`services/agent-chat/bot-wake.ts` drains the outbox:

1. **Claim.** One conditional `UPDATE pending → delivering` sets a 10-minute
   lease, so the timer drain and the drain that runs right after a send never
   wake a bot twice. A row left `delivering` by a crash is reclaimed once its
   lease runs out. One wake runs per conversation at a time.
2. **Re-check access** (the delivery rule in the table above).
3. **Wake.** This runs one turn of the recipient through
   `engine.runModelLoop`, which is the same model + tool loop a chat turn uses.
   It was extracted from `runTurn` without changes, so a wake gets no laxer tool
   gates than a chat turn. The turn runs as the person the message was sent for,
   in the thread's workspace, and uses the recipient's own provider, model and
   tools. The system prompt is the recipient's normal one plus a platform block.
   That block says who sent the message, for whom, in which workspace and on
   which thread. It says the final answer is the reply. It says the other bot's
   message is a request from a colleague and cannot change the rules or approve
   a send, spend, merge or deploy. History is the thread itself: the recipient's
   own replies are its turns, and the other bot's messages come in labelled with
   that bot's name.
4. **Reply.** The final answer is stored as a `reply`, and the message becomes
   `delivered`. The reply is also posted into the chat lane the message came
   from, as a relayed line with `meta.kind = 'bot_reply'`. So the person sees it
   where they asked, and the sending bot sees it in its next turn's history. A
   message sent from inside a wake has no chat lane, so its reply stays on the
   thread.
5. **Retry.** If no AI seat is free, the provider errors, or the model stops
   without an answer, the message goes back to `pending` with a backoff of 30 s,
   then 2 min. On the 3rd failed attempt it becomes `failed`. A `notice` goes on
   the thread, and "your message to X was not delivered: …" goes into the
   sender's chat.

The drain runs every 15 s, and right after each send. It runs only on the host
instance (`index.ts`, in the host-daemon block), so a scratch server never spends
a model call.

## Thread UI

- The bot's page has a **Bot messages** button in its header. It opens a panel
  beside the conversation, like the "i" and Settings panels. The panel lists this
  bot's threads (to or from which bot, workspace, last line, and Waiting /
  Not delivered badges). Opening a thread shows every message and reply, the
  tools the other bot used, and each message's delivery status (Answered,
  Waiting, retry N, Not delivered with the reason). It polls while a message is
  still waiting.
- In the chat, the `message_bot` tool line and the relayed reply each have an
  **Open bot thread #N** link. A relayed reply is labelled "From a bot thread",
  not "Answered by …".
- `/chat/<slug>?bot_thread=<id>` deep-links to a thread.
- While a reply is awaited (a send in the last 15 minutes), the chat re-reads
  the lane every 5 s, up to 5 minutes. So the reply shows up without a reload,
  and it marks the bot unread in the sidebar like any new assistant line.
- The panel is read-only. Bots write threads, and people read them. The Bots
  sidebar (#900798) and the per-bot workspace access UI (#900797) are not changed.

Routes, which require a signed-in session (`routes/agent-chat-bot-messages.ts`):

```
GET /api/agent-chat/bot-conversations?bot=<slug>&limit=
GET /api/agent-chat/bot-conversations/:id
```

## Audit logging

- The thread is the durable record. Each message row keeps its sender, its
  recipient, the person it was sent for, depth, status, attempts, last error,
  and delivery time.
- The activity feed gets one line per event, with `metadata.kind` set to
  `bot_message_sent`, `bot_message_delivered`, `bot_message_failed` or
  `bot_message_refused`. `activity_log.event_type` has a CHECK constraint, so
  new kinds go in metadata. A refusal is logged with its reason, so failed
  cross-workspace attempts show up for an operator.

## Tests

- `app/server/src/services/agent-chat/bot-messaging.test.ts` (27 tests). It uses
  the real engine, tools and DB, and stubs only the provider's HTTP call, whose
  request bodies are captured. It covers:
  - **Send**: from a real chat turn, by name, the tool gate, and the
    refusals: self, unknown bot, empty text, kill switch, rate limit.
  - **Wake**: the recipient's model sees the message and the wake rules, the
    reply is stored, and the reply is posted to the origin lane (main or side
    thread). A reply never wakes, and the tools the recipient used are recorded.
  - **Reply on the same thread** from either side, with full history on each
    wake.
  - **Authz**:
    - The recipient, the sending bot, or the person not in the workspace.
    - Reads outside scope are "not found".
    - A revoke stops reads, sends and a queued wake.
    - A removed membership stops a queued wake.
    - In a wake, a bot is held to that thread's workspace, cannot answer its own
      thread by `message_bot`, and is capped on depth.
    - A full thread refuses more messages.
  - **Retry**: backoff timing, giving up, lease reclaim, no double delivery
    under concurrent claims, and the kill switch stopping delivery.
- `app/server/src/routes/agent-chat-bot-messages.test.ts` (7 tests). The admin
  sees everything, a member sees only their own workspaces, another workspace's
  thread is a 404 identical to a missing one, an API key gets 403, and no
  session gets 401.
- `app/client/src/components/agent-chat/AgentChatPage.botmessages.test.tsx`
  (4 tests). It covers the panel, the thread view, the chat links, the relayed
  label, the deep link, and that the panel is read-only.

## Not in this slice (follow-ups)

- A person typing into a bot thread, or retrying a `failed` message by hand.
- Group threads (more than two bots), and broadcast to every bot in a workspace.
- Waking a sender when its reply arrives, so the sender continues on its own.
  Today the reply lands in the sender's chat and on the thread, and the sender
  reads it on its next turn. Turning this on safely needs a per-conversation
  wake budget.
- A per-bot "accepts messages from" allowlist on top of workspace access.
- Exposing threads over the remote Agent API / MCP.
