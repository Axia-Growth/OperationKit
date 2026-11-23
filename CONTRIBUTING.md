# Contributing to Operation Kit

Thanks for helping. Operation Kit is open source under the [Apache License 2.0](./LICENSE).
Copyright 2026 Axia Growth LLC and contributors
(see [NOTICE](./NOTICE)).

## Ways to contribute

- **Report a bug or ask for a feature:** open a GitHub issue. Include what you did, what you
  expected, what happened, and your version / install method.
- **Security problems:** do not open a public issue. Follow [SECURITY.md](./SECURITY.md).
- **Code and docs:** open a pull request (see below). For anything larger than a small fix,
  open an issue first so we can agree on the approach before you spend time on it.

## Pull request workflow

1. Fork the repository and create a branch from `main`.
2. Make your change. Keep each PR focused on one thing, and small enough to review in half
   an hour.
3. Run the checks below. They are the same commands CI runs.
4. Open the pull request against `main` and fill in the PR template.
5. Sign the CLA (below) if you have not already.
6. A maintainer reviews the PR. The `gate` check must be green before merge.

New to the code? Read the [architecture overview](./docs/architecture/OVERVIEW.md) first: the
life of a card, a directory map, and a "where do I add X" table.

## Repository layout

| Path | What is in it |
|---|---|
| `app/shared/` | Types and pure logic shared by server and client (`@operationkit/shared`) |
| `app/server/src/` | Backend: Express routes, services, SQLite schema, WebSocket |
| `app/client/src/` | Frontend: React, Vite, Tailwind |
| `app/jail/` | Image for the per-card sandbox |
| `docs/` | Architecture, product manual, API reference, wiki pages |
| `install/`, `install.sh` | Installer for a fresh server |
| `scripts/` | CI helpers and operator scripts |
| `.github/workflows/gate.yml` | The required CI check |

`app/` is one npm workspace (`shared`, `server`, `client`) with one lockfile. Run npm from
`app/`, not from the repository root.

## Local development setup

You need:

- **Node 22** and npm.
- **A C/C++ toolchain and Python 3** (on Ubuntu, the `build-essential` package). The terminal
  dependency `node-pty` compiles during install and has no prebuilt Linux binary. Without a
  compiler `npm ci` fails at `node-pty`.
- **git** and **tmux** on your PATH for the tests that use them (see
  [Tests that need host resources](#tests-that-need-host-resources)).
- Docker is only needed to run real AI sessions in a sandbox. It is not needed to build, test
  or open the UI.

Check your machine, then install:

```bash
node scripts/setup-check.mjs      # from the repository root; no dependencies needed
cd app
npm ci --include=dev
```

The setup check reports a missing Docker as a blocker. For code and docs work you can go on
without it.

Run the app locally against a throwaway database (two terminals, both in `app/`):

```bash
# Terminal 1: API on port 3002
export DB_PATH="$(mktemp -d)/dev.db"
export JWT_SECRET="dev-only-secret-change-me-0123456789"
export CC_SCRATCH_SERVER=1
npm run dev:server

# Terminal 2: UI on http://localhost:5173 (proxies /api and /ws to port 3002)
npm run dev:client
```

- `CC_SCRATCH_SERVER=1` serves HTTP and WebSocket but starts none of the background work
  (session poller, schedulers, reapers). Use it whenever you are not running real sessions.
  The server logs `[startup] SCRATCH instance` when it is on.
- `JWT_SECRET` is required (16+ characters). There is no built-in default.
- To get dev users to sign in with, run this once in a third terminal with the same
  `DB_PATH`: `SEED_PASSWORD=<8+ characters> npm run seed`. It prints the usernames it made.
- Startup warnings about host folders that do not exist on your machine are expected in dev.
- Set `PORT` to move the API off 3002. The Vite proxy points at 3002, so change
  `app/client/vite.config.ts` locally to match (do not commit that).

## Checks to run before you open a PR

From `app/`:

```bash
npx tsc --noEmit -p server/tsconfig.json     # server typecheck
(cd client && npx tsc -b --noEmit)           # client typecheck (a separate CI step)
npm run test --workspace=server              # server tests (Vitest, node)
npm run test --workspace=client              # client tests (Vitest, jsdom)
npm run build                                # production build of client and server
```

The client typecheck is easy to miss: `tsc -p server/tsconfig.json` does not cover the
client, and CI runs `npx tsc -b --noEmit` inside `app/client` as its own step.

From the repository root, if you added, renamed or removed a test file:

```bash
bash scripts/test-integrity-fixture-test.sh
python3 scripts/test-integrity.py origin/main HEAD
```

CI also runs `shellcheck` on `scripts/migrate/*.sh` and
`node --test scripts/setup-check.test.mjs`. Run those if you touched those files.

## Tests

Tests are Vitest, run from the command line. A test sits next to the file it covers:
`foo.ts` and `foo.test.ts`. There is no browser-driven end-to-end suite, and one should not
be added without agreeing it in an issue first.

### Running one test

```bash
# from app/ ; the path is relative to the workspace (app/server or app/client)
npm run test --workspace=server -- src/lib/objective-depth.test.ts
npm run test --workspace=server -- src/lib/objective-depth.test.ts -t "root"
npm run test --workspace=client -- src/lib/glossary.test.ts
```

`-t` filters by test name. Tests under `app/shared/` run as part of the server suite.

### The test-integrity rule

CI fails a PR that narrows the suite (`scripts/test-integrity.py`):

- **No new skips.** An added line in a test file must not contain `.skip(`, `.only(`,
  `xit(` or `xdescribe(`.
- **No deleted test files**, unless the code the test covers is deleted in the same PR.
  Renaming the source does not count as deleting it.

If a test fails, fix the code or fix the test. Do not skip it, delete it or weaken its
assertions to get to green. A reviewer will ask why.

### Tests that need host resources

The suite is written to pass on a plain CI runner. Server tests always use a throwaway
SQLite file in the temp directory (`app/server/vitest.setup.ts`), never a real database.

A few tests need something on the machine. Most of them skip themselves when it is missing
(`describe.skipIf` / `it.skipIf`), so a skip on your machine is normal:

| Needs | Tests | If it is missing |
|---|---|---|
| A compiled `node-pty` | Anything that imports the session or terminal code (most of the server suite) | The files fail to load. Install a compiler and run `npm ci` again. |
| `tmux` | `services/scratch-instance.test.ts` | Skipped |
| `git` | Worktree and credential-helper tests (`services/worktree-*.test.ts`, `services/repo-git-auth.test.ts`) | Fail |
| The `gh` CLI | `services/session-github-connector.test.ts` | Skipped |
| Linux (`/proc`, `df`) | Live checks in `services/host-stats.test.ts` | Skipped |
| A temp directory that allows running files | Tests that write a small stub script and run it (`routes/internal-operationkit.test.ts`, `routes/integrations-builder.test.ts`, `services/repo-git-auth.test.ts`) | Fail on a `noexec` `/tmp`. Point `TMPDIR` at a directory that allows execution. |
| An Operation Kit workspace folder with the `okit` CLI | The live half of `routes/internal-operationkit.test.ts`, `services/skill-graph.test.ts`, `services/knowledge-search.recall.test.ts` | Skipped |

No test needs Docker, a network connection, an AI provider key or a GitHub token. If you
add a test that needs a host resource, guard it with `skipIf` on a real probe (does the
binary exist, does the folder exist), so CI stays independent of any one machine.

## Contributor License Agreement (required)

**A signed Contributor License Agreement (CLA) is required before a pull request can be merged.**
You sign once; it covers all your future contributions.

- **Individuals:** [CLA/INDIVIDUAL_CLA.md](./CLA/INDIVIDUAL_CLA.md)
- **Companies and other legal entities** (if you contribute as part of your job, or your
  employer may own what you write): [CLA/ENTITY_CLA.md](./CLA/ENTITY_CLA.md), plus the
  individual CLA for each person contributing.

What the CLA does, in plain words (the CLA text is what counts):

- **You keep the copyright** in your contribution. The CLA is a license, not a transfer.
- You give the project owner a broad, permanent license to use, change and distribute your
  contribution, **including the right to relicense it under other terms** (for example a
  commercial license), plus a patent license for your contribution.
- You confirm the work is yours to contribute (and that your employer is OK with it, if
  that applies).
- Your contribution is provided as-is, with no warranty.

**How to sign:** once the CLA check is enabled, a bot comments on your first pull request.
Reply with the exact sentence it asks for and the check turns green. Your signature is recorded
in this repository. Entities sign by sending the completed Entity CLA to
legal@example.com.

**DCO is not used.** This project uses a CLA instead of the Developer Certificate of Origin.
You do not need `Signed-off-by:` lines in your commits.

## Code of conduct

The project does not have a separate code of conduct file yet. Be respectful and constructive.
Maintainers may remove comments, issues or pull requests that are abusive, and may block
repeat offenders.

## For maintainers: the CLA check

The CLA check is `.github/workflows/cla.yml`, built on the open-source
[CLA Assistant Lite](https://github.com/contributor-assistant/github-action) action. It uses
only the default `GITHUB_TOKEN` (no personal tokens, apps or secrets) and records signatures in
`signatures/cla.json` on a dedicated `cla-signatures` branch.

It ships **disabled**. The job only runs when the repository variable `CLA_ENABLED` is `true`.
To turn it on:

1. Check the CLA text. No company placeholders remain: governing law is Delaware and the
   legal contact is legal@example.com in `CLA/INDIVIDUAL_CLA.md`, `CLA/ENTITY_CLA.md` and
   this file. The signer form blanks and the `[named here]` instruction stay blank on
   purpose; contributors fill those in when they sign.
2. Create the `cla-signatures` branch (from `main`) and leave it unprotected, so the
   action can commit signatures to it.
3. Settings -> Secrets and variables -> Actions -> Variables -> New repository variable:
   `CLA_ENABLED` = `true`.
4. Check that the allowlist in `cla.yml` covers every bot and maintainer account that opens
   PRs, so automated PRs are not blocked.
5. Optionally make the `CLAAssistant` check required in branch protection.

To turn it off again, delete the variable or set it to anything other than `true`.
