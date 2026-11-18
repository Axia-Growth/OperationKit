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
| — behind branch | `BEHIND` → GitHub update-branch pinned to the head it read (a merge from base; no rebase, no force push) → row in `dev_ops_pending_merges` → the 30 s tick merges it pinned to the **new** head once CI there is green | the new head must be GitHub's update commit (two parents, one the head we read) — a push made while waiting is never merged; red CI on the new head fails it; re-updates at most 3 times; expires after 90 min; the switch, the person's admin role, the card, its PR link and the reserved list (for the stored `repo#pr`) are re-checked on every pass |
| `dev_close_card {id, status}` | done / cancelled without the admin sign-off prompt | done on a PR card only when GitHub says `MERGED`; done without a PR and cancelled only for Dev's own cards; never a Strategy or a reserved-PR card; runs the real status handler (`pathway dev-ops:close-*`, not a human terminal) |
| `dev_deploy` | `sudo bash /opt/operationkit-src/install/update.sh --config /opt/operationkit-src/client.conf` on the host, detached | one at a time, 2 min cool-down; update.sh takes the backup; never `--skip-cloudflare`, `--skip-backup` or a force flag (asserted by tests) |
| `dev_deploy_status` | outcome of the latest deploys | — |
| `cloudflare_access {action, email}` | list the "Allowed people" policy, add ONE exact email, remove ONE email | no domain / wildcard / `everyone` / list allow, ever; protected addresses never removed; a write may change only that one entry, carries every other policy setting (approvals, purpose justification, isolation, MFA, session) unchanged, and the runner re-reads the policy to prove every other entry of every kind and every setting survived |
| `cloudflare_dns {action, …}` | list / upsert / delete a record in the install's zone | A, AAAA, CNAME, TXT, MX only; inside `ZONE`; never the install's own `DOMAIN` record; a change or delete must match exactly one record |
| `cloudflare_run {command}` | `install/cloudflare.sh status | api-bypass | api-bic` | never `down`, `up --replace-dns` or `agent-pass add` |
| `dev_ops_audit {limit}` | the latest audit rows | — |

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
4. writes `<data>/dev-ops/deploy-<id>.json`; the full log stays on the host in
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
`deploy_settled`) and per switch change. Columns: bot, person, action, target, card,
outcome (`allowed` / `refused` / `started` / `waiting` / `done` / `failed` /
`rolled_back`), code, redacted detail.

## Tests

- `services/dev-ops/dev-ops.test.ts` — gate, merge relaxations, behind-branch update,
  PR 645, close, deploy start/settle, Cloudflare guards, secret non-exposure, audit.
- `services/dev-ops/host-runner.test.ts` — the runner under bash with stubbed host
  tools: exact update.sh call, rollback on verify / health failure, no rollback when
  update.sh fails before its backup, Access write guards, token only on curl's stdin.
