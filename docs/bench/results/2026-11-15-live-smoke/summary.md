# Board vs single agent: live run

| | |
|---|---|
| Mode | live |
| Task set | v1 (sha256 `f66eb240a2c0`) |
| Seed | 19 |
| Model | claude-sonnet-5-5 |
| Budget | $2.00, spent $0.0000 |
| Task order | t02-slugify, t01-sum-range |
| Paired tasks | 2 of 2 |
| Harness | cc-bench/1.0.0 |

## Summary

| Arm | Success | Median wall | Mean tokens | Total cost | Review iterations | Human interventions |
|---|---:|---:|---:|---:|---:|---:|
| baseline | 0/2 | 0.7s | 0 | $0.0000 | 0 | 0 |

Only one arm ran, so there are no deltas.

## Per task

| # | Task | Arm | Result | Checks | Wall | Tokens | Cost | Reviews | Human | Status |
|---:|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | t02-slugify | baseline | FAIL | 0/4 | 0.7s | 0 | $0.0000 | 0 | 0 | error: session ended with is_error |
| 2 | t01-sum-range | baseline | FAIL | 1/2 | 0.7s | 0 | $0.0000 | 0 | 0 | error: session ended with is_error |
