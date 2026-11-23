# Bot card wakes

When a card that a chat bot owns finishes or needs the bot, the server wakes the bot for a real
turn so it can close the card out. Nobody has to type "check" in the chat.

Built in two steps: obj 901328 (PR 864) added the wake for the "needs its agent" events, and
obj 901394 widened it (more events, normal chat tools, the answer in the main chat, debounce, a cap
that speaks, no self-wakes).

## What a wake is

A card wake is one normal model turn of the bot, run by the server:

- **Who it acts for:** the person the card is assigned to, else who filed it, else the admin who
  switched the bot's High Agency on, else each admin in id order. The first of these who shares the
  card's workspace with the bot is used (`personFor` in `card-wake-routing.ts`).
- **Where it runs:** the bot's pinned **Card wakes** thread in that person's chat with the bot.
  The bot's final answer is also posted in the **main chat** (`meta.kind = card_wake_reply`), so the
  person sees it without opening the thread.
- **What the bot is told:** the card number, why it was woken, the card's current status, review
  verdict, PR link, and the worker's latest result. Card text is inside an untrusted-content frame.
- **What it can do:** what the bot can do in a normal chat turn with that person, plus the
  own-card tools (`my_cards`, `my_card_read`, `my_card_set_status`, `my_card_message`,
  `my_supervisor_flags`). No new powers. A wake is never the owner's approval of a merge, a deploy,
  a production migration or a decision. A standing grant counts exactly as it does in chat (the
  merge tool appears only if the person holds an active merge grant for the bot).

## Which events wake the bot

| Event on a card the bot owns | Wake kind | Since |
|---|---|---|
| Enters review (incl. AI review passed) | `review` | 901328 |
| AI review failed | `failed_review` | 901328 |
| Worker raised a blocker, or the reviewer could not verify | `blocked` | 901328 |
| Worker stalled or died (stall watchdog flagged it) | `stalled` | 901328 |
| Worker is waiting on a secret | `needs_secret` | 901328 |
| Done without passing through review | `completed` | 901328 |
| Pull request merged | `pr_merged` | 901328 |
| Signed off out of review (review → done) | `completed` | 901394 |
| The worker asked the owner for a decision | `decision_raised` | 901394 |
| The owner answered a decision and the worker did not get it (card already finished, or the resume failed) | `decision_answered` | 901394 |

Not woken: an answer the worker itself received (`sent`, `queued`, `reopened`: the card moves on and
its next state wakes the bot), a decision the bot raised itself, a High Agency wake card the bot
works itself asking the owner, `cancelled`.

## Limits and settings

All are rows in the `settings` table, read at point of use (no restart).

| Setting | Default | What |
|---|---|---|
| `bot_card_wake_debounce_seconds` | `60` | A new wake waits this long. Every wake of the same bot, person and workspace that is due inside the window is answered in ONE turn. `0` = no wait. |
| `bot_card_wake_max_per_hour` | `12` | Wake TURNS per bot per hour. Over it, the event is kept as a `skipped` row and ONE plain line is posted in the person's chat (at most one line an hour). `0` = no cap. |
| `bot_card_wake_window_minutes` | `10` | One turn per card per window. A later event waits for the window to end (it is not dropped). |
| `bot_card_wake_tools` | `chat` | `own_cards` = the turn has only the own-card tools (the obj 901328 scope). |
| `bot_card_wake_post_to_chat` | on | `0` = the answer stays in the Card wakes thread. |
| `bot_card_wakes_enabled` | on | `0` = the whole in-product path is off; card events go to webhooks as before. |

Per bot: **Card wakes** on the bot's settings panel (`GET|PUT /api/agent-chat/agents/:slug/card-wakes`,
PUT is admin browser session only). No row = on.

## Safety rules, and where each is enforced

- **No loops.** Every tool call through which a bot changes a card (`SELF_ACTION_TOOLS` in
  `card-wake-routing.ts`) is bracketed in `runChatTool`: the `objective_events` id range it wrote is
  stored in `bot_card_wake_self_actions`. An event inside a range is kept as a `skipped` row
  (`self_caused`). GitHub's later confirmation of a merge the bot made is covered for 15 minutes.
  Each event id is UNIQUE in `bot_card_wakes`, so a replay never queues twice.
- **Durable.** A wake is a database row. A restart or hot deploy loses nothing; a wake that came due
  while the server was down runs once. A wake that was mid-turn is reclaimed when its lease ends.
- **Lost access.** At run time the route is resolved again. Bot switched off, workspace revoked,
  card deleted, owner changed, person gone: the wake is `skipped` with the reason, and logged.
- **Untrusted card text.** Title, latest result and decision text reach the model inside the
  `<<<UNTRUSTED-CONTENT …>>>` frame (`frameAndScan`).

## Code

- `services/agent-chat/card-wake-routing.ts`: routing, settings, the outbox, self actions, the cap line.
- `services/agent-chat/card-wakes.ts`: the drain, batching, the turn, the decision scan.
- `services/agent-chat/card-wake-tools.ts`: the own-card tools.
- `services/agent-webhooks.ts`: the enqueue tick (`classifyNeed`, `classifyCompletion`, `classifySignedOff`).
- `db/schema/bot-card-wakes.ts`: `bot_card_wakes`, `agent_chat_card_wakes`, `bot_card_wake_self_actions`.
- Tests: `card-wakes.test.ts` (901328 scope), `card-wakes-closeout.test.ts` (901394).

## History

The 2026-11-16 decision "no immediate bot wake when the owner answers a decision on a finished
card" (cost: "it spends money on a click") was reversed on 2026-11-17 at the owner's request. The
cost concern is handled by the debounce, the batch and the hourly cap.
