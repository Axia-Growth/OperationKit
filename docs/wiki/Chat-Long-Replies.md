# Long chat replies run in the background

A chat reply that needs many steps (a ten-PR merge pass, a long audit) no longer dies part-way.
It carries on server-side and posts its answer in the same chat. Built by obj 901491.

## What was wrong

A bot chat reply is a loop the server runs: one model call, then the tool calls it asked for,
then the next model call. Two walls cut that loop short:

| Wall | Where | What the person saw |
|---|---|---|
| 8 model rounds per reply | `MAX_STEPS = 8` in `app/server/src/services/agent-chat/engine.ts` (hard-coded, the same for every bot, no setting) | "Couldn't answer. Stopped after 8 steps without a final answer." and no account of the work already done |
| The send request stayed open for the whole reply | `POST /api/agent-chat/agents/:slug/messages` awaited the reply (`routes/agent-chat.ts`). The server has no timeout on it; the proxy in front does (Cloudflare answers 524 after about 100 seconds with no bytes) | "Request failed: 524" while the reply was in fact still running |

A "step" is one model round, not one tool action. A model may ask for several tools in one
round, so a reply with 30 tool lines can fit in 8 rounds, and a reply that takes one tool per
round stops after 8 tool lines. That is why one reply ran "well over 8 tool calls" and the next
stopped at 8. A second message sent mid-reply is queued (obj 900949) and never changes the count.

The other limits on a chat reply, unchanged: one model call may take 180 s
(`AGENT_CHAT_TIMEOUT_MS`, `services/agent-chat/providers.ts`), and the page stops waiting on its
own request after 240 s (`AgentChatPage.tsx`, UI only; the server keeps going, obj 901329).

## What happens now

1. Every chat reply runs under a **budget**: steps and minutes. Default **60 steps, 30 minutes**.
2. The request that sent the message waits a short **foreground** time (default 20 seconds). A
   quick reply is answered in that request, exactly as before (HTTP 200).
3. A reply still working after that is answered **202 with `background: true`**. The reply is
   the same reply: it keeps running on the server, each tool action is stored in the chat as it
   happens, and the final answer is posted as a normal bot message. The page already re-reads a
   lane whose reply is running (every 2 seconds), so the actions and the answer appear by
   themselves, and it shows "Working in the background: step N of up to 60". Leaving the page
   changes nothing.
4. A reply that uses up its steps or its minutes **never ends silently**. It posts a bot message
   (`meta.kind = turn_limit`): what it did (its tool lines), that anything else did not happen,
   and the next step ("send continue"). "continue" starts a new reply with a fresh budget, and
   the model reads the report as history.
5. A server restart kills replies in memory. On the next boot each one is closed with the same
   kind of report in its chat (`meta.kind = turn_interrupted`), which also says the action that
   was running may or may not have gone through.
6. Stop still stops a background reply.

## What did not change (the walls)

The background part is not a second, laxer path. It is the **same turn with the same
`ToolContext`**, so every gate is evaluated as before, on every tool call:

- the bot's tool list, its workspace list and Full access;
- the operator tools (merge, deploy, close, Cloudflare) still need a message an admin **typed in
  the browser** (`browserSession`), and a queued or drained message still never counts;
- `merge_approved_pr` still needs an active merge grant;
- every tool action still writes its own chat row and its own audit row (`dev_ops_audit`,
  delegation audit, Full access audit).

A long reply can do more *steps*. It cannot do anything a short reply could not.

## Settings

| Name | Where | Default | Meaning |
|---|---|---|---|
| Steps per reply / Minutes per reply | Bots → the bot → Settings → **Long replies** (admin, in the browser). `GET\|PUT /api/agent-chat/agents/:slug/turn-limits` (`{max_steps, max_minutes}`, `null` = default; PUT is cookie-admin only, never an API key) | empty | this bot's budget; 8-200 steps, 2-240 minutes |
| `agent_chat_turn_max_steps` | `settings` row | 60 | install default for steps |
| `agent_chat_turn_max_minutes` | `settings` row | 30 | install default for minutes |
| `agent_chat_turn_foreground_seconds` | `settings` row | 20 | how long the send request waits before answering "working on it" (capped at 90, under a proxy's 100) |
| `agent_chat_long_turns_enabled` | `settings` row | on | `'0'` = kill switch: every reply is back on 8 steps and the request waits for it |

All are read when a reply starts. No restart.

## The record

`agent_chat_turn_jobs` has one row per reply that ran under a budget: person, bot, lane, whether
it came from a browser-typed message, the budget, steps and tool actions done, whether it went to
the background, how it ended (`answered`, `limit` + `steps|time`, `stopped`, `failed`,
`interrupted`) and when. Admins see the last ten for a bot in the Long replies section. No message
text is stored there.

`agent_chat_turn_limits` holds the per-bot budget (one row per bot slug; no row = defaults).

Both tables are additive `CREATE TABLE IF NOT EXISTS` (`db/schema/chat-turn-jobs.ts`), created at
boot. No existing table is altered.

## Scope

- Applies to chat replies (the composer, and the queued messages delivered after a reply).
- Bot-to-bot wakes and card wakes keep the 8-step loop. They are already background work with no
  request to time out; giving them the budget is a separate decision.
- The model-written step-limit answer with a Continue button, the "Queued" label and the
  duplicate-send prompt are card #901488. The composer fixes for a dropped request (clearing the
  box, re-attaching) are card #901487. With this change a long reply no longer produces a 524 on
  the send, because the send is answered within the foreground time.

Code: `services/agent-chat/long-turns.ts` (budget, record, report, restart recovery),
`services/agent-chat/engine.ts` (`runModelLoop` budget, `submitMessage` foreground wait),
`client/.../agent-chat/LongRepliesSection.tsx`. Tests: `services/agent-chat/long-turns.test.ts`,
`AgentChatPage.background.test.tsx`, `LongRepliesSection.test.tsx`.
