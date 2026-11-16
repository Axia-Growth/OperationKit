# Needs you: the decision stack

_obj 901084 · Nov 2026 · builds on [Decision briefings](Decision-Briefings.md) (PR 815)_

## Why

Operator's bot chat showed "NEEDS YOU · NEEDS A DECISION" for card #901076 with no
decision under it. He pressed Approve and got "This card is done. Reopen it before
sending a message." The ask had outlived its card and stayed behind as a dead
button. Decisions were also spread across card pages and bot chats, with no one
place to work through them.

## Stale asks clear themselves

`services/decision-queue.ts` → `staleReasonFor` decides whether an open decision
still needs the person:

| card | the open decision is |
|---|---|
| working / review / queue | live |
| cancelled | cleared: `no longer needed (card cancelled)` |
| deleted | cleared: `no longer needed (card deleted)` |
| done, closed by a person (`terminal_by_human`) | cleared: `no longer needed (card closed by a person)` |
| done, job did not end with `needs_review` | cleared: `no longer needed (card finished)` |
| done, job ended with `needs_review`, but a newer run of the same routine exists | cleared: `no longer needed (a newer run of this job replaced it)` |
| done, job ended with `needs_review` (it finished BY asking) | **live**: the one case that shows **Reopen and apply** |

An already-answered `card_done` decision carries `can_reopen` (GET routes and the decide reply): it turns false once the same rule calls the ask stale, the button disappears, and a `reopen:true` on it is a `409 decision_stale` that leaves the card closed.

Clearing = `state='withdrawn'` with that reason, plus a line in the decision's
thread ("Cleared automatically: … nothing was sent"). Nothing is sent to the card.

Where it runs:

- the status route, the moment a card goes `done` / `cancelled` (`clearStaleDecisionsForCard`)
- the poller, every 15 s (`maybeSweepStaleDecisions`, before the needs-you pass, so that pass drops the chat post too)
- every `GET /api/decisions/queue` read
- `POST /api/decisions/:id/decide` on a stale ask: `409 {code:'decision_stale', reason, decision}` with
  "This decision is no longer needed (card finished), so nothing was sent and nothing changed."

**Legacy asks.** A job that parked on `needs_review` before PR 815 has no decision
row. The sweep adopts the recent ones (updated in the last 7 days, still live by
the rule above) as flagged decisions, once per card, so they reach the queue with
"No briefing given — ask the bot".

**Bot chat.** Stored chat rows are never rewritten. At read time
(`resolveNeedsYouMessages`, called from the chat history route):

- a needs-you post whose card ended, or whose decision was cleared, gets
  `meta.resolved = {reason, text}` and renders as ONE line ("Was: Needs a decision ·
  #N title · Resolved: no longer needed (card finished).") with no buttons
- a decision post with no `decision_id`, or a superseded one, is pointed at the
  card's current open decision
- approval / ceiling / blocker posts resolve as soon as the card ends
- a live decision post that has no decision record says "No briefing given — ask
  the bot what it needs before you choose."

## The queue

`GET /api/decisions/queue` → `{items, count, cleared}`; `GET /api/decisions/queue/count` → `{count}`.
A person's queue only: an agent key or a worker token gets 403. Visibility is the
decide route's rule: an admin sees every open decision, a member sees cards they
created, are assigned to, or are an assignee on. `?workspace=` narrows it.

Each item is the full `DecisionView` (briefing + thread), its card (id, title,
status, workspace, project, bot + bot name) and an `urgency`:

- `blocking` (Work stopped): the card is parked, queued, or a job finished by asking
- `running` (Still running): the card is `working`; the answer steers it

Order: urgency (blocking first), then age (oldest first), then id
(`compareQueueItems` in `shared/decision-queue.ts`).

## The stack page (`/needs-you`)

Top bar: a stack icon with the count (hidden at 0, `9+` past nine) beside the
notifications bell, desktop and phone. It refreshes every 30 s, on window focus,
and whenever a decision is answered in this tab (`cc:needs-you-changed`).

The page shows ONE decision at a time with the rest peeking out behind it:
urgency, card, bot, workspace, age → **Where things stand** (context) → **The
decision** (question) → options with pros, cons and what happens next → the
recommendation → Approve / Deny / Skip / Back. A **Q&A side thread** (the same
component as the card and the chat, `DecisionQA`) sits beside it.

After a choice the one-line outcome from PR 815 shows, then the decision that
was behind it slides in (1.8 s, or at once with → / Enter). A `card_done` result
(a job that ended by asking) shows **Reopen and apply** and waits. A stale ask
says so and moves on.

| key | action |
|---|---|
| Enter | approve the recommendation (or "approve as proposed" with no briefing) |
| 1-4 | choose option A-D |
| D | deny, with an optional note |
| S, J, → | skip to the next |
| K, ← | back to the previous |
| Q, / | ask the bot a question |
| O | open the card |
| ? | show the shortcuts |

Shortcuts pause while typing in a box; Esc leaves the box. The table lives in
`STACK_SHORTCUTS` (shared), which the page, the help dialog and the tests all read.

## Tests

- `server/src/routes/decision-queue.test.ts`: auto-clear on finish (status route, sweep,
  person-closed, deleted, newer run), the job-that-ended-by-asking exception, the stale
  decide guard, the queue count / order / visibility, legacy adoption, chat resolution.
- `shared/decision-queue.test.ts`: order, stack navigation, after-answer, shortcuts, no-briefing.
- `client/src/components/decisions/NeedsYouPage.test.tsx`: stack render (light and dark,
  tokens only), Skip / Back with keys and buttons, option key → outcome → next, Enter,
  Deny with note, Reopen and apply, stale, Q&A side thread, shortcuts dialog, badge
  count, resolved chat post, no-briefing chat post.
