# Glossary

Two vocabularies, one page: the [words a person reads on screen](#words-on-screen) and the
[names used in code and the data model](#code-and-data-model-terms-hierarchy).

## Words on screen

One user-facing word per concept. Use these words in every label, title, button,
empty state, tooltip and error. Code, API paths, database columns and settings keys
keep their own names — this page is only about what a person reads on screen.

Owner: polish F7 (obj 900808). Source: product polish audit (obj 900799).

| Concept | Say | Do not say on screen | Notes |
|---|---|---|---|
| A unit of work on the Board | **card** | objective, task (on its own), ticket, sub-objective | A card inside another card is a "sub-card". "Task" only appears as "scheduled task". The code type stays `Objective`. |
| An AI teammate in this app (you chat with it, it works cards) | **bot** | agent, worker, assistant | The admin page that holds bot instructions, skills and tools is **Bots & skills**. |
| A third-party AI program that calls our API with a key | **outside agent** | bot | Only on the API / connect-your-agent pages and API key screens ("agent key"). |
| A goal card that owns sub-cards and scheduled tasks, with a budget. It does not run by itself. | **strategy** | strategy workflow, strategy job | A strategy is not a workflow with a schedule: the strategy is the goal, the scheduled tasks under it do the recurring work. |
| One instruction that repeats on a schedule (e.g. "research competitors every Monday") | **scheduled task** | routine, job, cron job, strategy workflow, recurring research workflow | A bot task opens a card per run; a script task runs a command. A task can belong to a strategy or stand alone. Listed under Workflows → Runs. |
| A chain of steps (tools, checks, approvals, bot steps) that runs on a schedule or a trigger | **workflow** | routine, job, flow | The nav item is "Workflows". A scheduled task can start a workflow (badge "Workflow"). A server-level cron entry is a "server schedule". |
| One time a workflow, a scheduled task or a bot on a card ran | **run** | execution, job run, session (in headings) | "Runs" is the history list. |
| When a workflow or scheduled task runs | **schedule** | cron, cron expression | Show it in words: "Every day at 6:00 AM". Never the cron string. |
| Your team's documents the bots read | **Context** | knowledge base, KB, wiki, vault, second brain | One document in it is a "doc". |
| A bot's private scratch file for a card | **notes** | NOTES.md | Not shown to reviewers. |
| Money | **cost** | spend (in labels), USD, $0.0042 | Always `formatCost` → "$1.24" or "<$0.01". |

## Formatting rules

- **Sentence case** for every title, button, tab, menu item and form label:
  "Edit card", "Assign to", "Attach files", "New integration", "Skill graph".
  Proper nouns and acronyms keep their capitals ("AI review", "GitHub", "API key").
- **Time:** `formatDateTime()` from `app/client/src/lib/format.ts` — a relative label
  ("5 minutes ago") with the absolute local time in the tooltip, in the viewer's own
  time zone. Never print an ISO string, "UTC", or a fixed zone.
- **Money:** `formatCost()`. **Durations:** `formatDuration()`. **Sizes:** `formatBytes()`.
- **Schedules:** `describeCron()`. Unreadable shapes become "Custom schedule".
- **Statuses and codes:** `humanize()` (`ai_review` → "AI review") or a hand-written
  label map. Never render a snake_case value, a settings key (`settings.x = 1`) or a
  tool name (`create_workflow`).
- **Errors:** `friendlyError()` — a plain sentence; the technical detail (status
  code, raw message) goes in a collapsed "Details" block.
- **IDs:** a card number may appear as a small "#123" chip where it helps people
  refer to the card; database ids, session ids, slugs and file names do not belong in
  headings or labels. Put them behind a copy button or a tooltip.
- **Monospace** (`font-mono`) only for code, ids, paths and keys a person may copy —
  not for timestamps, counts, money or stats.
- **Arrows** in navigation hints: "Settings → Models", not "Settings > Models".

The client test `app/client/src/lib/glossary.test.ts` fails if a retired word
(objective, execution, knowledge base, wiki, routine, worker) shows up in a
user-visible string in the client.

## Strategy vs scheduled task vs workflow

Asked in review (Nov 14): "is a strategy just a workflow with a set schedule?" No —
three different things, one word each:

- **Strategy** — the *goal*. A card ("GEO/SEO competitive positioning") with a budget
  that owns sub-cards and scheduled tasks. It never runs by itself.
- **Scheduled task** — *one instruction on a repeat* ("every Monday, research what our
  top 3 competitors shipped"). Each run opens a sub-card. It may belong to a strategy
  or stand alone. Created with **New scheduled task** on the Workflows page.
- **Workflow** — *a chain of steps* (tools, checks, approvals, bot steps) started by a
  schedule, an event or a click. Built and tested on the Workflows tab.

Never say "strategy workflow" or "routine" on screen.

## Code and data model terms (hierarchy)

The table at the top of this page is about words on screen. This section is about the names
in the schema, server and API, which keep their own vocabulary: a "card" on screen is an
`Objective` in code, a "sub-card" is a sub-objective, a "scheduled task" is a `Routine`, and
one of its runs is a `Job`. It was a separate page (`terminology-glossary.md`, ratified in
obj 2383, 2026-06-28) and was merged here so there is one glossary.

### The two axes

Two **independent** axes describe every objective. Do not conflate them.

1. **Tier** — *where a row sits in the hierarchy.* `Strategy > Objective > Sub-objective`.
2. **Type** — *what kind of work it is.* `project | bug | task`. Orthogonal to tier; a
   classification that drives the workflow (planning/review gates), **not** a level.

A Strategy can contain `project`-type and `task`-type objectives alike; `type` says
nothing about tier and tier says nothing about `type`.

### The hierarchy (tier axis)

```
Strategy            ← top tier. Persistent top-level delegator. Stored: is_strategy = 1
  └─ Objective      ← the atomic card; any row in the objectives table
       └─ Sub-objective   ← a delegator's child (UI synonym while running: "Worker")
```

| Canonical term      | Definition                                                                                                   | How it is represented                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Objective**       | The atomic unit; every row in the `objectives` table. The universal noun.                                    | A row in `objectives`.                                                                 |
| **Strategy**        | A persistent, **top-level** delegator that owns sub-objectives + jobs and re-wakes to decide next steps.      | **Stored marker** `objectives.is_strategy = 1`, set explicitly at creation. Tier badge: `STRATEGY`. |
| **Sub-objective**   | A child objective spawned by a delegator. The canonical noun for a delegator child.                          | A row with `parent_id` set under a `delegate_mode` parent.                             |
| **Worker**          | The **delegator-mode synonym** for a Sub-objective *while it is being executed by a worker session.* Not a separate entity. | UI label "Workers" in the rollup under an active delegator.                            |
| **Job**             | A recurring Objective produced by a Routine on a cron schedule.                                              | A row with `routine_id` set (Jobs surface).                                            |
| **Routine**         | The cron schedule definition that produces Jobs.                                                             | A row in `routines`.                                                                   |
| **Type** (`project`/`bug`/`task`) | Orthogonal **kind-of-work** tag on an objective, independent of tier.                          | `objectives.type`. See `app/shared/workflow.ts` `TYPE_LABELS`.                         |

### Strategy — the stored marker (obj 2383)

A **Strategy** is now an explicit stored marker, not an inferred state:

- Column: `objectives.is_strategy INTEGER NOT NULL DEFAULT 0`.
- Written at creation only when the create request explicitly sets `is_strategy: true`
  (`routes/objectives-crud.ts`). It is never inferred.
- An earlier version inferred it from `delegate_mode = 1 AND parent_id IS NULL`. That rule
  stamped almost every top-level card and was removed (obj 2835).
- **Why a flag, not `type='strategy'`:** `type` is the orthogonal kind-of-work
  axis. Adding `strategy` to it would re-introduce the exact tier/type collision
  this work removes. The tier lives on its own marker.

#### Selecting all strategies — one query, no derivation

```sql
SELECT * FROM objectives WHERE is_strategy = 1;
```

Endpoint: `GET /api/internal/strategies` (optional `?workspace=`). No
`depth + delegate_mode` join required.

### UI label reconciliation

- **Strategy** renders a `STRATEGY` tier badge (`STRATEGY_BADGE` in
  `app/shared/workflow.ts`), on a separate visual axis from the `type` badge.
- A delegator's children render under the **"Workers"** header while the delegator
  is active (the running synonym); other (manual) children render under
  **"Sub-objectives"** — the canonical noun. Neither label is an orphan: both map
  to *Sub-objective* here.

### Back-compatibility

Additive and back-compatible. Absence of the marker (`is_strategy = 0`) preserves
prior behavior; no existing flow changes. The flag-gated nesting guard
(`CC_STRATEGY_TIER`, obj 2286) and the depth model are unchanged — `is_strategy`
is a parallel, additive marker.
