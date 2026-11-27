# Knowledge curator

The knowledge curator (obj 901768) closes the loop between doing the work and the knowledge base.
Work shows where the knowledge base is thin or wrong: an agent can't find a page, a page says
something that is no longer true, a person corrects a worker mid-run ("no, use the new invoice
header"). The curator is a separate pass that reads those signals **after the fact** and turns them
into suggested changes. It is never the worker doing the task, and it never changes a page on its
own: a person accepts or rejects every suggestion.

Code: `app/server/src/services/kb-wiki/curator.ts` (+ `curator-corrections.ts`), scheduled from
`services/kb-wiki/scheduler.ts`, routes in `routes/kb-wiki.ts`, UI in
`client/src/components/kb-wiki/CuratorPanel.tsx` (Context → **Suggestions** tab).

## When it runs

- **On a schedule, only when an admin switches it on.** Setting `kb_curator_enabled` (`'1'` = on;
  no row = off), toggled in Context → Suggestions → **Curator schedule**, or
  `PUT /api/kb-wiki/lint/settings {"curator_enabled": true}` (admin). When on, it runs once after
  each cleanup (lint) pass, per workspace, so it follows the cleanup schedule (nightly by default).
  An existing install sees no change until an admin turns it on.
- **On demand:** Context → Suggestions → **Look for suggestions now**, or
  `POST /api/kb-wiki/curator/run?workspace=` (any member of the workspace).
- **AI budget:** `kb_curator_ai_drafts` (default 10, 0-50) caps AI calls per run: one call routes
  unnamed corrections to a page, the rest draft page updates. `0` = no AI; updates then list the
  evidence on the page instead of rewriting it.

## What it reads

| Input | Where | Notes |
|---|---|---|
| Knowledge flags | The open rows of the `kb_flags` table, plus `<kb>/.kb-wiki/flags.jsonl`, schema `kb-flag/1` (below) | Filed with the flag tool (`flag_knowledge`, `POST /api/kb-wiki/flags`). The scheduler hands the open rows to the curator through `services/kb-wiki/curator-flags.ts` (kind `stale` reads as `outdated`; a flag with no page names its subject as the topic). The curator only reads them; closing a flag stays on the Cleanup tab. |
| The cleanup report | `<kb>/.kb-wiki/lint-last.json` (the data behind `lint-report.md`) | Stale pages, pages nothing links to, likely duplicates, facts that disagree. |
| Human corrections | session transcripts (`TRANSCRIPT_DIR/<session>.jsonl`) of the workspace's cards, found through `session_starts` | Only `followup` events a person typed in the web app (server-stamped `sender.kind` owner/member + `verified`), or — for older transcripts with no sender — what the daily-retro detector classifies as human. Only messages that read as a correction (daily-retro corrective phrasing, or "from now on / no longer / use the new …"). Agent, API, system and delegated messages never count. Each correction is read once; one the AI could not route, or whose suggestion waits for room in the list, is kept in the curator's state and tried again next run. |

### Flag schema `kb-flag/1`

One JSON object per line of `.kb-wiki/flags.jsonl`:

```json
{"schema":"kb-flag/1","id":"f-123","at":"2026-11-23T04:00:00Z","kind":"wrong",
 "page":"topics/invoice-header.md","detail":"The header changed in October.",
 "objective_id":901700,"by":"Operation Kit Dev"}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable id. A later line with the same id replaces the earlier one. |
| `kind` | yes | `missing` · `wrong` · `outdated` · `unclear` · `retire` |
| `detail` | yes | One plain sentence: what was missing or wrong. |
| `page` | one of page/topic | KB-relative `.md` path. Raw sources, machine state and `..` are refused. |
| `topic` | one of page/topic | The name of a page that does not exist yet (with `missing`), or a page found by name. |
| `at`, `objective_id`, `by` | no | When, which card, who. Shown next to the suggestion. |
| `resolved` | no | `true` drops the flag. |
| `schema` | no | If present it must be `kb-flag/1`. |

Unknown fields are ignored, so the writer can add more later. Bad lines are skipped and counted.

## What it suggests

| Kind | From | What accepting does |
|---|---|---|
| **Update** | a flag on a page, or a correction that names a page (by title, alias or path; with AI, also a correction the AI routes to a page) | Writes the proposed page. With AI the page is redrafted from the evidence only (a draft that drops most of the page is refused); without AI, or when the AI draft is unusable, the evidence is added to a "Flagged for review" list and no existing line changes. |
| **Retire** | a `retire` flag, or a page the cleanup lists as stale that nothing links to (or stale for more than twice the stale limit) | Marks the page `status: retired` (+ `retired`, `retired_reason`) and puts a banner on top. Nothing is deleted and links keep working. Cleanup then stops listing it as stale, an orphan, isolated or a duplicate; links FROM it still count, so retiring a page never makes the pages it links to orphans. |
| **Merge** | a duplicate group from the cleanup | The page more of the wiki links to keeps its text and gains each other page's body under "Merged from …" plus their titles as aliases; the others are retired with "Merged into …". |
| **New page** | a `missing` flag | Starts a stub page listing what was looked for. |

Contradictions from the cleanup add weight to an update that already exists for that page; on their
own they stay a cleanup item (only a person knows which source is right).

## Who may accept

- **Every suggestion needs a person** signed in as a user (browser cookie or the user's own JWT).
  Agent keys, legacy per-user API keys, card session tokens and card-browser sessions get
  `403 not_a_person`. Nothing is applied automatically — the same rule lint keeps for facts.
- **Procedure pages need an admin's sign-off.** A page is a procedure when it is under
  `runbooks/`, `procedures/`, `skills/`, `playbooks/`, `sops/`, `how-to/`, `checklists/`,
  `processes/` or `policies/`, is a `SKILL.md`, has `type:` procedure / runbook / skill / playbook /
  sop / how-to / checklist / process / policy (or `procedure: true`), or its title starts "How to".
  Accepting one needs an admin signed in through the web app (cookie, not a bearer token) **and**
  `sign_off: true`, one at a time (`procedure_needs_admin`, `procedure_needs_sign_off`,
  `procedure_one_at_a_time`). The decision records `signed_off: true`.
- **Light touch:** merges and new stubs on domain pages (people, companies, topics) may be accepted
  by any member, also all at once (`POST /api/kb-wiki/curator/accept-light`). Updates and
  retirements are one at a time.
- **Stale suggestions are refused.** Each suggestion stores a hash of the exact page text it was
  drafted from (the automatic backlinks block is ignored). If a page changed since — including
  while the run was still drafting — accepting returns `409 page_changed` and writes nothing; the
  next run drafts a fresh one. Writes are contained on the real path (no symlink escapes).
- **One run at a time** per knowledge base (schedule and button share the lock; a second gets
  `409 already_running`). A person's accept or reject made while a run is working is kept.
- **Used-up evidence is not re-asked:** an update accepted with the same evidence, or one the AI
  read and found nothing lasting in, is not suggested again until new evidence arrives.
- **"No thanks" is remembered** for 120 days: the same suggestion comes back only with new evidence
  (cleanup evidence ids are stable across nightly runs, and a merge is the same suggestion whichever
  page it keeps).
- At most 40 suggestions are open at once; the strongest (corrections, then flags, then cleanup)
  go first.

## Routes

| Route | Who |
|---|---|
| `GET /api/kb-wiki/curator?workspace=` | members: open suggestions, recently decided, last run, notes |
| `POST /api/kb-wiki/curator/run?workspace=` | members: look for suggestions now |
| `POST /api/kb-wiki/curator/proposals/:id/accept` `{workspace, sign_off?}` | a person; procedure pages: admin in the browser + `sign_off: true` |
| `POST /api/kb-wiki/curator/proposals/:id/reject` `{workspace, note?}` | a person |
| `POST /api/kb-wiki/curator/accept-light` `{workspace}` | a person; merges and new stubs only, never a procedure page |

State lives in the workspace's own knowledge base: `.kb-wiki/curator/proposals.json` (machine
state, never indexed) and a readable `curator-suggestions.md` at the knowledge-base root. Each run
and each decision is a line in `log.md`.

## Safety

- Flags and corrections reach the AI only inside an untrusted-content frame (boundary 16 in
  `docs/security/untrusted-content.md`, `source="kb-curator-evidence"`), and the injection scanner
  logs suspect text. Nothing the AI returns is applied without a person.
- Correction text is redacted again (`redactForStorage`) and capped before it is kept.
- Raw sources (`raw/`, `sources/files/`, `sources/inbox/`) and `.kb-wiki/` are never written.
- Not the same thing as `dream-cycle.ts` (which mines sessions into `objective_learnings`), and
  not a skill store: skills and runbooks in the knowledge base are only ever changed through a
  signed-off suggestion.
- The Knowledge librarian starter bot (`agent-templates/knowledge-librarian`) is not used or
  switched on by this feature; an install that runs it can point it at this tab.
