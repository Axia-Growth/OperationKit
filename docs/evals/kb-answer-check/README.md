# Saved-answer check eval (obj 901746)

Measures how often the check that runs before an Ask answer is saved (and in the nightly cleanup) catches an answer
the pages it cites do not back up, and how often it holds a good answer by mistake. Public issues
[#120](https://github.com/Axia-Growth/OperationKit/issues/120) and [#153](https://github.com/Axia-Growth/OperationKit/issues/153).
The retrieval eval next to it is `app/server/src/scripts/kb-search-eval.ts` (`docs/evals/kb-hybrid-search/`).

## Files

| file | what |
|---|---|
| `sample.json` | 7 pages of a made-up garden centre (one is a saved answer that is itself held) and 24 answers to save: 10 the cited pages back up, 14 they do not |
| `sample.replies.json` | one recorded model run: the raw reply to each prompt the AI is sent (21 cases; the other 3 are held by the rules with no AI call) |

The 14 bad answers cover: a citation to a page that does not exist, no citation, a citation to a held answer, invented
numbers (2), a page that says the opposite (2), a duty given to the wrong person, an invented offer, a true fact cited
to the wrong page, a wrong date, one right and one wrong claim in the same answer, an invented contact, and a
seasonal number stated as all-year. The 10 good ones include paraphrases, answers that combine two pages, and an
"the pages do not say" answer.

## Run it

```bash
cd app
npx tsx server/src/scripts/kb-answer-eval.ts --ai none                     # citation rules only, no model call
npx tsx server/src/scripts/kb-answer-eval.ts --ai live                     # the install's own AI (same one Ask uses)
npx tsx server/src/scripts/kb-answer-eval.ts --ai replay --replies ../docs/evals/kb-answer-check/sample.replies.json
npx tsx server/src/scripts/kb-answer-eval.ts --dump-prompts /tmp/prompts   # exactly what the AI is sent, to record a new run
```

`--cases <file>` takes another case set in the same shape; `--out report.md` / `--json result.json` save the result.
The knowledge base is a throwaway temp folder; nothing touches the live database or a real knowledge base.
`answer-check-eval.test.ts` runs the rules-only and replay numbers below in CI, so a change to the prompt, the reply
parser or the rules that moves them fails the build.

## Results (2026-11-24)

| run | unsupported answers caught | good answers held by mistake |
|---|---|---|
| rules only (`--ai none`) | 3/14 = 21.4% (all 3 by the rules) | 0/10 |
| recorded model run (`--ai replay`) | **14/14 = 100%** (3 rules + 11 AI) | **0/10** |

How the recorded run was made, and its limits:

- The prompts came from `--dump-prompts` (the exact system prompt and framed user prompt `verifyAnswer` sends). File
  names were shuffled to neutral ids so the label (good/bad) was not visible, and a Claude Sonnet sub-agent answered
  each one as the verifier, writing each reply before reading the next prompt. The build session had no AI credential
  of its own, so this is not the install's `claude -p` path (`DOC_INGEST_MODEL`, default `claude-sonnet-5`); run
  `--ai live` on an install for that number.
- A first recording attempt was thrown away: that sub-agent read all prompts and then attached several replies to the
  wrong file ids (e.g. the £250 claim filed under another case). The replay check caught it because each reply quoted
  a claim from a different answer.
- 24 short cases with one clear fact each are easy. Long answers, answers spread over many pages, and claims that need
  arithmetic or reading between the lines will score lower. Add cases from real held answers as they turn up.
