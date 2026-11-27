# Production Issue Intake

Turn a problem in your **live app** into board work: an alert, an error report or a
pasted log becomes a bug card with the evidence attached. A worker may open a pull
request with the fix. The independent AI review runs on it. **A person merges.**
Nothing in this feature merges, deploys, restarts a host, or changes DNS or
Cloudflare (obj 901771).

This is not the board's own self-healing. The stall watchdog (#900372), the
session retry (#900547) and High Agency (#900795) keep the *board* running. This
page is about the *client's production app*.

## The human-merge rule

Every card this intake files carries this rule, and the server enforces it:

1. A worker may open a pull request with the fix. That is the whole deliverable.
2. The independent AI review always runs on that pull request. The card never
   takes the green lane (which skips the reviewer), and `skip_ai_review` is
   ignored on it.
3. **A person merges anything that ships to production.** These refuse the card:
   - background auto-merge (`settings.auto_merge_enabled`),
   - a grant merge (`approval: merge`, the chat tool `merge_approved_pr`, and
     standing merges, which all share `precheckGrantMerge`),
   - the Dev bot's `dev_merge_pr` and `dev_merge_repo_pr`.
   Each refusal has the code `production_issue`.
4. **No auto-deploy.** When the card's pull request is merged, the merged-PR
   webhook does not auto-deploy it, whoever merged it. The log line is
   `[auto-deploy] SKIPPED — … fixes production-issue card #N`. A person deploys.
5. The worker never deploys, restarts or rolls back a live host, and never
   touches DNS, Cloudflare or Cloudflare Access. Never `--skip-cloudflare`.

The check is one function, `isProductionIssueCard()` in
`app/server/src/lib/production-issue.ts`: the card's `origin` is
`production-issue`. A new merge or deploy path must call it.

## Three ways in

| Way | Who | Where |
|---|---|---|
| Paste a report | anyone in the workspace, signed in | Settings → Integrations → Production issues → **Paste a report**, or `POST /api/production-intake/report` |
| Webhook | a monitor or error tracker | `POST /api/production-intake/signal` with an intake token |
| By hand | anyone | a normal card on the board (no human-merge guard unless filed here) |

### Create a webhook (admin)

Settings → Integrations → Production issues → **Webhooks**. Give it a name (one per
tool, for example "Sentry - storefront"), an optional project (the repo the worker
gets), and choose whether each new card starts a bot (**Start a bot on each new card**). The token (`opi_…`) is
shown **once**; only its hash is stored. Revoke it on the same page.

Only an admin signed in to the app in the browser can create or revoke one. An API
key, a card session token or a bearer JWT gets a 403.

Send the token any one of three ways:

```bash
curl -X POST https://<your-install>/api/production-intake/signal \
  -H "X-Intake-Token: $INTAKE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Checkout returns 500","severity":"critical","service":"storefront","environment":"production","message":"TypeError: …","logs":["…"],"url":"https://logs.example.com/…"}'
# or:  -H "Authorization: Bearer $INTAKE_TOKEN"
# or:  https://<your-install>/api/production-intake/signal?token=<token>   (for tools that only take a URL)
```

If the install sits behind Cloudflare Access, the monitor needs an Access service
token or bypass for this one path. This feature does not change Access; an owner sets
that up by hand.

### What the webhook understands

| Sender | Recognised by | Recovery (no card) |
|---|---|---|
| Generic JSON | `title` (or `summary`, `message`, `error`) | `status` of `resolved`, `recovered`, `ok`, `up` |
| Sentry (integration platform and legacy webhook) | `data.issue` / `data.event`, or `culprit` + `project_name` + `url` | `action: "resolved"` |
| UptimeRobot (JSON or form-encoded) | `monitorID` / `monitorFriendlyName` | `alertType` 2 (up) or 3 (paused) |
| Prometheus Alertmanager / Grafana alerting | `alerts[]` + `status` | `status: "resolved"` |

Generic fields: `title`, `severity` (`critical`/`high`/`medium`/`low`, or
`fatal`/`error`/`warning`/`info`), `service`, `environment`, `url`, `message`,
`stack`, `logs` (array or text, last 200 lines kept), `occurred_at`, `fingerprint`.

## What happens to a signal

Every signal is stored in `production_signals`, whatever happens to it:

| Outcome | When | HTTP |
|---|---|---|
| `filed` | a new problem: one bug card is filed | 201 |
| `appended` | the same fingerprint already has an open card: a line is added to it | 200 |
| `ignored` | a recovery notice: no card (a line is added to an open card) | 200 |
| `rate_limited` | the workspace already filed `production_intake_max_cards_per_hour` (default 10) cards in the last hour | 200 |
| `disabled` | `settings.production_intake_enabled = '0'` | 200 |

The **fingerprint** is the sender's id (Sentry issue, UptimeRobot monitor,
Alertmanager group) or your `fingerprint` field. Otherwise it is service +
environment + the title with numbers and hex ids folded out, so "Timeout after
3012ms" and "Timeout after 2988ms" are one problem. Once the card is done or
cancelled, the next signal files a fresh card.

The card:

- type `bug`, category `development`, status `queue`, `create_pr = 1`,
  origin `production-issue`, in the token's workspace and project (never the
  body's);
- the evidence inside an untrusted-content frame (`source="production-signal"`),
  so text in an alert can't instruct the worker;
- a link to the full evidence: `GET /api/production-intake/signals/<id>` (members
  of the workspace; another workspace's signal reads as not found);
- three locked review criteria: root cause named, a regression test or check, and
  the work stops at an open pull request;
- the human-merge rule above, server-written, after the evidence.

Bodies are capped (64 KB raw) and secret-scrubbed on write (`production_signals` is
in `SCRUBBED_TABLES`).

## Starting the worker

By default a card waits in the queue for someone to start it. A webhook created with
**Start a bot on each new card** starts one through the same internal status
change a routine uses, so the session cap and duplicate guard apply. Either way the
worker can at most open a pull request.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `production_intake_enabled` | on | `'0'` records signals as `disabled` and files nothing |
| `production_intake_max_cards_per_hour` | 10 | new cards per workspace per hour |

## Code

- `app/server/src/services/production-intake.ts` — normalise, fingerprint, ingest, sources
- `app/server/src/routes/production-intake.ts` — the routes
- `app/server/src/lib/production-issue.ts` — `isProductionIssueCard()`
- `app/server/src/db/schema/production-intake.ts` — the two tables
- `app/client/src/components/connectors/ProductionIntakeSection.tsx` — the settings section
- Tests: `services/production-intake.test.ts`, `services/production-intake-merge-guards.test.ts`,
  `routes/production-intake.test.ts`, `ProductionIntakeSection.test.tsx`
