# Chat bots never file the same card twice (obj 901498)

Two chat tools file a card: `create_objective` (every bot) and `repo_session_start`
(Full access). Both go through one guard, `services/agent-chat/card-filing-guard.ts`.
No new table, no migration.

## What a bot sees

| Situation | Result of the tool call | Cards on the board |
|---|---|---|
| Same call again (same `idempotency_key`, or the same words with no key) | `filed: true, reused: true`, the first card's number, its current status | 1 |
| An open card in the same workspace has a near-identical title | `filed: false`, `possible_duplicate: {id, title, status, url}`, and a note: use that card, or call again with `file_anyway: true` | unchanged |
| The card was created but did not start (session cap, no time limit set, twin running) | `filed: true`, `started: false` / `will_start: false`, note "Card #N EXISTS … has NOT started … Do not file it again" | 1 |
| The same key used for a different title | refused: "idempotency_key … already belongs to card #N" | unchanged |

## The three rules

1. **One key per card.** Both tools take an optional `idempotency_key` (1-120
   characters, no spaces). With none, the server derives one: a fingerprint of the
   title and description (plus the project for a repo session, the parent for a
   child card). Keys are per person and bot. `create_objective` keeps its key on
   `bot_job_origins` (obj 900323), with no time limit. `repo_session_start` cards
   have no origin row, so its keys are rows in the existing `idempotency_keys`
   table under the scope `chat-bot:<slug> repo_session_start <workspace>`; the
   server prunes those at boot once they are a day old. A key whose card was
   deleted is forgotten.
2. **Search first.** `findPossibleDuplicate` compares the new title with every
   open card (not done, not cancelled, not deleted) in the workspace, with no time
   window. Titles match at 0.8 or more (`titleSimilarity`): equal after the board's
   own normalisation, or sharing 80% of their words after dropping filler words
   and folding plain plurals. Titles that differ in a number ("Phase 2" / "Phase
   3") never match. `create_objective` only names cards the person can see on
   their board; an exact same-title twin they cannot see is still held back, by
   number. Nothing is filed until the bot says `file_anyway: true`. Each hold is
   one `activity_log` row, `metadata.kind = 'duplicate_refused'`. The existing
   kill switch `settings.duplicate_guard_enabled = '0'` turns the search off (keys
   still work).
3. **Filed is not started.** A replay never starts anything. A card that exists
   and has not started is started later (`card_restart`, or Start on the card).

## Not built, and why

- **A key derived from the chat turn and the tool call's position.** A re-run of
  a turn may call the tools in a different order, so position can point at the
  wrong card, and storing the turn on the card needs a new column. The content
  fingerprint plus the title search cover the same retries without either.
- **A re-sent chat message running a second reply** is card 901488 (PR 918).
  This guard is what keeps that second reply, if it happens, from filing again.

Tests: `services/agent-chat/card-filing-guard.test.ts` (retry, near-duplicate,
failed start, for both tools).
