# Decision briefings

_obj 901059 · Nov 2026_

## Why

On Nov 15 2026 a bot asked Operator for a decision on a card. He opened the card and
could not see what the decision was. He approved anyway, nothing visibly
happened, and the bot's chat then said "the card is done, reopen it before
sending". He could not tell what he had approved, or whether he had ended the card.

Three things caused it:

1. A decision was a free-text `needs_review` note, or a chat line, with no
   structure. The card did not render it.
2. The chat "Approve" button posted "Approved: go ahead with what you proposed"
   to the card. A finished job card is `done`, so the message route refused it
   with a 409, and the error text read like the send had ended the card.
3. A `done` card never counted as needing anyone, so the decision vanished.

## What a decision is now

A row in `decisions` with a briefing (`shared/decision-briefing.ts`):

| field | rule |
|---|---|
| `context` | 2-3 sentences: where we are, what the decision is for, where it fits |
| `question` | the decision as ONE question (required) |
| `options` | 2-4, each `label`, 1-3 `pros`, 1-3 `cons`, `next` = what happens if chosen (required) |
| `recommended` + `recommended_why` | an option key and one sentence |

Aim for under about 200 words. Past 220 the briefing is accepted and flagged `long`.
A request with no question or fewer than two options is refused (400, `errors`
lists every gap in words a model can act on).

## How it is raised

| who | how |
|---|---|
| a card worker | `POST /api/decisions` with `X-CC-Session-Token: $CC_SESSION_TOKEN` (prompt block: `services/decision-prompt.ts`) |
| a job / High Agency wake | `POST /api/internal/objectives/:id/job-disposition` `{"disposition":"needs_review","decision":{…}}`. A bad `decision` is a 400 and nothing is written. A bare note is still accepted, recorded `incomplete` and shown as "No briefing was given". |
| a chat bot | the `raise_decision` tool (implied by `create_objective`; schema requires every field) |
| an API caller with card access | `POST /api/decisions` |

A new decision on the same card supersedes the open one. A job that later
records `complete` withdraws an unanswered decision.

`raise_decision` is a new default tool for every bot that has `create_objective`
(it is implied by it). That is deliberate and safe: it only ASKS. It writes one
`decisions` row and renders a briefing; it never sends, spends, merges, deploys,
restarts or approves anything. The choice is always the person's, made in the web UI.

## Secrets

Briefings and Q&A are bot-, worker- and person-written text, so a key can end up
in them (a worker echoes one into its context, a person pastes one into a question).

- `decisions` and `decision_messages` are in `SCRUBBED_TABLES`
  (`db/write-scrubber.ts`): every string written to them goes through
  `redactForStorage`, so a known secret value or a high-confidence key shape is
  stored as `[REDACTED:<NAME>]`. Options are also redacted field by field before
  they are serialised to JSON.
- On the way out the same redactor runs again (`redactDecisionText` in
  `services/decisions.ts`) over the whole KB markdown, over the feedback lines that
  go into worker / High Agency / bot prompts, and over the Q&A answer prompt sent
  to the model. So a row written before scrubbing, or with `CC_SCRUB_DB_WRITES=0`,
  still never reaches the knowledge base or a prompt.

## Where it shows

- Top of the card: `CardDecisionPanel` (open decision, else the latest decided one so the outcome stays visible).
- Bot chat: the "Needs you · decision" post renders the briefing (the post text now names the question), and a `raise_decision` tool line renders it too.
- An open decision counts as `needs_you: decision` even on a `done` card, but only while it is still relevant: since obj 901084 a finished card clears its pending decision unless the job ended BY asking. See [Needs you: the decision stack](Needs-You-Decision-Stack.md).
- The Needs you stack (`/needs-you`, top-bar badge) lists every open decision across bots and cards, one at a time.

## Q&A thread

`POST /api/decisions/:id/questions {body}` (`?wait=1` waits up to 60 s). The bot
that raised it answers in the same thread: decision `agent_slug` → card
`owner_bot` → card `agent_context` → the first installed bot. It is ONE model call
with no tools, with the briefing, the thread and the card's text (framed as
untrusted). It never acts. A failure is written into the thread as a plain line,
so a question is never left pending. Choose / Deny stay available beside it.

## Approve / deny and the outcome

`POST /api/decisions/:id/decide {choice: 'A'|…|'deny', note?, reopen?}`.
Only a person signed in to the web UI (cookie) who owns the card, or an admin,
may decide. Agent keys, Bearer JWTs and session tokens get a 403, so a bot
cannot answer its own decision. The choice is sent to the card as a follow-up
under the person's own server-derived sender.

| outcome | when | the person sees |
|---|---|---|
| `sent` | card parked | "You chose B: … Card #N restarted with your choice. Next: …" |
| `queued` | worker mid-turn | "…is mid-run, so your choice is queued and reaches it when this turn ends." |
| `card_done` | card done/cancelled | "…is already done, so nothing was sent yet. Press Reopen and apply." |
| `reopened` | after **Reopen and apply** (`reopen:true`) | "…was done, so it was reopened and your choice sent. Next: …" |
| `recorded` | a deny on a finished card | "…Recorded; it is already finished, so nothing else changes." |
| `failed` | the restart threw (for example a spend ceiling) | "…recorded, but card #N could not be restarted: <reason>" |

Reopen and apply is an explicit human reopen. It clears `terminal_by_human` and
writes an `objective_audit` row (`pathway = decision-reopen-and-apply`).

The plain card message route now answers a done card with
`{code:'card_done', can_reopen:true}` and "Card #N is already finished, so your
message was not sent and nothing changed. Reopen the card first if you want it to
act on this." The chat's legacy Approve/Reply shows that and offers **Reopen and send**.

## Learning log

- Queryable: `GET /api/decisions/log?workspace=&objective_id=&since=&limit=` returns
  the briefing, every question and answer, the choice, whether the recommendation
  was followed, and the outcome. Members only see cards they own.
- Knowledge base: `<workspace KB>/decisions/decision-log.md` is rewritten after
  every raise, question and decision.
- Feedback: `briefingFeedbackLines` puts the recent questions the person had to ask
  into the worker prompt, the High Agency wake brief and the bot system prompt,
  so the next briefing answers them up front. `GET /api/decisions/feedback?workspace=`
  (admin) shows what is being fed back.

## Tests

- `shared/decision-briefing.test.ts`: validation and outcome text.
- `server/src/routes/decisions.test.ts`: raise, Q&A round trip, approve on a live, mid-turn and done card, Reopen and apply, log, KB file, feedback, and a planted secret (built at runtime) redacted in both tables, the KB file, `buildDecisionRequestBlock`, `buildHighAgencyBrief` and the answer prompt.
- `server/src/services/decisions-bot.test.ts`: tool schema, needs-you signal, chat text, prompt.
- `server/src/services/untrusted-boundaries.test.ts` (L): the card's text is framed.
- `client/src/components/decisions/DecisionBriefing.test.tsx`: light and dark rendering (tokens only), Q&A thread, outcome, Reopen and apply, the needs-you post.
