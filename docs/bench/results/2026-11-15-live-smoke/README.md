# Live smoke run, 2026-11-15

This is the only live run made while the harness was built.

| | |
|---|---|
| Command | `npx tsx src/bench/cli.ts run --mode live --arms baseline --tasks smoke --seed 19 --model claude-sonnet-5-5 --budget-usd 2 --out … --record …/transcripts --run-id 2026-11-15-live-smoke` |
| Arms | baseline only. The board arm needs the host setup in `docs/bench/README.md`, and the build sandbox has no host access. |
| Tasks | `t02-slugify`, `t01-sum-range`, in seeded order (seed 19) |
| Budget | $2.00, of which **$0.00** was spent |
| Result | 0/2 succeeded. Both runs are `error`. |

**Why both runs failed:** the sandbox the harness was built in has no Claude credential. There
is no `ANTHROPIC_API_KEY` and no CLI login, so each `claude -p` session answered
`Not logged in · Please run /login` with `is_error: true`, 0 tokens and $0. The run still
shows the live path working end to end:

- the budget was required, and each run got a per-run cap (`--max-budget-usd 2.00`);
- the scorer ran the hidden checks against the untouched repos. Both failed, and `t01`
  passed 1 of its 2 checks: the from > to case already returns 0 before the fix;
- `results.json`, `summary.md` and the replayable transcripts were written.

After this run, the harness was changed to treat "Not logged in" as a fatal `environment:` stop
(see `fatal` in `types.ts`), so a broken setup no longer looks like two task failures.
`results.json` and `summary.md` are kept exactly as that run wrote them. The transcripts had
their `system/init` event trimmed to portable keys (the same `sanitizeEvent` the recorder now
applies), and were given the measured `wall_ms` from `results.json`, so a replay reports the same
wall time. Both are edits to the recording format only; nothing about the run was changed.

To replay it with no model calls:

```bash
cd app/server
npx tsx src/bench/cli.ts run --mode mock --arms baseline --tasks smoke \
  --transcripts ../../docs/bench/results/2026-11-15-live-smoke/transcripts
```
