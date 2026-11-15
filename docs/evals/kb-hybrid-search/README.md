# KB hybrid search eval (obj 900816)

`app/server/src/scripts/kb-search-eval.ts` measures keyword vs hybrid vs semantic recall@5 on a COPY
of a vault, plus backfill time and DB growth. It runs the local model and a throwaway DB, so it makes no
paid API call and never touches the live DB.

```bash
cd app && npx tsx server/src/scripts/kb-search-eval.ts --root /path/to/vault-copy \
  --queries ../docs/evals/kb-hybrid-search/<set>.json --out report.md [--verbose]
```

A query file looks like `{ "queries": [{ "id", "kind", "q", "relevant": ["path/relative/to/root.md"] }] }`.
Use `kind: "paraphrase"` for queries that avoid the target note's own words and `kind: "exact"` for IDs and names.

## Result on the operator's operationkit vault (694 notes, 22 queries, 2026-11-14)

| mode | recall@5 | hit@5 | MRR@5 |
|---|---|---|---|
| keyword (previous behaviour) | 44.7% | 11/22 | 0.409 |
| **hybrid (new default)** | **79.5%** | **18/22** | **0.632** |
| semantic only | 61.0% | 16/22 | 0.543 |

By kind: paraphrase 46.1% → 73.5% and exact 40.0% → 100.0% (keyword → hybrid).

Backfill: 694 files → 7,094 chunks in 291 s, with the local MiniLM model capped at 2 CPU threads. DB growth was +20.0 MB, about 2.9 KB per chunk. A re-run with nothing changed takes 0.04 s.

The query set and per-query report are private, because they name private notes. They are not published.
