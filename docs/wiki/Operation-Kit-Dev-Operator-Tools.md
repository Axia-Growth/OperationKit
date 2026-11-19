# Operation Kit Dev operator tools (obj 901424)

The owner approved (2026-11-18) a set of operator powers for exactly **one** bot,
Operation Kit Dev (chat slug `operation-kit-dev`), so it can build on the live server
without the merge, deploy, admin sign-off and Cloudflare walls. They sit behind **one
admin switch** and every call is audit-logged.

## The switch

- Bot settings panel → **Operator tools** (`DevOpsSection.tsx`).
- `GET|PUT /api/agent-chat/agents/:slug/dev-ops` (`{enabled: boolean}`); PUT is
  cookie-admin only (never an API key). Table `agent_chat_dev_ops`.
- **No row = ON** for `operation-kit-dev`. Any other slug is never eligible: the PUT
  answers `400 bot_not_eligible` and the tools are never offered.
- The tools exist only in a live chat turn whose message an **admin typed in the
  browser** (cookie session; `ToolContext.browserSession`, set by the messages route from
  `signedInBrowser`). Never through an API key or bearer token (the chat route is on the
  Cloudflare key-auth bypass list), never in a queued drain turn, a card wake or a
  bot-to-bot wake. The role is re-read every call. Full access and delegation grants are not
  consulted and do not add these tools.

## The tools

| Tool | What it does | Guards |
|---|---|---|
| `dev_merge_pr {id}` | Squash-merge a Dev card's PR once CI is green, pinned with `--match-head-commit`, then mark the card done | filed from Dev's chat (`agent_chat_cards`), or Dev-owned (`cardOwnerBot`) AND created by an admin or the system (a member's card that just names Dev does not count); card in review / done / blocked / ai_review (not queue / planning / working / cancelled); AI review may be missing but not `fail`/`blocked`; reserved PRs (seed 645 in both repos + `grant_merge_reserved_prs` + `CC_GRANT_MERGE_RESERVED_PRS`) refused **before any GitHub call**; Strategy and money-path refused; strict CI green; only GitHub `CLEAN` / `HAS_HOOKS` |
| — behind branch | `BEHIND` → GitHub update-branch pinned to the head it read (a merge from base; no rebase, no force push) → row in `dev_ops_pending_merges` → the 30 s tick merges it pinned to the **new** head once CI there is green | the new head must be GitHub's update commit (two parents, one the head we read) — a push made while waiting is never merged; red CI on the new head fails it; at most 3 branch updates per PR, all made while it is the head of the queue; expires 90 min after it reaches the head; the switch, the person's admin role, the card, its PR link and the reserved list (for the stored `repo#pr`) are re-checked on every pass |
| — merge queue (obj 901463) | The `waiting` rows of one repo are an ordered queue (lowest id = the order asked). Only the **head** has its branch updated and CI awaited. A PR asked for while another is waiting gets `queued_behind` with its position and is not touched (no update-branch, no CI run, no GitHub read) until it reaches the head; then it is updated once and merges on green. A head that merges ends the pass for that repo (the next one starts on the next 30 s pass); a head that fails, expires or is skipped hands over in the same pass | waiting never counts toward the update cap or the 90 min; a conflicted head (GitHub `DIRTY`) is `conflict_skipped` and does not block the rest; a commit pushed while queued is `head_changed_while_queued`; every guard in the row above is re-checked when a PR reaches the head; a PR that could merge right now still joins the back of a non-empty queue; asking twice is `already_queued` |
| `dev_close_card {id, status}` | done / cancelled without the admin sign-off prompt | done on a PR card only when GitHub says `MERGED`; done without a PR and cancelled only for Dev's own cards; never a Strategy or a reserved-PR card; runs the real status handler (`pathway dev-ops:close-*`, not a human terminal) |
| `dev_deploy` | `sudo bash /opt/operationkit-src/install/update.sh --config /opt/operationkit-src/client.conf` on the host, detached | one at a time, 2 min cool-down; update.sh takes the backup; never `--skip-cloudflare`, `--skip-backup` or a force flag (asserted by tests) |
| `dev_deploy_status {id?}` | **read-only**: outcome of the latest deploys (each with `changed` + `outcome` words), `end_state` (live commit, public main, private main, sync PR, plain-words `summary`), and with a card `id` that card's PR on GitHub (merged?, merge sha, checks). See "Verify before done" below | reads only: `git rev-parse` / `git ls-remote` on the host, `gh` reads; no secret, no origin URL in the result |
| `cloudflare_access {action, email}` | list the "Allowed people" policy, add ONE exact email, remove ONE email | no domain / wildcard / `everyone` / list allow, ever; protected addresses never removed; a write may change only that one entry, carries every other policy setting (approvals, purpose justification, isolation, MFA, session) unchanged, and the runner re-reads the policy to prove every other entry of every kind and every setting survived |
| `cloudflare_dns {action, …}` | list / upsert / delete a record in the install's zone | A, AAAA, CNAME, TXT, MX only; inside `ZONE`; never the install's own `DOMAIN` record; a change or delete must match exactly one record |
| `cloudflare_run {command}` | `install/cloudflare.sh status | api-bypass | api-bic` | never `down`, `up --replace-dns` or `agent-pass add` |
| `dev_ops_audit {limit}` | the latest audit rows | — |

## Verify before done (obj 901495)

On 2026-11-18/19 Dev ran two deploys that changed nothing: the merged code sat in an
unmerged sync pull request, so the repo the server updates from had nothing new. Dev now
reads the end state itself and reports it in fixed words. The bot file
(`builtin/operation-kit-dev/agent.md` → "Verify before done") requires it; the tools
make it one call (`services/dev-ops/end-state.ts`).

**After a merge** Dev calls `dev_deploy_status {id}` and checks:

- GitHub says the PR is `MERGED` (not the card's status, not a worker's note);
- the merge commit (`pr.merge_sha`) and when it merged;
- the checks on the PR (`pr.checks`: passed / failed / still running).

`dev_merge_pr` itself now returns `merge_sha` (read back from GitHub after the merge) and
its message ends "Merged, not deployed".

**After a deploy** Dev calls `dev_deploy_status` and checks:

- the deploy row: `changed` and `outcome` ("Deploy ran, nothing changed: commit X before
  and after" when `from_sha == to_sha`; the host runner's own message says the same);
- `end_state.live_commit`: what this process runs, the same value `GET /api/health`
  reports (`lib/build-info.ts`, pinned at boot);
- `end_state.public_main`: head of the repo the server updates from. It comes from the
  host (`host-runner.sh src-info`: the source folder's `origin`, reduced to `owner/repo`,
  and `git ls-remote origin refs/heads/main`), so no repo name is configured and no
  GitHub credential is needed for it;
- `end_state.private_main`: head of the repo Dev's cards merge into (the repo of this
  bot's newest card PR; `gh api`, the credential the merge tool already uses);
- `end_state.sync_pr`: the newest pull request from `sync/from-upstream` on the public
  repo (an open one first): number, state, merged time;
- `end_state.source_checkout`: the host folder's own HEAD (pulled but app not restarted
  shows up here).

The two repos have separate histories, so a private sha is never compared with a public
one. "Is private main in what the server pulls?" is `private_waiting_on_sync`: true while
a sync PR is open, or when private main is newer than the last merged sync PR and none is
open.

| `end_state.state` | When | Dev says |
|---|---|---|
| `deployed` | live commit = public main head, nothing waiting on the sync | "deployed, commit X live" |
| `merged_not_deployed` | live ≠ public main head, **or** live = public main head but merged code still waits on the sync PR | "merged, not deployed" + why |
| `unknown` | public main head could not be read | says which fact is missing (`notes`) |

`dev_deploy` reads the same state BEFORE it starts and returns `expect_change`
(`false` = the live commit is already the head of the repo the server updates from) with
a heads-up in the message. It still starts the deploy the admin asked for.

Overrides, read at point of use (none needed on a standard install): env
`CC_DEV_OPS_PUBLIC_REPO` / `CC_DEV_OPS_PRIVATE_REPO` / `CC_DEV_OPS_SYNC_BRANCH`, or
settings `dev_ops_public_repo` / `dev_ops_private_repo` / `dev_ops_sync_branch`.

No new credential and no wider GitHub scope: reading a public repo and the private repo
uses the credential `dev_merge_pr` already resolves (`grant-merge-github-auth.ts`).
Anything that could not be read is listed in `end_state.notes`; the tool never throws and
never guesses.

Note: an install that keeps its OWN copy of the bot file
(`<agents dir>/operation-kit-dev/agent.md`) overrides the built-in one, so the "Verify
before done" section has to be added to that copy too.

**Merge by repo and number (obj 901492).** `dev_merge_repo_pr` and `dev_refresh_pr_ci` exist only
while an admin has switched on **GitHub repo rights** for at least one repo (off by default, listed
per repo). They merge a PR no card links, the public sync PR included, and update a branch so CI
really starts. Grant, walls and the optional credential: [Dev-Bot-GitHub-Repo-Rights.md](./Dev-Bot-GitHub-Repo-Rights.md).

## Deploy flow (host)

`services/dev-ops/host-exec.ts` starts a throwaway privileged helper container
(`operationkit-app:local`, `--pid=host`, `nsenter -t 1`) that runs
`services/dev-ops/host-runner.sh` on the host — the same reach `preview-spool.ts`
uses. The script **text** is passed as `bash -c`, so the runner is the one the running
server shipped with, never a file the update is rewriting. The deploy:

1. runs update.sh exactly as above (backup of DB, seat logins, secrets, client.conf;
   old images tagged `pre-update-<time>`);
2. waits for the app, runs `install/verify.sh`, then checks `<public url>/api/health` —
   a real `200` with no redirect (an Access login redirect is a failure);
3. on a verify or health failure, rolls back with update.sh's own rollback steps: the
   old commit, the pre-update images, `install/backup.sh restore <this run's backup>
   --yes` (only a COMPLETE backup folder of this run counts), `docker compose … up -d`,
   then health again → `rolled_back` (or
   `rollback_failed`, which needs a person);
4. when the commit is the same before and after (update.sh found nothing newer at
   `origin main` of the code folder), the outcome is **`unchanged`** ("nothing new to
   deploy"), never `deployed`. `dev_deploy_status` also carries `new_code_live`. The
   server pulls from its own code source: on an install that follows a synced copy of
   the repo, a merged pull request is deployable only after the open "Sync from
   upstream" pull request on that copy is merged (obj 901479);
5. writes `<data>/dev-ops/deploy-<id>.json`; the full log stays on the host in
   `<INSTALL_DIR>/dev-ops/deploy-<id>.log`.

The tick settles that file into `dev_ops_deploys` + an audit row after the restart.
Restoring the backup also restores the database to the moment before the update, so
rows written during a failed update are gone; the deploy row itself predates the
backup and survives.

Host paths: `CC_DEV_OPS_SRC_DIR` (default `/opt/operationkit-src`), `CC_DEV_OPS_CONFIG`
(default `<src>/client.conf`), `CC_DEV_OPS_HOST_DATA_DIR` (default: the `/app/data`
entry of `SESSION_JAIL_HOST_PATH_MAP`), `CC_DEV_OPS_HEALTH_URL` (default
`resolvePublicBaseUrl()/api/health`, must be https), `CC_DEV_OPS_HELPER_IMAGE`.

## Secrets

- The Cloudflare token stays in the installer's file on the host
  (`<INSTALL_DIR>/secrets/cloudflare-api-token`). The runner hands it to `curl -K -`
  on **stdin**, so it is never an argument, never printed and never in the output.
- Cloudflare request data (emails, DNS values, the protected list) goes to the runner on
  stdin, never in `docker run` argv.
- Everything the runner returns is passed through `redactForStorage` before it reaches
  the model, the chat or `dev_ops_audit.detail`.

## Protected Access addresses

Never removed: the owner's two sign-in addresses (seed, held as **SHA-256 hashes** in
`ACCESS_PROTECTED_SEED_SHA256` and in `host-runner.sh`), `OK_CF_ACCESS_PROTECTED_EMAILS`
(the installer's list), the setting `dev_ops_protected_access_emails`, every admin
user's email, the address held in the `EMAILGUARD_EMAIL` secret (read server-side), and
any extra hash in `CC_DEV_OPS_PROTECTED_SHA256`. Configuration only adds to the seed.

Why hashes: the live host runs the **published** tree, and `scripts/oss-genericize.sh`
rewrites personal domains, so a plain address would protect the wrong address on the
live host (the same trap as the PR 645 seed, obj 901326) and would publish it. The
protected list is never returned to the bot; a refusal only says "protected".

No tool can add a domain allow, so `ACCESS_ALLOWED_EMAIL_DOMAIN` stays as the owner
left it (empty).

## Audit

`dev_ops_audit` (`services/dev-ops/audit.ts`): one row per tool call, allowed or
refused, plus one per background step (`branch_update`, `merge_on_green`,
`merge_queue`, `deploy_settled`) and per switch change. Merge-queue rows: action
`merge`, code `queued_behind` / `already_queued` (the ask; detail gives the position
and the PRs ahead); action `merge_queue`, code `queued_behind` (its position changed),
`queue_next` (it is next) or `queue_head` (it is now first); action `merge_on_green`,
code `conflict_skipped` or `head_changed_while_queued` (taken out of the queue). Columns: bot, person, action, target, card,
outcome (`allowed` / `refused` / `started` / `waiting` / `done` / `failed` /
`rolled_back`), code, redacted detail.

## Guarded auto-deploy (design, obj 901466)

A deploy with no chat turn is designed in `docs/design/guarded-auto-deploy.md` and
is NOT live. Only the guard exists: `services/dev-ops/auto-deploy-guard.ts`
(`decideDevAutoDeploy`) refuses unless every waiting commit is a passed, green Dev
merge, with no migration, no reserved PR, a clean live checkout, no deploy running,
no cards working, no uncleared bad automatic deploy, under the daily cap and inside
the window / file limit the owner picks. Its switch, `settings.dev_auto_deploy_enabled`,
is off with no row and nothing reads it to deploy yet. `devOpsGate` is unchanged.

## Tests

- `services/dev-ops/dev-ops.test.ts` — gate, merge relaxations, behind-branch update,
  PR 645, close, deploy start/settle, Cloudflare guards, secret non-exposure, audit.
- `services/dev-ops/merge-queue.test.ts` — the merge queue against a fake GitHub with
  several PRs and a moving base: order, one update each, conflict skip, the cap and the
  90 min counted at the head only, every refusal at ask time and again at the head.
- `services/dev-ops/host-runner.test.ts` — the runner under bash with stubbed host
  tools: exact update.sh call, rollback on verify / health failure, no rollback when
  update.sh fails before its backup, Access write guards, token only on curl's stdin.
- `services/dev-ops/auto-deploy-guard.test.ts` — every auto-deploy refusal, the
  per-commit proof, the window, and the switch reading off by default.
