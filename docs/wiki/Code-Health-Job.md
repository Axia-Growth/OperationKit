# Code-health Job (obj 901770)

A regular janitor pass on one linked repo, separate from feature cards, that lands only small, gated cleanups.

## Turning it on

**Settings → Workspaces →** open the workspace **→ Repos & projects →** the repo's **⋯** menu **→ Code health weekly** (or **daily**). Admins only, and only from the browser: `PUT /api/admin/workspaces/:slug/repos/:id/code-health` refuses an API key or bearer token (`cookie_admin_only`), so a bot cannot schedule runs. The repo needs a GitHub link (`owner/name`); without one the menu item is disabled and the route answers `repo_not_linked`. **Stop code health** switches it off.

Default is off: no `code_health_jobs` row = no routine = no runs. Nothing changes on an existing install until an admin switches a repo on.

## What a run does

The switch drives one ordinary AI routine named `code-health:<repo id>` (`max_queue_depth` 1, weekly Monday or daily, 07:xx server time). Each fire files a `task` card with `create_pr` on, `project` = the repo name, assigned to the admin who switched it on. The brief (`codeHealthBrief` in `app/server/src/services/code-health.ts`) tells the worker to:

1. stop with `skipped-open-pr(#n)` if a "Code health" PR is already open on the repo;
2. pick ONE small slice: dead code, a duplicated helper, a type/lint warning, a stale TODO, a missing small test, a typo;
3. stay under the cap (default 8 files / 200 changed lines), with no schema, dependency, Dockerfile, CI, sign-in or payment changes;
4. run the repo's own checks and open the PR — never merge, never deploy;
5. or report "nothing to do", or raise a bigger finding in Needs You (job disposition `needs_review` with a decision briefing), never as a PR.

## What the server enforces (not just the brief)

| Rule | Where |
|---|---|
| Every code-health PR gets the independent AI review (a routine `task` with a backend-only PR would otherwise be "green" and auto-complete with no reviewer) | `alwaysReviewPr` in `decideWorkerEndRoute` (`services/poller-decisions.ts`), set by `poller-loop.ts` from `isCodeHealthCard` |
| Only a lightweight PR may auto-merge: size read from GitHub, over the cap / a schema or migration path / a rebuild path (Dockerfile, compose, package.json, lockfiles) / `.github/` / unreadable size → `skip`, so it stays in review (Needs You) for a person | `codeHealthMergeBlock` → `decideAutoMerge` (`services/auto-merge.ts`) |
| Auto-merge still needs `settings.auto_merge_enabled`, a `pass` verdict, green checks and a clean PR — unchanged | `services/auto-merge.ts` |
| A code-health merge never auto-deploys | `isCodeHealthPr` in `routes/github-webhook.ts` |
| One waiting PR per repo: a fire is skipped (`code-health guard`, a benign skip that never counts toward auto-pause) while an earlier run's PR sits in review | `codeHealthFireRefusal`, called from `routine-scheduler.ts` |
| A removed or unlinked repo switches its routine off (route on delete, boot resync) | `disableCodeHealthForRepo`, `resyncCodeHealthRoutines` |

Caps: `settings.code_health_max_files` (1-50, default 8) and `settings.code_health_max_lines` (10-2000, default 200), read at point of use and written into the brief on the next save or boot.

## Not here

Production-issue intake and the touched-area feature-card pass are sibling cards. This Job never deploys and never merges on its own beyond the existing green auto-merge path.

Tests: `services/code-health.test.ts`, `routes/admin-workspaces-code-health.test.ts`, `client/.../WorkspacesTab.codeHealth.test.tsx`.
