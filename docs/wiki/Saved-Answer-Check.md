# Saved-answer check

When someone saves an Ask answer to Context, it becomes a wiki page that later searches and later answers can cite.
Before obj 901746 the save only checked that the cited pages **existed**, and Ask's `[[citations]]` are written by
the model, so an answer could cite a real page for a claim that page never makes and be filed as fact. Public issues
[#120](https://github.com/Axia-Growth/OperationKit/issues/120) (the save path and the nightly cleanup) and
[#153](https://github.com/Axia-Growth/OperationKit/issues/153) (Ask's citations) describe the same gap.

Code: `app/server/src/services/kb-wiki/answer-check.ts` (check, state, review), `app/server/src/lib/kb-answer-hold.ts`
(the search hold), `services/kb-wiki/answers.ts` (save), `services/kb-wiki/lint.ts` step 8 (cleanup),
`services/doc-ingest/ask.ts` (Ask grounding). UI: Context → Cleanup → **Saved answers to check**
(`client/src/components/kb-wiki/HeldAnswersSection.tsx`) and the message under **Save to Context**.

## The check

Every save path runs it: the **Save to Context** button and the agent API (`POST /api/kb-wiki/answers`), MCP
`file_answer`, a card session's `POST /api/internal/kb-wiki/answers`, and the chat tool `file_answer`.

1. **Citation rules (no AI, always).** The answer is held when it cites a page that does not exist, cites a saved
   answer that is itself held, or cites no page at all. A wrong citation therefore fails instead of being filed.
2. **The AI reads the answer next to every page it cites** (declared sources plus pages cited in the text, up to 12
   pages / 60,000 characters) and lists the claims those pages do not state or directly imply, or that disagree with
   them. Same AI as Ask and the wiki (`wikiLlm`). Answer and pages reach it inside untrusted-content frames
   (boundary 18 in `docs/security/untrusted-content.md`).

| result | meaning | in search? |
|---|---|---|
| `passed` | the AI found every claim backed up | yes |
| `held` (`ungrounded`) | a rule failed, or the AI listed unsupported claims | **no** |
| `held` (`stale`) | a page it cites changed after it was checked | **no** |
| `unchecked` | rules passed but the AI did not run (none set up, or it failed) | yes; the cleanup checks it later |
| `reviewed` | a person approved it | yes |

A held answer is still **saved** (nothing is thrown away) with a plain reason, and the save response says so
(`check.status`, `check.reason`, `check.unsupported`).

## Where the state lives

In the answer page's own frontmatter, so it travels with the file and anyone opening the page sees why:

```yaml
answer_check: held
answer_check_kind: ungrounded
answer_check_reason: "1 claim is not backed by the pages it cites: \"…\" — …"
answer_checked_at: 2026-11-24
source_hashes: {"organizations/greenway-growers.md":"3f1c…"}
```

`source_hashes` are fingerprints of each cited page's text without frontmatter and without the automatic backlinks
block, so saving another answer (which adds a backlink to every page it used) never makes earlier answers look stale.

## Kept out of search until reviewed

`isHeldAnswerFile` (an answer page with `type: answer` and `answer_check: held`; 4 KB read, cached per mtime) is
applied on every retrieval path, so a held answer cannot be retrieved and cited again:

- hybrid / keyword / semantic search and "related" (`kb-semantic/search.ts`: UI, MCP `search`, chat-bot `search`,
  `GET /api/docs/search`, `GET /api/docs/related`), inside the rankers before the limit;
- the spawn-prompt retrieval (`knowledge-search.ts` `searchKnowledge`);
- the chat bots' plain word search;
- Ask's own note list (`doc-ingest/ask.ts` `listNotes`).

The page itself can still be opened by path, so a person can read it to decide.

## The nightly cleanup (lint step 8)

For each saved answer page:

- **already held** → listed again under "Needs a look" (`ungrounded_answer` / `stale_answer`) until reviewed;
- **passed or reviewed, and a cited page changed or was deleted since** → held as `stale_answer`. If the AI is on,
  it re-reads the pages and the reason says whether the claims still hold;
- **never checked** (saved before this check existed, or while the AI was down) → rules, then the AI, up to
  `MAX_AI_ANSWERS` (20) per run; the rest wait for the next run. With the AI check off (`lint_ai_pages = 0`) only the
  rules run and the report says how many answers the AI has not checked.

A page the curator or a person retired (`status: retired`) is skipped.

## Review (a person only)

Context → Cleanup → **Saved answers to check**, or:

- `GET /api/kb-wiki/answers/held?workspace=` — the list (any member).
- `POST /api/kb-wiki/answers/review {workspace, rel, decision}` — `approve` puts it back in search and re-records
  its pages' fingerprints (stale again only after a NEW edit); `keep_out` keeps it held and marks it
  `status: retired` (on file, never searched, no longer listed). Refused (403) for an agent key, a legacy key and a
  card-browser session, and the route is off the agent-key surface, so the bot that saved an answer cannot clear its
  own hold.
- Nor can a bot release one by rewriting the file: chat `write_doc` and `PUT /api/docs/file` from an agent key or a
  card session refuse (403 `answer_held_for_review`) a write that would drop `answer_check: held`
  (`heldAnswerReleaseRefusal`). A person editing the page in the app is reviewing it, so that write goes through.

## Ask's citations (issue #153)

`askKnowledgeBase` now returns `grounding: {cited, unknown, uncited}`: which notes the answer cited that it was
actually given, which `[[citations]]` point at pages it was **not** given, and whether it cited none (then the listed
sources are only the closest matches). The Ask panel shows a warning for either case. All `[[target|label]]` and
`[[target#heading]]` forms are now recognised as citations. The full check still runs when the answer is saved.

## Eval

`app/server/src/scripts/kb-answer-eval.ts` with the case set in `docs/evals/kb-answer-check/` (24 answers with a
known verdict). Rules only: 3/14 unsupported answers caught, 0/10 good ones held. A recorded model run: 14/14
caught, 0/10 held by mistake. How that run was recorded and its limits are in the eval's README.
