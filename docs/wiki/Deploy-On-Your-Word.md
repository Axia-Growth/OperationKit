# Deploy on your word

*Card #901393. Decision #34 on card #901383, option C: "Deploy on your word".*

Operation Kit Dev can deploy this install from chat, but only when **you** ask it to,
in that chat, each time. It is off until you switch it on.

## What it does

1. You type "deploy" (or "ship it", "go live") to Operation Kit Dev on the Bots page.
2. Dev calls the tool `deploy_on_owner_word`. The server checks everything again itself
   (below). If all is well it answers with **exactly what goes live**: the pull requests,
   their titles, their card numbers and the mode (frontend / backend / both).
3. The server runs the same health-gated deploy script the owner runs
   (`scripts/self-deploy.sh`): it fast-forwards the live checkout to `main` and, for a
   backend change, restarts the server. If the server does not come back healthy, the
   script rolls back to the commit that was live before.
4. When the server is back, it posts the result into the **same chat thread**: live, or
   rolled back and why, or failed and why. Each card that went live gets a line
   "Deployed by Operation Kit Dev on <you>'s word".

It is a **hot deploy only**: never a container rebuild and never `--force`.

## When it says no

Nothing is deployed, and Dev tells you the reason, when:

| Refusal | Why |
|---|---|
| Switched off | The setting is off (the default). |
| Not your ask | The latest message in the chat is not yours, typed in the browser, in this turn, asking for a deploy. A team member, an API key, another bot, a card wake or a High Agency wake never counts. "Should we deploy?" is a question, not an ask; "don't deploy" is not an ask. |
| Ask already used | One ask is one deploy. Ask again for another. |
| Wrong workspace | The chat's workspace does not own this install's own repo. |
| Migration needed | A waiting change touches `app/server/src/db/**` or a `migrations/` folder (tests excluded). The schema runs at server start, so a restart *is* the migration. Same rule as the "Database migration" flag in **Merged, waiting for deploy** (`lib/migration-paths.ts`). You deploy that one. |
| Rebuild needed | A waiting change touches a `Dockerfile`, `docker-compose` file, `package.json` or a lockfile. You deploy that one with `rebuild`. |
| Dirty or divergent checkout | The live checkout has uncommitted served files or commits that are not on `main` (`runDriftCheck()`). |
| Nothing to deploy | The live checkout is already at `main`. |
| Deploy running | A deploy is in progress, or one ran in the last 3 minutes (shared with auto-deploy's lock). |
| Cards working | The deploy restarts the server and N cards are working. It says how many and does not force. A frontend-only deploy is not blocked by this. |
| Main moved | A newer merge landed between the list you saw and the deploy starting. The script refuses (`CC_DEPLOY_EXPECT_SHA`), so nothing you did not see goes live. |

## Switch it on (owner only)

**Jobs** page (Settings → Platform goes there) → **Merged, waiting for deploy** →
**Deploy on your word** → switch on. Only the owner, signed in in the browser, can change
it (`PUT /api/admin/chat-deploy`; an API key, a bearer token or a team member gets 403).
The same panel shows the last chat deploy and its outcome.

Which bots may offer it: `settings.chat_deploy_bots` (comma-separated chat slugs). No row
means `operation-kit-dev` only.

## Switch it off / roll back

- Switch it off on the same panel. The tool disappears and any call is refused at once.
- A deploy that fails its health check is rolled back automatically by `self-deploy.sh`.
- To undo a deploy that went live but is wrong: revert the pull request on `main` and deploy
  again (from chat, or as you always have).

## What it does not change

- Full access never adds this tool and never stands in for your ask. Merge and deploy grants
  are not consulted.
- `POST /api/internal/deploy`, `auto_deploy_enabled` and `auto_merge_enabled` are unchanged.

## The record

Every call, allowed or refused, is a row in `chat_deploys`: who said so (user id), the chat
thread and message id, the bot, from-commit and to-commit, the pull requests, the mode, the
outcome (`refused` + reason, `started`, `deployed`, `rolled_back`, `failed`) and when the
result was posted back.

## Code

| Piece | File |
|---|---|
| Gates, audit, start, settle | `app/server/src/services/chat-deploy.ts` |
| Chat tool | `app/server/src/services/agent-chat/chat-deploy-tool.ts` |
| Post the result to chat + card lines (host only, 10 s) | `app/server/src/services/agent-chat/chat-deploy-report.ts` |
| Owner switch + last deploy | `app/server/src/routes/admin-chat-deploy.ts`, `DeployWaitingPanel.tsx` (`ChatDeploySection`) |
| "Typed by the owner in the browser" stamp | `routes/agent-chat.ts` → `meta.owner_browser` on the stored message |
| Pinned target | `scripts/self-deploy.sh` (`CC_DEPLOY_EXPECT_SHA`) |
| Table | `app/server/src/db/schema/chat-deploys.ts` |
| Tests | `chat-deploy-tool.test.ts`, `admin-chat-deploy.test.ts` |
