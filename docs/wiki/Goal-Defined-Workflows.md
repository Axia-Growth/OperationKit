# Goal-defined workflows

*Obj 901766. Builds on the workflow engine cards B1–B10 (`docs/design/WORKFLOWS.md`); it rebuilds none of them.*

A workflow is not something you write by hand. You say **what you want done** and **how you will know it
worked**. The engine does the rest: a builder agent writes the steps, the engine self-tests them, you confirm
the checks and approve anything that sends or spends, and from then on it runs on its own. If a run fails, a
repair agent fixes it inside a small budget.

## The path, step by step

| Step | Who | Where | What happens |
|---|---|---|---|
| 1. State the goal | A person or a bot | **New workflow** (board header, or Jobs → Workflows), `POST /api/flows`, MCP `create_workflow` | Goal + **Done when** (plain words), or exact checks. A goal with no end is not accepted in the app. |
| 2. Build | Builder card (B6) | The board | The builder turns "Done when" into deterministic checks (`goal.end_condition.assert`), drafts versions, and runs a dry self-test until it passes, inside `builder.max_iterations`. |
| 3. Self-test | The engine (B5) | Jobs → Workflows → Self-test & publish | The engine, not the model, decides whether the checks hold. Nothing outside is called in a dry run; sends are shown as "would send …". |
| 4. Confirm + approve | The owner, signed in to the app | Same panel | **How we know it worked** lists your words and each check. If the builder wrote the checks, tick **These checks match what I meant by done**. Then tick each step that sends or spends. Publish. |
| 5. Run | The engine | Schedule, webhook, Run now | Every run is graded against the same checks ("Goal not met" shows when they fail). |
| 6. Repair | Repair watcher (B8) | Repair card | A failed run opens a repair inside `budget.repair_usd` (default $2) and `repairs_per_day` (default 3). Safe fixes apply on their own; a change to a send/spend step, to the checks, or to the budget waits for you. |

## Why the checks are a contract

Every self-test and every live run is graded against `goal.end_condition`. If the builder could change it,
"self-test passed" could mean "the builder weakened the test until it passed". So the server pins it
(`services/flow-contract.ts`, columns `flow_definitions.done_when`, `end_condition_json`,
`end_condition_confirmed_by`, `end_condition_confirmed_at`):

- **Checks given with the goal** are pinned as written. A person's are confirmed at once; an agent key's wait
  for a person.
- **Only "Done when" given:** the builder's first accepted draft pins the checks it proposed (unconfirmed).
- **An agent draft** (builder card, agent key, or a chat bot's Full access `workflow_save_draft`) that changes
  pinned checks is refused `409 end_condition_changed` (the builder's refusal still counts as an iteration). The
  same check covers an agent key posting a whole definition for an existing workflow to `POST /api/flows`.
  Rewording an assert's `why` is not a change; the expressions and the judge are.
- **A person's own draft** may change them: those are their words, and they become the confirmed checks.
- **Publish** of agent-written checks that no person has confirmed needs `confirm_end_condition: true`
  (the tick box), else `409 end_condition_unconfirmed`. Publishing pins the checks as confirmed by that person.
  Publishing stays cookie owner/admin only, as before.
- **Repair** (B8) already sends any change to `goal` to the owner; approving such a repair re-pins the new checks.

## What did not change

Runs, step logs, the read-only diagram, the self-test, the send/spend approval at publish, approval `wait`
steps, budgets and the repair watcher are all the B1–B10 code, untouched. There is no visual editor.

## Bots

A bot uses the same path: MCP `create_workflow(workspace, goal, done_when?, end_condition?)` with a
`board:write` key, or `POST /api/flows` from a card session with its `X-CC-Session-Token`. A bot can never
publish, and never confirms checks: both stay a signed-in person's click.
