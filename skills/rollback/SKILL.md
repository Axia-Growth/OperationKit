---
name: rollback
description: Roll back a bad deploy (put the previous version and, if needed, the pre-update database back) or a bad merge (revert PR) on an Operation Kit install, using install/update.sh's own rollback points.
---

# Rollback

Use this when a deploy left the install broken, or a merged change has to be undone.
Every command below was read out of `install/update.sh`, `install/backup.sh`,
`install/verify.sh` and `app/server/src/services/dev-ops/host-runner.sh`. If those
scripts change, this skill must be re-checked against them.

## Who may do it

- **A rollback on the live server needs the owner's word, every time.** A typed message
  from the owner on the card or in chat. A bot's or script's message is not that.
- **One exception:** the automatic rollback inside the `dev_deploy` operator tool (see
  "What is automatic"). It runs by itself when its own verify or health check fails.
- Opening a revert pull request needs no approval. Merging it and deploying it do.
- Never force-push `main`. Never delete a backup folder or a `pre-update-*` image tag
  during a rollback.

## What is automatic, and what is not

- `install/update.sh` **does not roll back by itself.** It takes the backup, keeps the
  old images, installs the new code and **prints** the rollback steps (again if the
  installer fails). The verify run at the end of `install.sh` only warns on failure.
- The **`dev_deploy`** tool (host-runner.sh) **does** roll back by itself: it runs
  `update.sh`, waits for the app, runs `install/verify.sh`, then asks the public
  `/api/health` for a real `200`. If verify or health fails it checks out the old commit,
  re-tags the pre-update images, restores this run's pre-update backup, starts the stack
  and checks health again. Outcome is `rolled_back`, or `rollback_failed` (needs a person).
  If `update.sh` failed before a complete backup existed, nothing is rolled back.
- So: a deploy started with `dev_deploy` has usually rolled itself back already. Read
  `dev_deploy_status` first. A deploy run by hand with `update.sh` has not.

## What a rollback point holds

`update.sh` makes two things, each stamped with a UTC time. The two stamps come from
different clock reads and can differ by a few seconds.

1. A folder `INSTALL_DIR/backups/pre-update-<UTC time>/` (default `INSTALL_DIR` is
   `/opt/operationkit`), written by `backup.sh run --label pre-update`:
   - `command-center.db` — the database, SQLite online backup, integrity-checked
   - `data.tar.gz` — the rest of `state/data`: seat logins, uploads, branding
   - `secrets.tar.gz` — `secrets/`, including the key that decrypts stored secrets
   - `client.conf`, `install.env`, `MANIFEST` (label, created, **commit**, image id, sha256)
   - **Not in it:** `state/home` (projects, notes, the knowledge base, agent memory).
     A pre-update restore leaves home exactly as it is.
2. Image tags `operationkit-app:pre-update-<UTC time>`, `ok-jail:pre-update-<UTC time>`
   and `ok-jail-browser:pre-update-<UTC time>` (the last only if that image existed).

Kept: the 5 newest pre-update folders and the 3 newest tags per image. The previous code
is not copied anywhere; it is the old commit in the code folder's git history.

Not covered by any of this: changes the installer made in Cloudflare. Those have their
own commands, printed at the end of `update.sh`.

## A. Roll back a bad deploy (manual)

Run on the server, in the code folder. `<conf>` is the install's `client.conf` path.
Stop and report at any step that fails; do not improvise past it.

1. **Get the owner's word.** Tell them what is broken, which version you are going back
   to, and whether you plan to restore the database (step 6 loses data).

2. **Find out what is running and what you are going back to.**
   ```bash
   curl -fsS http://127.0.0.1:3002/api/health        # "commit" = what runs now
   ls -1d /opt/operationkit/backups/pre-update-*      # rollback points, oldest first
   sudo grep -E '^(label|created|commit)=' /opt/operationkit/backups/pre-update-<time>/MANIFEST
   sudo docker image ls operationkit-app --format '{{.Tag}}' | grep '^pre-update-'
   ```
   Pick the folder whose `commit=` is the **last good** version. Do not assume the newest
   folder: every `update.sh` run makes one, so after a failed re-try the newest folder
   holds the bad version. Pick the image tag with the closest time at or just before that
   folder's `created=`. Write down `OLD_SHA` (the MANIFEST commit), the folder and the tag.

3. **Check the folder is complete.** It must hold `command-center.db`, `data.tar.gz` and
   `secrets.tar.gz`. If the database file is missing, stop: there is nothing to restore
   the data from, and the owner must hear that first.
   ```bash
   sudo bash install/backup.sh restore /opt/operationkit/backups/pre-update-<time> --config <conf> --dry-run
   ```
   The dry run checks the files and the MANIFEST checksums and changes nothing.

4. **Old code.** Run git as the owner of the code folder (`stat -c %U .`); as root if
   root owns it.
   ```bash
   sudo -u <folder owner> git -c safe.directory='*' -C <code folder> checkout --detach <OLD_SHA>
   ```

5. **Old images.**
   ```bash
   sudo docker tag operationkit-app:pre-update-<tag time> operationkit-app:local
   sudo docker tag ok-jail:pre-update-<tag time> ok-jail:local
   sudo docker tag ok-jail-browser:pre-update-<tag time> ok-jail-browser:local   # only if that tag exists
   ```

6. **Old database — only if the new version changed data that must be undone.**
   This replaces the database, seat logins and secrets with the pre-update copies.
   **Everything written since the update is lost from the live install:** cards, chat,
   decisions, and any secret added or changed since. Skip this step when the old code
   can run on the current database.
   ```bash
   sudo bash install/backup.sh restore /opt/operationkit/backups/pre-update-<time> --config <conf> --yes
   ```
   It stops the app, removes the card sandboxes, moves the current data and secrets to
   `backups/pre-restore-<time>/` (kept, never deleted), puts the backup in place, starts
   the app and waits up to 4 minutes for it to answer.

7. **Start the stack.**
   ```bash
   cd <code folder> && sudo docker compose --project-name operationkit \
     --env-file /opt/operationkit/install.env --env-file /opt/operationkit/secrets/stack.env \
     -f install/docker-compose.yml up -d
   ```

8. **Verify.**
   ```bash
   sudo bash install/verify.sh --config <conf>       # every line PASS; exit 1 on any FAIL
   curl -fsS http://127.0.0.1:3002/api/health        # "commit" must be OLD_SHA (first 12 characters)
   curl -sS -o /dev/null -w '%{http_code}\n' --max-redirs 0 https://<the install's domain>/api/health
   ```
   The public check must print `200`. A redirect (the sign-in page) is a failure.

9. **Report** on the card: what failed, the commit before and after, the backup folder
   and image tag used, whether the database was restored (and so what was lost), the
   `pre-restore-<time>` folder if one was made, and the verify and health results.
   Running cards were cut off by the restart; say so.

If step 8 fails, do not try a second rollback on your own. Report and wait.

## B. Roll back a bad merge

1. On the **private upstream repository**, open a revert pull request for the bad merge:
   ```bash
   git fetch origin && git checkout -b revert-<pr number> origin/main
   git revert --no-edit <squash commit sha>        # a true merge commit needs: git revert -m 1 <sha>
   git push -u origin revert-<pr number>
   gh pr create --base main --title "Revert #<pr number>: <reason>" --body "<what broke, how it was seen>"
   ```
2. CI must be green. The merge needs the owner's approval like any other merge.
3. Once merged, the public sync opens its pull request on the public repository on its
   own (it runs on a merged pull request). That one is merged the normal way too.
4. The revert is live only after a deploy (`update.sh`, or `dev_deploy`), which needs the
   owner's word. Then confirm `/api/health` shows the new commit.
5. If the bad merge was **already deployed and the install is broken now**, do section A
   first to get the install working, then this section so the next update does not bring
   the bad change back.

Never force-push `main`, never reset it, never delete the bad commit. A revert is a new
commit on top.

A revert undoes code only. If the bad version already ran a database migration or wrote
bad data, say so in the report: that needs the database restore in section A, step 6, or
a forward fix.

## Stop and report instead of acting when

- there is no `pre-update-*` folder, or the one you need has no `command-center.db`
- the MANIFEST checksums do not match (`restore` refuses the folder)
- the image tag for the last good version has been pruned (only 3 are kept)
- `--skip-backup` was used for the bad update (no folder exists for it)
- the last good version is older than the oldest rollback point
- `dev_deploy_status` says `rollback_failed`

## Known gap: there is no one-command rollback

- A restore command exists for the **data** only: `install/backup.sh restore`. It does
  not touch the code or the images.
- There is **no** `install/rollback.sh`. The manual rollback in section A is nine steps
  and about ten commands, with one easy mistake (after a re-tried update the newest
  `pre-update-*` folder holds the bad version). That is more than a few commands.
- Proposed as a follow-up, **not built here**: card 901501 — add `install/rollback.sh`
  (pick the rollback point by commit, dry-run check, old code, old images, optional
  database restore behind an explicit flag, start, verify, print a report), and decide
  whether `update.sh` should get an opt-in automatic rollback like `dev_deploy` has.

## Not confirmed

- No rollback was run to test this skill. Every step comes from reading the scripts.
- The live server's real backup folders and image tags were not inspected.
- The revert-then-public-sync path in section B was read from `docs/OSS-SYNC.md`, not exercised.
- `okit new skill rollback` and `okit validate` were not run: the session that wrote this
  had no `okit` binary. The file was written by hand in the shape of
  `examples/workspace/skills/*/SKILL.md` (frontmatter `name` + `description`). Running
  `okit validate skills/rollback` where okit is installed is part of card 901501.
