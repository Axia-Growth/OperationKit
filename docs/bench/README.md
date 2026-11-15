# Board vs single agent: reproducible benchmark

Systems audit item #19. Other audit items (the router, the degradation chain, shadow routing)
claim savings that nobody can measure today. This harness gives them a number to compare
against.

It runs one fixed task set two ways and scores both the same way:

| Arm | What runs | Reviewer |
|---|---|---|
| `board` | A card is filed and started through the Agent API. A worker session does the task in a worktree of a throwaway fixture repo. The board then applies whatever review it normally would. | Yes, when the board routes the card to AI review |
| `baseline` | One plain `claude -p` session with the same model, in a temp copy of the task repo. No board, no worktree, no CLAUDE.md, no MCP servers, no user-level settings or hooks. | No |

Code: `app/server/src/bench/`. Task set: `app/server/fixtures/bench/v1/`. Mock-mode
transcripts: `app/server/fixtures/bench/transcripts/v1/`. Tests: `app/server/src/bench/*.test.ts`.
They run in the existing `unit (server)` CI job, so no workflow change is needed.

## Reproduce

All commands run from `app/server` after `npm ci` in `app/`.

### 1. Mock mode (no model calls; this is what CI runs)

```bash
npx tsx src/bench/cli.ts run --mode mock                # all 12 tasks, both arms, seed 19
npx tsx src/bench/cli.ts run --mode mock --tasks smoke --seed 42 --out /tmp/bench-mock
```

Mock mode replays recorded transcripts. It applies their file edits to a fresh copy of each
task repo, then runs the real scorer. The transcripts shipped for CI are **synthetic**. They
are test fixtures with made-up numbers, so a mock run tests the harness and does not measure
the board. To replay a real recording instead, pass its directory:
`--transcripts docs/bench/results/<run>/transcripts`.

### 2. Live baseline only (cheapest real run)

```bash
npx tsx src/bench/cli.ts run --mode live --arms baseline \
  --model claude-sonnet-5-5 --budget-usd 2 \
  --out ../../docs/bench/results/$(date -u +%F)-baseline --record ../../docs/bench/results/$(date -u +%F)-baseline/transcripts
```

- The machine needs a logged-in `claude` CLI, or `ANTHROPIC_API_KEY` set.
- Without `--tasks`, live mode runs only the 2-task smoke subset. Pass `--tasks all` or a comma list for more.
- The baseline loads only `project,local` Claude settings. If your credential comes from a
  user-level `apiKeyHelper`, pass `--setting-sources user,project,local`. Your hooks then
  apply to the baseline as well, so say so when you report the numbers.

### 3. Live, both arms

This has to run on a host where the board's worker sessions can reach the fixture repo.

```bash
# a) Create the throwaway fixture repo (refuses a non-empty directory that is not one)
npx tsx src/bench/cli.ts board-setup --bench-repo /srv/cc-bench-fixture

# b) Register it as a project on a THROWAWAY workspace
#    (Settings -> Workspaces -> Repos, or POST /api/admin/workspaces/<ws>/repos
#     {"name":"cc-bench-fixture","repo_path":"/srv/cc-bench-fixture"})

# c) Create an agent key with board:read, board:write and board:start on that workspace
#    (Settings -> You), and export it:
export BENCH_BOARD_API_KEY=...        # never commit it

# d) Run
npx tsx src/bench/cli.ts run --mode live --model claude-sonnet-5-5 --budget-usd 10 \
  --workspace bench --project cc-bench-fixture --bench-repo /srv/cc-bench-fixture \
  --board-url http://localhost:3002 --record ../../docs/bench/results/<run>/transcripts \
  --out ../../docs/bench/results/<run>
```

The board arm refuses to start without `--workspace`, `--project`, `--bench-repo` and the key.
It also refuses any `--bench-repo` that lacks the `.cc-bench-repo` marker, so it cannot be
pointed at a real project.

To compare two configurations (for example router on and off), run the same `--seed` and
`--tasks` against each. Check that `taskset_hash` matches in both `results.json` files before
you compare them.

## What a run writes

`<out>/results.json` (`cc-bench-result/1`) holds the configuration (mode, task-set version
and sha256, seed, model, budget), the seeded task order, one record per (task, arm), the
per-arm summary, the deltas, total spend, and why the run stopped early if it did.

`<out>/summary.md` holds the same thing as tables:

- **Summary:** board, baseline and board − baseline for success rate, median wall time, mean
  tokens, mean and total cost (with the cost ratio), cost per success, mean review
  iterations and human interventions.
- **Per task:** one row per run with checks passed, wall time, tokens, cost, reviews,
  human interventions and status.

`--record <dir>` saves every live run as a `cc-bench-transcript/1` file. Mock mode can replay
it later with no model calls. Baseline recordings keep the full stream-json events plus a
snapshot of changed files. Board recordings keep the card totals, the review rounds and a
snapshot of the work. The `system/init` event is trimmed to portable keys, so plugin lists,
socket paths and memory paths are not recorded.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The run finished. Task failures are results, not errors. |
| 1 | The harness itself crashed. |
| 2 | Refused before any spend: live mode with no `--budget-usd` or no `--model`, a board arm that is not configured, an unknown flag or an unknown task id. |

## The task set (`v1`)

There are twelve small Node.js tasks with no dependencies. `manifest.json` lists them with
their prompts and the `smoke` subset (`t01-sum-range`, `t02-slugify`). Each task directory
holds:

- `repo/`: the starting state the agent sees.
- `check/*.test.js`: hidden `node:test` files. They are copied into `.bench-check/` only
  AFTER the agent finishes, and anything the agent put in `.bench-check/` is deleted first.
- `solution/`: a reference answer. No agent ever sees it.

| id | kind | what |
|---|---|---|
| t01-sum-range | bugfix | off-by-one in an inclusive range sum |
| t02-slugify | feature | slugify with accent stripping |
| t03-parse-duration | feature | strict `1d2h3m4s` parser |
| t04-roman | feature | Roman numerals both ways, 1..3999 round trip |
| t05-deep-merge | bugfix | make a mutating shallow merge pure and recursive |
| t06-csv-quotes | bugfix | RFC 4180 quoting, CRLF, newlines inside quotes |
| t07-semver-compare | feature | semver.org prerelease precedence |
| t08-lru-cache | feature | LRU cache class |
| t09-rename-refactor | refactor | rename a function across files, no old name left |
| t10-release-notes | docs | version bump in two places + CHANGELOG.md (must exist) |
| t11-cli-flag | feature | add `--lines` to a CLI, reject unknown flags |
| t12-retry | feature | retry with exponential backoff |

**Success** means every hidden check passed, every `must_exist` path exists, and at least one
check ran. The scorer is the only judge. An AI reviewer's verdict never counts as success:
the synthetic t07 board run shows a reviewer passing work that the checks then fail.

The test suite asserts, for every task, that the starting repo fails its checks and the
reference solution passes them. A broken task cannot slip in unnoticed.

**Changing the task set:** never edit `v1` in place. Results are comparable only between
runs whose `taskset_hash` matches. Copy the set to `v2/`, change it there, and run
`npx tsx src/bench/cli.ts make-synthetic --taskset fixtures/bench/v2 --out fixtures/bench/transcripts/v2`.

## Methodology

- **Same tasks, same seed, same words.** Both arms get the same tasks in the same seeded
  order. Each task's prompt is built by one function (`taskPrompt`). The board card adds two
  lines: which subdirectory is the repo root, and a note that it is a benchmark card.
- **Arm order alternates per task**, seeded. Time-of-day drift, rate limits and prompt-cache
  warmth therefore do not always favour the same arm.
- **Paired comparison.** Summaries and deltas are computed only over tasks where every arm
  produced a run. A budget stop is task-granular: before each task, the guard checks the
  projected cost of running ALL arms on it. A stopped run therefore never compares one arm
  on an easier subset.
- **Same model.** Live mode refuses to run without `--model`. The baseline passes it to
  `claude --model`. The board arm sets it on the card.

### Metrics and where they come from

| Metric | baseline | board |
|---|---|---|
| success | hidden checks + `must_exist` | same |
| wall time | process start to exit | card filed to card stopped (`review`/`done`/`cancelled`), including queueing, poller ticks and reviewer spawn |
| tokens | stream-json `result.usage` (input, output, cache read, cache write) | card `total_tokens`, all sessions combined. The per-card split is not stored, so only `total` is filled. |
| cost | stream-json `result.total_cost_usd` | card `total_cost_usd`. This covers every session on the card, the reviewer included. The harness waits for it to settle after the card stops. |
| review iterations | always 0 | card `ai_review_iteration` |
| human interventions | 0, since a `-p` session cannot be messaged | follow-ups in the card thread whose sender is `owner` or `member`. Bot, API and system messages are not counted. |

### Budget (live mode)

- No `--budget-usd`, or a zero, negative or non-numeric value: exit 2, nothing runs.
- Before each task: `spent + projection(all arms) > budget` stops the run, and the reason is
  written to `results.json` (`stopped`) and the summary. An arm's projection is the larger of
  the task's `est_usd` and the most expensive run that arm has produced so far.
- Each run also gets a hard cap: the budget left after reserving the other arms' projections,
  rounded down to the cent. The baseline passes it to `claude --max-budget-usd`. The board arm
  cancels the card when its recorded cost crosses it. If less than a cent is left for an arm,
  the run stops instead of starting it.
- If the harness cannot read what a run spent, the budget is charged that run's whole cap.
  This covers a killed baseline session that never reported, a board card whose cost never
  landed, and an arm that crashed.
- A card the board created but refused to start (session cap, lease conflict) is cancelled at
  once, so it cannot auto-start later and spend outside the budget. A card that times out is
  cancelled too.
- Every run has a wall-clock limit (`--timeout-min`, default 20 minutes for the baseline and
  90 for the board). A baseline session past it is sent SIGTERM, then SIGKILL 10 seconds later.
  A board card past it is cancelled.
- If the CLI reports it is not logged in, the run stops at once with an `environment:`
  reason. A broken setup is not scored as task failures.

## Limits (read before quoting a number)

1. **Mock numbers are not measurements.** The shipped transcripts are synthetic and exist to
   test the harness.
2. **Small n, no model seed.** The seed fixes task and arm order, not model sampling. One run
   of 12 tasks gives a wide error bar. Run several seeds and report the spread.
3. **The tasks are tiny.** They favour the baseline, because the board's fixed overhead
   (prompt scaffolding, worktree, review) is large next to a 20-line change. The result is a
   lower bound on what the board costs, not what it is worth on real cards.
4. **The board may skip the reviewer.** With the default merge-lane rules, a `create_pr`
   card whose changes are backend-only (known file list, no UI) lands in the green lane, and
   the LLM reviewer does not run. `review_iterations` then reports 0. That is the board as
   configured, and the benchmark measures it as it is. Note it next to the numbers.
5. **The reviewer model is not `--model`.** The board picks its reviewer model itself. The
   board arm's cost includes that reviewer.
6. **Caps can overshoot.** `--max-budget-usd` is checked between turns, so a baseline run
   can pass its cap by up to one turn. The board is looser: a card's `total_cost_usd` is
   written when a session ENDS, so the bench can only cancel a card between sessions (for
   example between the worker and the reviewer). A single running session is bounded by the
   board's own per-spawn `--max-budget-usd` and by the bench's wall-clock timeout
   (`--timeout-min`, default 90). Either way the real spend is recorded, and the next task sees
   it and stops. Keep `--budget-usd` comfortably above one board run.
7. **The board arm needs a host.** Its work product is read from the card's branch
   (`cc/obj-<id>-*`) in the fixture repo, or from its worktree. The harness must run where
   that repo is readable.
8. **Human interventions only count typed follow-ups.** A card that ends in `review` and waits
   for a person to mark it done is the board's normal human gate. It is not counted, but
   board wall time stops when the card reaches `review`.

## Live smoke run (2026-11-15)

`docs/bench/results/2026-11-15-live-smoke/` holds the one live smoke run made while building
this. It used the baseline arm, the smoke subset, seed 19, `claude-sonnet-5-5` and a $2
budget. It spent **$0.00**: the build sandbox has no Claude credential, so both sessions
answered "Not logged in". The harness ran end to end and recorded both runs as errors with
0 tokens. That failure is why the harness now treats "not logged in" as a fatal
`environment:` stop. The results directory's README has the details. A real measurement
needs the host steps in "Live, both arms" above.
