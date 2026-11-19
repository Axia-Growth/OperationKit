# Guarded auto-deploy for Operation Kit Dev merges

Card #901466. Owner decision #53 on card #901383 (option B, "Merges and deploys").
Status: **design for the owner to approve.** The pull request also carries the guard
(the decision code and its tests, `services/dev-ops/auto-deploy-guard.ts`), switched
off and not wired to anything. Nothing deploys because of this pull request.

## Summary (one page)

**What would deploy by itself.** A batch of commits waiting on `main` where *every*
commit is the squash-merge of an Operation Kit Dev card that passed its AI review and
was green on CI, merged by the server's own Dev merge path. Nothing else.

**What never would.** A batch that holds even one commit from anywhere else (a person's
merge, another bot, a direct push), a database or migration change, a protected pull
request (645), anything while the live code folder has local edits, while a deploy is
already running, while cards are working, or after an automatic deploy rolled back and
the owner has not looked at it yet.

**How it runs and rolls back.** It uses the deploy Dev already uses in chat: `update.sh`
on the host (backup first, keep the old images), then `verify.sh` and the public
`/api/health`. If either fails, it puts back the old code, images and database backup on
its own. That catches a site that is down. It does not catch a site that is up but wrong,
so the design adds a cap of 3 a day, a stop after one rollback, a deploy window, and
(follow-up) a smoke test after restart.

**How to switch it off.** One switch on the Dev bot's settings panel, off by default,
admin-only in the browser. Turning it off is the one-click stop: no new automatic deploy
starts. A deploy already half-way through finishes (and rolls back if it fails), because
stopping `update.sh` mid-way is worse than letting it end.

**What the owner decides in this PR.**
1. Approve or change the guards below.
2. Pick how far it goes: **A** any time, **B** only inside a daytime window
   (recommended), or **C** only small batches. See "Options".
3. Approve the follow-up build cards listed at the end. Turning the switch on is a
   separate, later click.

---

## 1. Trigger: what starts a deploy with no chat turn

Three deploy paths exist today:

| path | what it does | used by |
|---|---|---|
| `scripts/self-deploy.sh` via `services/auto-deploy.ts` | hot restart of the Node server on the operator host; fired from the GitHub merge webhook when `settings.auto_deploy_enabled='1'` (off) | the old command-center auto-deploy |
| `POST /api/internal/deploy` | same self-deploy, called by sessions | operators |
| `update.sh` via `host-runner.sh deploy` (`services/dev-ops/deploy.ts`, `startDevDeploy`) | backup → keep old images → fetch main → re-install → `verify.sh` → public health → **full rollback** (code, images, database backup) on failure; one at a time; a `dev_ops_deploys` row and audit rows | `dev_deploy` in the Dev chat |

**The automatic deploy uses the third one, `startDevDeploy`, and nothing else.** It is the
only path with a backup and a rollback that also puts the database back, it is what the
owner already approved for Dev, it already refuses a second deploy while one runs, and its
outcome already lands in `dev_ops_deploys` + `dev_ops_audit`. No third path is added.
`settings.auto_deploy_enabled` and `services/auto-deploy.ts` stay as they are (off); the new
switch is a separate setting, `dev_auto_deploy_enabled`. Turning the new switch on while
`auto_deploy_enabled='1'` is refused at save time, so two automatic deploys can never race.

**What starts it.** The dev-ops background tick (`services/dev-ops/tick.ts`, every 30 s,
host only) gets one more step, run at most every 5 minutes:

1. Read the live install's commit (the host preflight below) and `origin/main`'s tip.
2. If they differ, wait until `main` has been quiet for 10 minutes (no new commit), so a
   burst of merges goes out as one deploy.
3. Gather the facts below, call `decideDevAutoDeploy`, and either start the deploy or write
   one refusal.

Two small changes to the deploy path itself are part of the build:

- **Pin the commit.** Today `update.sh` deploys whatever `main` is when it runs. The
  automatic deploy passes the exact commit the guard checked (`update.sh --ref <sha>`), and
  `host-runner.sh` fails the deploy if the commit it ends up on is not that one. Without
  this, a merge landing between the check and the fetch would ship unchecked.
- **A host preflight.** A new read-only `host-runner.sh preflight` action reports the live
  code folder's `HEAD`, whether tracked files have local edits
  (`git status --porcelain --untracked-files=no`, the same test `update.sh` dies on) and
  whether `HEAD` is an ancestor of `origin/main`.

The automatic deploy is recorded as a normal `dev_ops_deploys` row with
`bot_slug='operation-kit-dev'`, `user_id = NULL` and `username = 'auto-deploy'`, so it needs
no new column and no migration.

## 2. What may deploy by itself, and how each commit is proven

The batch is every commit in `live HEAD..pinned sha` on `main` (GitHub
`GET /repos/{repo}/compare/{live}...{sha}`). Every merge on this repo is a squash-merge
(`gh pr merge --squash` in both `dev-ops/merge.ts` and `grant-merge.ts`), so each commit on
`main` is one pull request. For **every** commit the build proves all of this
(`commitProvenanceGap` in the guard):

| check | how |
|---|---|
| it is one merged pull request | `GET /repos/{repo}/commits/{sha}/pulls` returns a PR whose `merge_commit_sha` is this commit |
| a card carries that PR | `objectives.pr_url` / `pr_number` |
| it is Dev's own card | `isDevCard()` from `dev-ops/merge.ts` (filed by Dev's chat, or owned by Dev and created by an admin or the system) |
| the server merged it as Dev | a `dev_ops_audit` row `merge` / `merge_on_green` with outcome `done` for `repo#N`, or the standing-merge / grant-merge `approval_used` row for that PR (PR 889, `grant-merge.ts`). A person's merge, the background auto-merge, or no record = not proven |
| its AI review **passed** | `ai_review_verdict = 'pass'`. This is stricter than `dev_merge`, which may merge with no review: an unreviewed merge waits for the owner. When the review-head record (card #901455) has landed, the reviewed commit must also equal the merged head |
| CI was green | `ciGreenForMerge` on the head the merge was pinned to (the sha in the audit row) |

**When the batch also holds a commit that did not come that way: deploy nothing.** One line
goes to the owner naming the first such commit and why ("3 of 4 waiting commits are Dev
merges; `ab12…` is PR #890, merged by a person — deploy this batch yourself"). The owner
deploys by saying "deploy" in the Dev chat as today; once the live install is past that
commit, the next batch can be clean again. Deploying just the clean commits before the
foreign one was considered and left out: it is more code, and it means the live install
runs a `main` nobody tested as a whole.

## 3. Hard refusals

Each has one code in `decideDevAutoDeploy` and one test in `auto-deploy-guard.test.ts`.

| refusal | code | exact check |
|---|---|---|
| switch off (default) | `switch_off` | `settings.dev_auto_deploy_enabled` is not exactly `'1'`; no row, unreadable or any other value = off |
| a commit not from a Dev merge | `not_dev_merge` | any commit fails a row of the table in point 2 |
| database / migration change | `migration_in_batch` | any changed file under `app/server/src/db/` or in a `migrations/` folder, test files excepted. Same rule as `lib/migration-paths.ts` in PR 888 / 892; the guard holds an identical copy until one of those merges, then imports it |
| protected pull request | `reserved_pr` | a PR in the batch matches `loadReservedPrs()` (seed `operationkit#645`, `grant_merge_reserved_prs`, `CC_GRANT_MERGE_RESERVED_PRS`), same matching as the merge paths |
| dirty live checkout | `checkout_dirty` | host preflight: `git status --porcelain --untracked-files=no` is not empty |
| live checkout has its own commits | `checkout_ahead` | host preflight: live `HEAD` is not an ancestor of `origin/main` |
| a deploy already running | `deploy_running` | a `dev_ops_deploys` row is `started` (chat or automatic); `host-runner.sh` also holds its `deploy.lock` |
| cards working | `cards_working` | any card in `planning` / `working` (a live session; `queue` has none yet): `update.sh` re-creates the app container, which cuts their sessions. The tick waits and tries again; after 6 hours of waiting it tells the owner once |
| a previous automatic deploy went wrong | `rollback_not_cleared` | the newest `username='auto-deploy'` deploy ended `rolled_back`, `rollback_failed` or `failed`, and the owner has not pressed "Looked at it" (stored as `dev_auto_deploy_cleared_through = <deploy id>`) |
| daily cap | `daily_cap` | automatic deploys started in the last 24 h ≥ `dev_auto_deploy_daily_cap` (default 3) |
| outside the window | `outside_window` | only with option B: the hour in the install time zone is outside `dev_auto_deploy_window` (e.g. `9-18`) |
| batch too large | `batch_too_large` | only with option C: distinct files changed > `dev_auto_deploy_max_files` |

## 4. Rollback: what it catches and what it does not

**Caught today (automatic rollback):**
- `update.sh` fails: fetch, build or installer error.
- `verify.sh` fails on the new version.
- The public `<url>/api/health` does not return a real 200 within about a minute (a
  redirect to a login page is not healthy).

Rollback puts back the old commit, the old images and the pre-update **database backup**.
Anything written to the database between the backup and the rollback (a few minutes of
card events and chat) is lost. That is acceptable for a site that is down; it is one more
reason not to roll back late.

Note: the local wait for the app only warns; `verify.sh` and the public health check are
what decide.

**Not caught:** a site that answers health but behaves wrongly. A page that loads blank
because of a JavaScript error (health is a server route; the browser bundle is never
loaded), a button or route that now returns 500, a chat tool that errors, a background job
(poller, routine, wake) that breaks quietly, or something that goes wrong an hour later.

**Extra guards, costed:**

| guard | catches | cost | in this design |
|---|---|---|---|
| stop after one bad automatic deploy until the owner clears it | a second bad deploy on top of the first | one click for the owner after each bad one | **yes** (guard built) |
| daily cap, default 3 | a bad loop of deploy → fix → deploy | a busy day waits for the next day or the owner | **yes** (guard built) |
| deploy window (option B) | a bad deploy while nobody is around to notice | merges wait up to ~15 hours | **yes** (guard built; on only if B is chosen) |
| smoke test after restart: the card browser loads `/` signed in (`--sign-in`) with no console error, plus GETs of ~5 key routes (`/api/objectives?limit=1`, `/api/agent-chat/agents`, …) expecting 200 | blank page, broken bundle, a core route that 500s | about one day to build (in `host-runner.sh` after health, or in the app's first tick after restart); adds 1-2 minutes to a deploy; a flaky check would roll back a good deploy | **follow-up card**, recommended before switching on |
| 30-minute watch after each automatic deploy: count server errors and sessions that ended abnormally against the previous 30 minutes; above a threshold, one alert line and the switch turns itself off (no rollback; too late, data would be lost) | slow, quiet breakage | about one day; thresholds need tuning | follow-up card, optional |

## 5. Owner controls, notices and audit

- **The switch.** `dev_auto_deploy_enabled`, its own `settings` row, off when absent. Shown
  in the "Operator tools" section of the Operation Kit Dev settings panel, next to the
  existing dev-ops switch. Changed only by an admin signed in in the browser (cookie), never
  an API key, a token, a bot or a wake — the same rule as `setDevOpsSwitch`. Turning the
  dev-ops switch off also stops automatic deploys (the tick checks both).
- **One-click stop.** The same toggle. Turning it off stops any new automatic deploy at
  once (read on every tick). A deploy already running is not killed half-way (see the
  summary); the panel says which deploy is running and links its status.
- **"Looked at it".** After a bad automatic deploy the panel shows the deploy, its log tail
  and one button that clears the stop (`rollback_not_cleared`).
- **Window / file limit / daily cap.** Three small fields on the same panel, only shown
  for the option chosen.
- **Who is told, where.** One line in the Operation Kit Dev chat of the admin who switched
  it on (else the first admin), for: a deploy started (commits, PRs, target commit), its
  outcome (deployed / rolled back / rollback failed), and each refusal. A refusal is said
  once per batch tip and code, not every 5 minutes. `rollback_failed` also raises a
  high-severity alert (AlertBell), because the site needs a person.
- **Audit.** Every attempt, allowed or refused, writes a `dev_ops_audit` row:
  `action='auto_deploy'`, `outcome` `started` / `refused`, `code` = the guard code,
  `target` = the pinned sha, `detail` = the commits and PRs in the batch and the reason. The
  outcome is written by the existing `settleDeploys` as `deploy_settled`. Duplicate
  refusals (same tip, same code) are not written again.

## 6. What stays out whatever happens

Not by this feature, not by any setting it adds:

- secret values and keys (reading, minting, revoking);
- DNS and Cloudflare Access (the deploy runs `update.sh` without `--skip-cloudflare`, as the
  chat deploy does, so Cloudflare is only reconciled to the install's own config; nothing
  is added or removed);
- billing;
- protected pull requests (645 and the reserved list);
- production migrations or schema changes without the owner's approval (refused above);
- `devOpsGate`, the dev-ops switch default and `settings.auto_deploy_enabled` are not
  changed. The chat tools still need an admin typing in the browser.

## 7. Options: how far to go

| | A. every clean batch, any time | **B. clean batches inside a daytime window** | C. clean batches up to N files, any time |
|---|---|---|---|
| setting | none | `dev_auto_deploy_window = 9-18` (install time zone) | `dev_auto_deploy_max_files = 20` |
| good | fastest; nothing waits | a bad deploy happens when the owner is likely around to see it; the health rollback does not catch "up but wrong", a person does | small changes go out at once; big ones wait for the owner |
| bad | a quiet breakage at 3 am runs until morning | merges after 18:00 wait until morning | file count is a weak stand-in for risk; one file can break a page |

**Recommendation: B**, with the daily cap of 3 and the stop-after-one-bad-deploy, and the
smoke test built before the switch is first turned on. The automatic rollback only covers
"site down"; for "site up but wrong" the safety net is a person noticing, so deploys should
land when one is around. A, B and C are all settings on the same guard, so changing your
mind later is a settings change, not code.

## Build status and follow-up cards

**In this pull request:** `services/dev-ops/auto-deploy-guard.ts`: the decision
(`decideDevAutoDeploy`), the per-commit proof (`commitProvenanceGap`), the migration rule,
the window and the policy reader (`readDevAutoDeployPolicy`, off without a row), with a test
for every refusal above. **Nothing calls it.** No setting is written, no route or panel is
added, the tick is unchanged.

**Follow-up cards (to file after the owner approves this design):**
1. Fact gathering: GitHub compare + commit → PR → card lookup, merge-path proof from the
   audit rows, CI on the merged head (`ciGreenForMerge`), reserved list, working cards,
   last automatic deploy, 24 h count.
2. `host-runner.sh`: `preflight` action (HEAD, dirty, ahead) and a pinned `--ref <sha>`
   for `deploy`, failing when the deployed commit is not the pinned one.
3. Trigger: the 5-minute step in the dev-ops tick with the 10-minute quiet wait, calling
   `startDevDeploy` as `auto-deploy`; audit rows and the once-per-batch chat lines.
4. Owner panel: the switch (cookie-admin route), the stop, "Looked at it", the
   option fields; refuse turning on while `auto_deploy_enabled='1'`.
5. Smoke test after restart (recommended before first switch-on).
6. Optional: the 30-minute watch.

Cards 1-4 are needed for the feature to do anything; then the owner switches it on.
