# Rollback: undo a bad deploy or a bad merge

> Repo copy of the knowledge-base page `workspaces/operationkit/runbooks/rollback.md`
> (same content; that page names the owner). Exact commands: `skills/rollback/SKILL.md`.

Plain-language version. The bots follow the same steps from the skill
`skills/rollback/SKILL.md` in the code repository (that file has every exact command).
Everything here was checked against the real scripts on 2026-11-19: `install/update.sh`,
`install/backup.sh`, `install/verify.sh` and the deploy runner behind the `dev_deploy` tool.

## Who may do it

- **A rollback on the live server needs the owner's word, every time.** Typed by the owner on the
  card or in chat. A message from a bot does not count.
- **The one exception** is the automatic rollback built into the `dev_deploy` tool. It
  happens by itself when a deploy fails its own checks.
- Anyone (a bot too) may open a revert pull request. Merging it and deploying it still
  need approval, as always.
- Nobody force-pushes `main`. Nobody deletes a backup during a rollback.

## Two things to know first

**1. Running the update script by hand does NOT undo itself.** `update.sh` takes a backup,
keeps the old version, installs the new one and prints the steps to go back. It does not
go back on its own, even if the checks at the end fail. Only a deploy started with the
`dev_deploy` tool rolls itself back (it runs the update, runs the full check, asks the
public site if it is healthy, and if either fails it puts the old version and the
pre-update backup back, then checks again).

**2. Going back to the old database loses everything since the update.** Cards, chat,
decisions, and any secret added or changed after the update. The current data is moved
aside, not deleted, but it is no longer live. So the database step is optional: do it
only when the new version damaged data. Often the old code runs fine on the current data.

## What the pre-update backup holds

Every update makes a folder `/opt/operationkit/backups/pre-update-<date and time, UTC>`:

| In it | What it is |
|---|---|
| `command-center.db` | The whole database, checked for damage when it was made |
| `data.tar.gz` | AI account logins, uploads, branding |
| `secrets.tar.gz` | The secrets folder, including the key that unlocks stored secrets |
| `client.conf`, `install.env`, `MANIFEST` | Settings, and a label saying which version it came from |

**Not in it:** the knowledge base, projects, notes and agent memory (the "home" folder).
A rollback leaves those exactly as they are. That is on purpose (an update does not write
there), but it means a rollback cannot undo a change to the knowledge base. The nightly
backup covers that.

The previous version of the app is kept beside it as saved images named
`…:pre-update-<date and time>`. The server keeps the last 5 backup folders and the last
3 saved versions.

Cloudflare changes made by an update are not part of this. They have their own undo
commands, printed at the end of the update.

## Undo a bad deploy

1. **Check if it already undid itself.** If the deploy was started with `dev_deploy`, ask
   for its status. "Rolled back" means the old version is running again. "Rollback failed"
   means a person is needed: stop and tell the owner.
2. **Ask the owner.** Say what is broken, which version you would go back to, and whether you
   want to put the old database back (and what would be lost).
3. **Pick the right backup.** Read the label inside each `pre-update` folder and choose
   the one that names the last good version. Do not just take the newest: if the update
   was tried twice, the newest folder holds the bad version.
4. **Check the backup is whole** (a dry run does this and changes nothing). No database
   file in it means stop and tell the owner before anything else.
5. **Put the old code back** (switch the code folder to the last good version).
6. **Put the old app version back** (point the app at the saved images).
7. **Only if needed, put the old database back.** One command. It stops the app, moves
   the current data aside to `backups/pre-restore-<time>`, restores, and starts the app.
8. **Start everything.**
9. **Check it.** Run the full check script (every line must say PASS). Ask the app which
   version it is running: the `commit` in `/api/health` must be the old one. Ask the
   public address the same: it must answer 200, not a sign-in page.
10. **Report on the card:** what failed, version before and after, which backup was used,
    whether the database was restored and what was lost, and the check results. Cards
    that were running were cut off by the restart.

If the check in step 9 fails, do not try again alone. Report and wait.

That is nine steps and about ten commands by hand, which is more than a few. There is a
restore command for the data (`backup.sh restore`), but no single "rollback" command that
does all of it. Card 901501 proposes one (`install/rollback.sh`). It is not built yet.

## Undo a bad merge

1. Open a **revert pull request** on the private upstream code repository.
   A revert is a new change that cancels the bad one. History is never rewritten.
2. Tests must pass, and it is merged with approval like any other change.
3. After the merge, the public copy gets its own sync pull request automatically. That is
   merged the normal way.
4. It is live only after the next deploy, which needs the owner's word. Then confirm the app
   reports the new version.
5. If the bad change is already live and the site is broken, first undo the deploy (above)
   so the site works, then do the revert so the next update does not bring it back.

A revert only undoes code. If the bad version already changed the database, say so in the
report: that needs the database step above or a fix going forward.

## Stop and tell the owner when

- there is no `pre-update` folder for the last good version, or it has no database file
- the backup fails its own check (the restore refuses it)
- the saved app version has been cleaned up (only 3 are kept)
- the update was run with "skip backup"
- `dev_deploy` reports "rollback failed"

## Not confirmed (checked by reading the scripts only)

- No rollback was run to test these steps. They come from reading the scripts.
- The live server's actual backup folders and saved versions were not inspected.
- The public sync step for a revert was read from the sync documentation, not exercised.
- The skill file was not checked with `okit validate` (the tool was not available where it
  was written). That check is on card 901501.

