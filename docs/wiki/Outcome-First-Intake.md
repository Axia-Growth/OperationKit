# Outcome-first intake

*obj 901764.* A person says the result they want. A bot proposes how the board will deliver it.
The person edits and approves that proposal in the chat, and the work starts. They never pick
skills, tools or knowledge folders. They own the problem and the definition of done. How the
work gets done is the bot's and the worker's job.

## What the person does

1. In **Bots** (`/chat`), tell a bot that can file cards (the Operator starter, Operation Kit
   Dev, or any bot that lists `create_objective`) what you want, in plain words:
   *"I want a contact form on the website that emails sales, and before-and-after screenshots
   on every PR."*
2. The bot answers with a **Proposed work** panel in the chat:
   - **Your outcome**: your words, kept as written.
   - **The outcome card**: title, brief, **Done when** (one checkable statement) and
     **Acceptance criteria**. An independent reviewer checks the criteria; the worker never
     grades itself.
   - **Parts** (only when the outcome splits into independent pieces): each part is its own
     card with its own done-when and criteria. Parts run in parallel.
   - **Standing rules** for the workspace: rules already saved (tick or untick for these cards)
     and any rule you asked for in this message (tick to save it).
3. Change anything: every line is editable, you can add or remove criteria and parts. The panel
   lists what is missing before you can approve (a card with no done-when or no criterion).
4. Press **Approve and start**. Nothing is filed before that. **Discard** files nothing.

If an open card already looks like the same work, the panel says which one and the button
becomes **File anyway and start**.

## What happens on approve

The server reuses the board's existing paths instead of a second intake system:

| Step | Existing path |
|---|---|
| File each card | `createCard` in `services/agent-chat/tools.ts`, the same guarded path as the bot's `create_objective`: person ∩ bot workspace, protected-PR text check, possible-duplicate guard, idempotency key, bot ownership and model |
| Record the approved breakdown | `objectives.approved_plan` + `plan_approved_at`, the planning stage's own columns; the worker sees it as "Approved Plan (EXECUTE THIS)" |
| Record the bar | `objectives.acceptance_criteria`, which the worker prompt and the AI reviewer already read |
| Run the parts | the parts are filed under the outcome card and registered with `registerFanout` (`services/fanout.ts`); the poller's fan-out tick starts them under its concurrency ceiling |
| Start | the board's own Start (`runStatusChange` → `working`), so the session cap, duplicate-start guard and every other start gate apply |

A line in the chat then says which cards were filed and whether the outcome card started.

## Standing outcome rules

A standing rule is a per-workspace preference, not a skill file. Examples: "before-and-after
screenshots in the pull request", "link the card in every PR".

- Saved only from a person's own click: the **save** tick on the Proposed work panel at
  approval, or `POST /api/agent-chat/outcome-rules` from a signed-in browser. A bot only
  *suggests* a rule (`standing_rules` on `propose_outcome`).
- `applies_to`: `pr` (default: only cards that open a pull request) or `all`.
- On approval each rule that applies is frozen into the card's acceptance criteria as
  `rule-<id>`, so the reviewer grades it by id. A bot cannot forge a `rule-*` criterion: such
  ids are renumbered.
- Every other card in the workspace gets the rules too: `standingRulesPromptLines`
  (`services/outcome-intake.ts`) adds a "Standing outcome rules" block to the worker prompt
  (`buildPrompt`, after the acceptance criteria) and to the reviewer prompt
  (`buildReviewerPrompt`, after the artifact block). A rule already frozen into the card's
  criteria is not repeated. No rules = both prompts are unchanged.
- Removed by an install admin or the person who saved it (soft delete; cards that froze it keep
  their criterion). At most 20 per workspace.

## For bots

- `propose_outcome` is implied by `create_objective` (like `raise_decision`), so no agent file
  needs an edit. The platform prompt tells every such bot to use it when someone states an
  outcome, and never to ask them to pick skills, tools or folders.
- It is refused in a card wake or a bot-to-bot wake: nobody is there to approve.
- The tool result lists the standing rules already in force, so the bot does not propose them
  again.

## API

All under `/api/agent-chat`, behind sign-in.

| Route | Who |
|---|---|
| `GET /outcome-proposals/:id` | the person the proposal was made for (anyone else: 404) |
| `PUT /outcome-proposals/:id` `{proposal}` | that person, signed-in browser (cookie) only |
| `POST /outcome-proposals/:id/approve` `{proposal?, file_anyway?}` | that person, signed-in browser only; never an API key or a bot |
| `POST /outcome-proposals/:id/discard` | that person, signed-in browser only |
| `GET /outcome-rules?workspace=` | members of the workspace, admins |
| `POST /outcome-rules` `{workspace, text, applies_to}` | members, signed-in browser only |
| `DELETE /outcome-rules/:id` | an admin or the rule's author, signed-in browser only |

Tables (`db/schema/outcome-intake.ts`, additive): `outcome_proposals`
(`pending` → `approving` → `approved` | `discarded`; the `approving` claim makes a double click
file nothing twice) and `outcome_rules`. Both are in `SCRUBBED_TABLES`.

The proposal shape and its checks live once in `app/shared/outcome-intake.ts`
(`normalizeProposal`), used by the tool, the routes and the panel.

## What this is not

- Not a subagent or swarm designer: the person approves cards and a done-bar, not a topology.
- Not self-grading: criteria are locked at approval; the AI reviewer (PR cards) or the person
  (review column) grades them.
- Not a parallel board: the cards are ordinary chat-filed cards, owned by the proposing bot.
