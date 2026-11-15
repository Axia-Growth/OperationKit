# Product glossary (UI words)

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
