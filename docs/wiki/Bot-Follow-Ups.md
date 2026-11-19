# Bot follow-ups ("check back in N minutes")

obj 901392. Code: `app/server/src/services/agent-chat/followups.ts` (store, limits, the three tools) and `followup-wake.ts` (the drain). Table: `bot_followups` (`app/server/src/db/schema/bot-followups.ts`). Tests: `services/agent-chat/followups.test.ts`, `routes/agent-chat-followups.test.ts`, client `agent-chat/FollowupLine.test.tsx`.

## What it is

A chat bot could only act when the person typed, or on its High Agency wake (every 1 to 2 hours). So after starting a card from chat it had to ask the person to come back and say "check".

Now the bot can set itself a one-off timer. When it is due, the bot is woken in the same chat, checks what it said it would check, and posts its answer. The person does not type anything.

## The tools

A bot has them when its tool list includes `followups`. Any bot that lists `create_objective` gets `followups` automatically (the same way it gets `raise_decision`), so an existing bot file needs no edit. "All tools" includes it. It can be unticked on the bot's settings page.

| Tool | Arguments | Returns |
|---|---|---|
| `schedule_followup` | `in_minutes` (whole number, 2 to 1440), `note` (what to check and what to do then, up to 1,000 characters), optional `card_id`, optional `when_card_changes` (needs `card_id`) | the follow-up `id`, `fires_at` (ISO time) and `fires_at_server_time` (HH:MM) |
| `list_followups` | none | the follow-ups waiting in this chat |
| `cancel_followup` | `id` | confirmation |

The tools exist only in a chat turn (and in a follow-up turn, which is one). A card wake and a bot-to-bot wake never have them.

`when_card_changes: true` fires early, as soon as the card changes status, PR, review verdict, job result or last summary. Otherwise it fires at the time limit. The drain compares a fingerprint of those fields every 15 seconds; `updated_at` is deliberately not part of it.

## What happens when it fires

1. The drain (host only, every 15 seconds and once at boot) claims the row.
2. It re-checks that the follow-up may still run (see "Dropped" below).
3. It runs `engine.runTurn`: the same function a typed message runs, in the same chat (main conversation or the side thread it was set in), for the same person.
4. The chat gets one line "Follow-up #N fired: <note>" and then the bot's answer.

The model is handed the bot's own note and, with `card_id`, the card's current status, PR link, title and latest result. The note and the card text reach it inside untrusted-content frames (`docs/security/untrusted-content.md`, row 14).

If a turn is already running in that chat, the follow-up waits 30 seconds and tries again. If no AI seat is free it retries after 30 seconds, then 2 minutes; after the third try it is marked failed and the chat gets one line saying so.

## Safety rules

- **No new powers.** The turn is an ordinary chat turn. Its tools, workspace access, Full access and standing grants are whatever a typed turn would have at that moment, re-read when it fires. Nothing in the follow-up code builds a tool list or a permission. The test compares the tool list of a typed turn and a follow-up turn, with and without a merge grant, and they are identical.
- **Never the owner's approval.** No chat row is stored as if the person had typed it. The platform rules for the turn say the note is not the person and never approves a merge, a deploy, a prod migration, a send, a spend or a decision.
- **Limits.** At most 5 follow-ups wait in one chat (`settings.bot_followups_max_pending`). A follow-up turn may schedule another, but a chain stops after 6 in a row without a message from the person (`settings.bot_followups_max_hops`); the bot is then told to say it has stopped and why. Both are read at point of use, no restart.
- **Restart safe.** A follow-up is a database row. One that came due while the server was down fires once on the first drain after boot. One the server died in the middle of is taken back when its 15-minute lease runs out (three attempts at most).
- **Dropped, and logged,** when: the bot was deleted, the bot no longer has the `followups` tool, the person no longer exists, the side thread was closed or deleted, the chat was cleared, or the chat would no longer run in the workspace the follow-up was set in (the bot or the person lost it).
- **The note is stored text.** `bot_followups` is in `SCRUBBED_TABLES`, so a secret-shaped value is redacted before it is stored. The note is shown to the person.

Kill switch: `settings.bot_followups_enabled = '0'` hides the tools and parks the drain. Waiting follow-ups stay as they are.

## What the person sees

- In the chat: **Follow-up scheduled for HH:MM: <note>** with **Cancel**. After it ran, was cancelled or was dropped, the same line says so and has no button.
- On the bot's **Activity** tab: "Follow-ups in your chat", the person's own follow-ups with that bot (waiting, ran, cancelled, dropped, failed).
- In the install activity log: `metadata.kind` = `bot_followup_scheduled`, `bot_followup_fired`, `bot_followup_cancelled`, `bot_followup_dropped`, `bot_followup_failed`, `bot_followup_refused`.

Routes (a signed-in person only, never an agent key): `GET /api/agent-chat/agents/:slug/followups` (the caller's own), `DELETE /api/agent-chat/agents/:slug/followups/:id` (Cancel; someone else's or an already finished one is a 404). `GET …/messages` carries `followups`: the state of each follow-up a line in view points at.

## Not changed

The High Agency wake schedule and how `routine_update` treats it are untouched. A follow-up is not a routine and does not file a card.
