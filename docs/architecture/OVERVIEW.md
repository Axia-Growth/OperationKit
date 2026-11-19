# Architecture overview

A map for someone opening this repository for the first time. It covers three things: what
happens to a card from creation to merge, where code lives in `app/server/src`, and where to
put a new piece. For the frozen HTTP / status / database surface see
[CONTRACTS.md](./CONTRACTS.md); for the full inventory of routes, services and timers see
[MODULES.md](./MODULES.md).

Operation Kit is one Node process (Express + WebSocket, run with `tsx`) over one SQLite
database. It supervises AI coding sessions; it does not do the coding itself. The board
(`objectives` table) is the source of truth. A session saying "done" is a claim that the
server then checks.

## Life of a card

A card is a row in `objectives`. In code it is an `Objective`; on screen it is a "card"
([glossary](../glossary.md)). Its `status` moves through
`planning → queue → working → ai_review → review → done` (or `cancelled`), and every move is
checked against the transition tables in `app/shared/workflow.ts` (per card type) and
`VALID_TRANSITIONS` in `app/shared/types-runtime.ts`.

| Step | What happens | Where |
|---|---|---|
| 1. Create | A person, a bot or a schedule creates the row. Duplicate titles in the same workspace are refused, depth is derived from the parent. | `routes/objectives-crud.ts` (browser, API key), `routes/internal-create.ts` (sessions), `lib/objective-dedupe.ts`, `lib/objective-depth.ts` |
| 2. Start | Moving the card to `working` goes through `runStatusChange`, which calls `startSession`. The session cap (`MAX_CONCURRENT_SESSIONS` in `app/shared/types-core.ts`) and a one-live-session-per-card lease are enforced here. | `routes/objectives-status.ts`, `services/session-start.ts`, `services/objective-session-claim.ts`, `lib/session-cap.ts` |
| 3. Isolate | The server creates a git worktree and branch for the card before anything is spawned, so a session never edits the checkout the server runs from. | `services/session-worktree.ts` (`ensureWorktree`) |
| 4. Prompt | `buildPrompt` assembles the card text, workspace context, memory files, trust rules and git workflow into one prompt. | `services/prompt-builder.ts`, `services/prompt-builder-blocks.ts` |
| 5. Spawn | The coding agent CLI is started with a filtered environment, either in a tmux session or in a per-card container (jail mode). Its output is appended to a JSONL transcript. | `services/session-spawn-env.ts`, `services/session-spawn-command.ts`, `services/session-tmux.ts`, `services/session-jail.ts` |
| 6. Watch | The state poller ticks every few seconds: is the session alive, did it end, did it hit a limit, does it need a retry. The browser gets changes over WebSocket. | `services/state-poller.ts` (timer), `services/poller-loop.ts` (`pollActiveSessions`), `services/poller-worker.ts`, `services/stream-parser.ts`, `ws/index.ts` |
| 7. Review | When the worker ends, the card moves to `ai_review` and a separate reviewer session grades the branch against the acceptance criteria. It never sees the worker's private notes. Fail sends the card back to `working` (capped); pass moves it to `review` for a person. | `services/poller-ai-review.ts`, `services/session-subsessions.ts` (`spawnReviewerSession`), `services/session-reviewer-prompt.ts`, `services/poller-decisions.ts` |
| 8. Pull request | The worker pushes its branch and opens a PR, then reports it. The GitHub webhook links PRs and feeds CI results back. | `routes/internal-preview.ts` (`pr-created`), `routes/github-webhook.ts`, `services/ci-green-gate.ts` |
| 9. Merge | A person merges, or (when switched on) a small PR with green CI and a passing review merges automatically, or a bot holding a merge grant merges after a strict live CI check. | `services/auto-merge.ts`, `services/grant-merge.ts`, `routes/grant-merge-route.ts` |
| 10. Follow-up | A message on a finished or waiting card resumes the same session, or starts a fresh one seeded with a summary once the history is too long. | `services/session-followup.ts`, `services/resume-cap.ts` |

Three rules run through all of it:

- **Evidence over claims.** A worker with a dirty tree or no commits has delivered nothing,
  whatever its summary says.
- **The reviewer reads the deliverable, not the scratch.** `ARTIFACT.md` and the branch are
  graded; the worker's notes file is masked from the reviewer prompt.
- **Nothing ships by editing the running checkout.** Work reaches `main` only through a PR.

## Directory map

```
app/
  shared/        types and pure logic used by server and client (@operationkit/shared)
  server/src/    the backend (below)
  client/src/    React app: components/ (pages and panels), hooks/, context/, lib/
  jail/          image for the per-card sandbox
docs/            architecture (this folder), product manual, API reference, wiki pages
install/         installer scripts for a fresh server
scripts/         CI helpers and operator scripts
```

`app/server/src` by folder:

| Folder | Holds |
|---|---|
| `index.ts` | Boot: opens the DB, mounts every router, starts the timers. Start here to see what exists. |
| `routes/` | One file per HTTP area. `objectives-*.ts` is the board, `internal-*.ts` is the localhost/session control plane, `admin-*.ts` is operator-only. |
| `services/` | Everything with behaviour: sessions, poller, workflows, bots, knowledge base. Grouped by file prefix (next table). |
| `lib/` | Small pure helpers with no timers and no I/O surprises (scoping rules, parsers, URL and title helpers). |
| `db/` | `index.ts` (`initDb`, `getDb`, migrations) and `schema/` (one file of `CREATE TABLE` per area). |
| `middleware/` | Auth (cookie JWT, API keys, session tokens), rate limits, CSRF, the internal API gate. |
| `ws/` | The WebSocket server for live board updates and the admin terminal. |
| `connectors/`, `mcp-servers/` | Built-in outside-account connectors and the MCP server catalog. |
| `scripts/` | Command-line entrypoints (run with `tsx`); not imported by the server. |

`app/server/src/services` by file prefix:

| Prefix | Area | Read first |
|---|---|---|
| `session-*` | Starting, running, resuming and ending one coding session | `session-manager.ts` (facade), `session-start.ts` |
| `poller-*`, `state-poller.ts` | The watch loop and every decision it makes | `poller-loop.ts`, `poller-decisions.ts` (pure, well tested) |
| `prompt-builder*` | The worker prompt | `prompt-builder.ts` |
| `flow-*` | Workflow engine: steps, budgets, approvals, self-test, auto-repair | `flow-engine.ts`, plus `app/shared/flow/` for the definition format |
| `routine-*` | Scheduled tasks and their run history | `routine-scheduler.ts`, `routine-runs.ts` |
| `kb-semantic/`, `kb-setup/`, `kb-wiki/`, `doc-ingest/` | Knowledge base: search index, first-run import, compiled pages, file ingest | `kb-semantic/service.ts` |
| `agent-chat/` | Chat bots: the model loop, tools, threads, wakes, bot-to-bot messages | `agent-chat/engine.ts`, `agent-chat/tools.ts` |
| `bots/` | Bot identity: registry, who owns a card, approvals, credentials | `bots/card-owner.ts` |
| `decision-*` | Questions a bot raises for a person, and applying the answer | `decision-apply.ts` |
| `secrets-*`, `secret-*` | Encrypted secret store and how sessions receive secrets | `secrets-kek.ts` |
| `pr-*`, `ci-*`, `auto-merge.ts`, `grant-merge.ts` | Pull request health, CI gates, merging | `ci-green-gate.ts` |
| `llm-gateway/`, `mailer/` | Model backends for in-process calls; outbound email providers | — |

Several large files were split and their original path kept as a thin re-export facade
(`session-manager.ts`, `state-poller.ts`, `routes/objectives.ts`). Import from the facade
unless you are working inside that area. History: [GOD-FILES.md](./GOD-FILES.md).

## Where do I add X

| I want to add | Put it | Also |
|---|---|---|
| An HTTP route | New file in `app/server/src/routes/`, mounted in `app/server/src/index.ts` | Prefix `/api/`. Add it to [CONTRACTS.md](./CONTRACTS.md) if it is public. |
| A database table or column | `app/server/src/db/schema/<area>.ts`, called from `initDb()` in `db/index.ts` | Migrations are additive and idempotent; they run on every boot. |
| A background timer | A `start…()` function in a service, called from `index.ts` | It must not start on a scratch instance (`services/scratch-instance.ts`). List it in [MODULES.md](./MODULES.md). |
| A type shared with the client | `app/shared/types-*.ts` (re-exported by `types.ts`) | Import as `@operationkit/shared`. |
| A status or transition | `app/shared/workflow.ts` | This is a product change, not a refactor. |
| A page or panel | `app/client/src/components/`, lazy-loaded from `app/client/src/App.tsx` | Use the words in the [glossary](../glossary.md); a client test enforces them. |
| A chat bot tool | `app/server/src/services/agent-chat/tools.ts` and `tool-names.ts` | Scope it to the bot's workspaces. |
| A workflow step or tool | `app/shared/flow/` (definition, validation) and `services/flow-*.ts` (execution) | Label its effect (read / write / send / spend) honestly. |
| Text in the worker prompt | `services/prompt-builder-blocks.ts`, wired in `buildPrompt` | Never name the worker's notes file in a reviewer prompt. |
| A knowledge base write path | Wherever it fits, but call `noteKbWrite(path)` from `kb-semantic/service.ts` | Otherwise search goes stale until the next reconcile. |
| A setting | A row in the `settings` table, read at the point of use | No restart should be needed to change it. |
| A link the server hands out | Build it with `lib/public-url.ts` | Never hardcode a host. |
| A test | Next to the file: `foo.ts` → `foo.test.ts` | See [CONTRIBUTING.md](../../CONTRIBUTING.md#tests). |
