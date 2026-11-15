# OVH: switch the nightly backup to the built-in `install/backup.sh` (obj 900861)

**Status: plan only. Nothing here has been run on the OVH host.** The PR that adds
`BACKUP_HOME="offsite"`, `backup.sh status` and the retention fix must be merged,
synced to public `OperationKit` and deployed to OVH with `update.sh` first. Each step
below says what to expect; stop at the first step that does not match.

Paths used below (the OVH Operation Kit install):

```bash
SRC=/opt/operationkit-src          # code checkout install.sh / update.sh run from
CONF=$SRC/client.conf
OK=/opt/operationkit               # INSTALL_DIR: state/, secrets/, backups/, logs/
```

## Why

- Today OVH has no proven nightly backup of its own layout. Restore points are
  `update.sh`'s `pre-update-<UTC>` folders (for example
  `pre-update-20261113T193544Z`), which by design hold the database, seat logins,
  secrets and settings but **not** `state/home` (projects, notes, agent memory, the
  knowledge base), plus older hand-made restic runs.
- `state/home` is about 61 GB. A full-home `home.tar.gz` run was stopped after more
  than 15 minutes (obj 900271), so the default `BACKUP_HOME="archive"` is the wrong
  mode for this server: it would re-compress 61 GB every night, keep 7 copies on the
  same disk and re-upload almost all of it.
- With `BACKUP_HOME="offsite"`, home goes to restic **as a folder**: the first run
  uploads it once, then only what changed. The database/data/secrets folder stays
  local (7 kept) and off-site.

## Backup destination

- **Backblaze B2**, the provider chosen in `docs/migration/ovh-rise4.md` §I.1.
- **A new folder in the bucket**, default name `operationkit`, so
  `BACKUP_TARGET="s3:<b2 s3 endpoint>/<bucket>/operationkit"`. Do **not** point it
  at the hand-made job's restic repository: the two retention policies must never
  prune each other's snapshots.
- Keys: a B2 application key limited to that bucket (list, read, write, delete).
  `b2-setup.sh` stores them in `$OK/secrets/stack.env` as
  `OK_BACKUP_ACCESS_KEY_ID` / `OK_BACKUP_SECRET_ACCESS_KEY` (mode 600); the restic
  password is `OK_BACKUP_PASSWORD` in the same file. **Copy `OK_BACKUP_PASSWORD` and
  `secrets/secrets-kek` into the password manager**: without them no off-site backup
  can be read.
- Retention (defaults): 7 local nightly folders; off-site 7 daily / 4 weekly / 6
  monthly. Cost at B2's $6.95/TB/month: roughly $0.45/month for ~61 GB plus
  database snapshots.

## 0. Preconditions (read-only)

```bash
curl -s http://127.0.0.1:3002/api/health        # commit = the public sync commit that carries this PR
grep -q 'BACKUP_HOME' $SRC/install/backup.sh && echo "new backup.sh present"
sudo bash $SRC/install/backup.sh status --config $CONF
```

`status` prints the nightly job and time, `off-server:` (target or `none`), `home:`
mode, the newest nightly folder and its age, and `other jobs:` — every other backup
timer, `/etc/cron.d` file or root crontab line. **Write down each "other job"
line** (schedule, command, which restic repository it uses). Also note:

```bash
sudo systemctl list-timers --all | grep -iE 'backup|restic|b2'
sudo crontab -l | grep -iE 'backup|restic'
ls -l /etc/cron.d/
df -h $OK                                       # room for 7 database-sized folders
sudo du -sh $OK/state/home $OK/state/data       # expect home ~61 GB
```

## 1. Point the built-in backup at B2 (only if `off-server: none`)

`b2-setup.sh` reads the B2 key hidden, so it must run in an interactive terminal on
the server (`ssh -t`), never through a chat or a non-interactive agent:

```bash
sudo bash $SRC/install/b2-setup.sh --config $CONF --skip-first-backup
```

Answer: keyID, applicationKey (hidden), bucket, folder `operationkit`. It checks the
key against Backblaze, writes `BACKUP_TARGET` into `client.conf` (no secret there),
the keys into `stack.env`, and re-writes the one nightly cron job.
`--skip-first-backup` because the first run is done by hand in step 3, after
`BACKUP_HOME` is set. If `status` already showed a B2 target in its own folder, skip
this step.

## 2. Large-home mode

```bash
sudo cp -p $CONF $CONF.bak-$(date -u +%Y%m%dT%H%M%SZ)
grep -q '^BACKUP_HOME=' $CONF \
  && sudo sed -i 's/^BACKUP_HOME=.*/BACKUP_HOME="offsite"/' $CONF \
  || echo 'BACKUP_HOME="offsite"' | sudo tee -a $CONF >/dev/null
sudo bash $SRC/install/backup.sh install-cron --config $CONF
sudo bash $SRC/install/backup.sh status --config $CONF
```

Expect `home: its own restic snapshot each night, not archived locally
(BACKUP_HOME=offsite)` and `nightly job: 03:30 server time (/etc/cron.d/operationkit-backup → …)`.

## 3. First run by hand (uploads all of home once)

Run it in `tmux` so a dropped ssh does not kill it; it takes as long as 61 GB takes to
upload. The `flock` matches the nightly job's, so the 03:30 job cannot start on top
of it.

```bash
tmux new -s okbackup
sudo flock -n /run/operationkit-backup.lock \
  bash $SRC/install/backup.sh run --label nightly --config $CONF 2>&1 | sudo tee -a $OK/logs/backup.log
```

Expect `home sent (restic snapshot <id>; …)` then `sent (restic snapshot <id>)`, exit 0,
and a new `$OK/backups/nightly-<UTC>/` folder with **no** `home.tar.gz` and a
`MANIFEST` containing `home=offsite` and `home_snapshot=<id>`.

## 4. Verify the backup (the restore test)

```bash
sudo bash $SRC/install/backup.sh verify --config $CONF   # must end: RESTORE TEST: PASS, exit 0
sudo bash $SRC/install/backup.sh list   --config $CONF   # snapshots with tags operationkit and operationkit-home
```

`verify` downloads the newest off-site folder snapshot into scratch, checks every
`MANIFEST` checksum and archive, runs `PRAGMA integrity_check` and row counts on the
database, and checks that the night's home snapshot exists and is not empty. It
changes nothing.

Optional, a full round trip (downloads home too, needs ~61 GB free; changes nothing
live):

```bash
sudo bash $SRC/install/backup.sh fetch --config $CONF    # prints $OK/backups/restored-<UTC>
sudo du -sh $OK/backups/restored-*/home                  # ~ the size of state/home
sudo rm -rf $OK/backups/restored-<UTC>                    # the folder it printed
```

## 5. Switch the old job(s) off — disable, never delete

Only after step 4 printed PASS. For each "other job" from step 0:

```bash
sudo systemctl disable --now <name>.timer        # a systemd timer
sudo sed -i 's|^\([^#].*<command>.*\)$|# disabled 900861 \1|' /etc/cron.d/<file>   # a cron.d line
sudo crontab -e                                   # a root crontab line: comment it out
```

Leave the old restic repository, its keys and password, and every
`pre-update-*` folder exactly as they are.

## 6. Check after the first night on its own

```bash
sudo bash $SRC/install/backup.sh status --config $CONF
tail -n 30 $OK/logs/backup.log
```

Expect `newest: nightly-<today> (<36h ago, home=offsite)`, `other jobs: none`, and a
log showing only the changed part of home uploaded. Run `backup.sh verify` once more.
Keep the old repository until the built-in job has run on its own for 7 nights.

## Rollback

Nothing above deletes data, so rollback is just undoing the switches:

1. Re-enable the old job: `sudo systemctl enable --now <name>.timer`, or uncomment its
   cron line.
2. Back to the archive mode: restore `client.conf` from `$CONF.bak-<time>` (or set
   `BACKUP_HOME="archive"`), then `sudo bash $SRC/install/backup.sh install-cron --config $CONF`.
3. Stop the built-in off-site copy entirely: set `BACKUP_TARGET=""` in `client.conf`
   and re-run `install-cron` (local nightly folders continue). The B2 `operationkit`
   folder can stay; nothing reads it.
4. A code rollback is `update.sh`'s own printed rollback block; with the default
   `BACKUP_HOME="archive"` the new `backup.sh` behaves as before apart from the
   retention fix.

**One change that is not undone by a rollback:** restic retention now groups by host
and tag. If `BACKUP_TARGET` already pointed at a repository with more than a week of
built-in snapshots, the first nightly run after the update deletes the snapshots
outside 7 daily / 4 weekly / 6 monthly (that was always the configured policy; it
just never applied). Hand-made snapshots in a different repository are not touched.
