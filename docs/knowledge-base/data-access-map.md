# The data-access map: where your data lives, and how to query it

Your knowledge base holds two kinds of knowledge already: **facts** (people, companies,
decisions) and **how-tos** (runbooks, skills). The data-access map is the third kind:
**which system holds which data, and how to get at it.** "Orders are in BigQuery,
`analytics.orders`; revenue is `amount_cents / 100`; the CRM is the source of truth for
deal stage, not the sheet."

It is one plain markdown page per workspace, plus a small folder of flags:

| File | What it is | Who writes it |
|---|---|---|
| `data-access/map.md` | The map: one section per source | You, or the curator |
| `data-access/flags/<date>-<source>-<what-changed>.md` | One file per "the map is wrong" report | Any agent that hits a problem |

Both sit inside the workspace's own knowledge folder (for example
`workspaces/acme/data-access/map.md`), so they are searchable, linkable and visible in
Obsidian like every other page.

## The rule: flag, don't copy

**The map holds instructions, never the data.** Do not put rows, exports, query
results, screenshots of tables or schema dumps of your warehouse, CRM, database or
spreadsheets into the knowledge base.

Why:

- **A copy goes stale the day you make it.** The warehouse is current; a pasted table
  is a snapshot that agents will then trust over the real thing.
- **A copy leaks.** The knowledge base is read by every agent and bot in the workspace,
  indexed for search and often synced to git. Customer rows do not belong there.
- **The source already has the data.** Connectors (GitHub, Google Workspace, MCP
  servers) and saved credentials in **Settings → Secrets** already reach it. The map
  only has to say where to look and how.

What does belong in the map: the system's name, what lives there, which table / sheet /
endpoint to use, which connector or secret **name** reaches it (never the value), a
query that works, and the gotchas ("dates are UTC", "`status = 4` means cancelled").

## How agents use it

When a workspace has `data-access/map.md`, every board-card worker in that workspace
gets a short **Data-access map** section in its instructions. It tells the agent to:

1. **Read the map before querying a source**, and use the source, table and query it
   names. Query the live source; the map is a pointer, not a copy.
2. **Never copy data into the knowledge base.**
3. **Flag, don't fix.** If the map is wrong (a renamed column, a moved table, a new or
   retired source, a query that stopped working), work around it, finish the card, then
   write **one** flag file. The agent does not edit `map.md` itself.

The section also says how many flags are already open, so an agent that hits a problem
first checks whether someone has flagged it.

A workspace with no map gets nothing extra: its agents' instructions are exactly as
before. Making the page is what turns the section on.

Chat bots find the map like any other page (`search`, `read_file`). A bot with
`write_doc` flags the same way, by writing a file into `data-access/flags/`.

## A flag

One small file per problem, named `YYYY-MM-DD-<source>-<what-changed>.md` (for example
`2026-11-23-bigquery-orders-amount-renamed.md`). One file each, rather than a line in a
shared page, so two agents flagging at the same time never overwrite each other.

```markdown
---
kind: knowledge-gap
target: data-access/map.md
gap: renamed-field
source: BigQuery: analytics.orders
status: open
flagged_by: card #1234
date: 2026-11-23
---
What the map says: revenue is `amount_cents / 100`.
What is true now: the column is `amount_minor` (since the 20 Nov migration).
How I worked around it: `SUM(amount_minor) / 100` on `analytics.orders`.
Evidence: BigQuery error "Unrecognized name: amount_cents".
```

`gap` is one of `renamed-field`, `moved-source`, `new-source`, `dead-source`,
`wrong-query` or `other`. Names only: no rows, no results, no secret values.

The frontmatter (`kind: knowledge-gap`, `target:`) is the shape a general
knowledge-gap flag uses, so a gap-flag tool can file or read these without any change.
A flag typed by hand with no frontmatter still counts as open.

## The curator: keeping the map current

Someone (a person, or a scheduled curator agent) works through the open flags, usually
once a day:

1. List `data-access/flags/` and open each flag whose `status` is `open`.
2. Check it against the live source (the schema or the error, not the data).
3. Edit `data-access/map.md`: fix the line, add the new source, or mark one retired.
4. Set the flag's `status` to `resolved` (or `rejected` with one line why) and add
   `resolved_in: data-access/map.md`. Resolved flags can stay as a history or be moved
   to an archive folder.

`resolved`, `rejected`, `wontfix`, `closed` and `done` all count as closed; anything
else (or no status) is open.

## Starting a map

Create `data-access/map.md` in the workspace's knowledge folder (Knowledge base → the
workspace folder → new page, or ask a bot with `write_doc`, or a card) and fill in what
you know. A starter:

```markdown
# Data-access map

Where current data lives and how to query it. Instructions only: never paste rows,
exports or query results here. Found something wrong? Add a flag in
`data-access/flags/` (see docs/knowledge-base/data-access-map.md); do not edit this page
from a card.

Last reviewed: YYYY-MM-DD

## <Source name, e.g. BigQuery: analytics>

- **Holds:** orders, refunds, daily revenue (source of truth for revenue)
- **Reach it with:** MCP server `bigquery` / secret `BQ_SERVICE_ACCOUNT_JSON` (name only)
- **Use:** `analytics.orders` (one row per order), `analytics.refunds`
- **Query that works:** `SELECT DATE(created_at), SUM(amount_minor)/100 FROM analytics.orders GROUP BY 1`
- **Gotchas:** timestamps are UTC; `status = 4` is cancelled
- **Owner:** <person or team who can answer questions>

## <Next source, e.g. HubSpot CRM>

- **Holds:** deals, deal stage (source of truth), contacts
- **Reach it with:** connector in Settings → Integrations
- **Use:** ...
- **Gotchas:** ...
- **Owner:** ...

## Not the source of truth

- The "Pipeline" Google Sheet is a weekly export of the CRM. Use the CRM.
```

## For developers

Code: `app/server/src/services/data-access-map.ts` (`readDataAccessMapState`,
`buildDataAccessBlock`, `parseDataAccessFlag`), folder names in
`app/server/src/lib/vault-layout.ts`, rendered by `buildPrompt` right after the
knowledge-base block. It only reads the knowledge base; flags are written through the
existing write paths (`PUT /api/docs/file`, chat `write_doc`), which already re-index.
Symlinks are not followed.
