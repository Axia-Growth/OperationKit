#!/usr/bin/env bash
# install/backup.sh — back up an Operation Kit install, and put a backup back.
#
#   sudo bash install/backup.sh run          --config client.conf [--label nightly|pre-update|manual] [--no-offsite]
#   sudo bash install/backup.sh list         --config client.conf
#   sudo bash install/backup.sh fetch        --config client.conf [--snapshot latest|<id>]
#   sudo bash install/backup.sh restore DIR  --config client.conf --yes
#   sudo bash install/backup.sh verify       --config client.conf [--snapshot latest|<id>]
#   sudo bash install/backup.sh install-cron --config client.conf
#   sudo bash install/backup.sh status       --config client.conf   (read-only: is the nightly job the one running?)
#   (every action takes --dry-run)
#
# `run` writes one folder, INSTALL_DIR/backups/<label>-<UTC time>/ (mode 700):
#   command-center.db  the database, copied with SQLite's online backup while the
#                      app runs, then checked with PRAGMA integrity_check
#   data.tar.gz        the rest of state/data: Claude/Codex seat logins
#                      (cc-accounts), uploads, branding
#   home.tar.gz        state/home: projects, notes, agent memory (not for
#                      --label pre-update, which only needs what an update can break,
#                      and not with BACKUP_HOME="offsite" when the run sends off-site:
#                      see below)
#   secrets.tar.gz     secrets/ (stack.env holds the key that decrypts the
#                      secrets stored in the database — a restore needs both)
#   client.conf, install.env, MANIFEST (commit, image, sizes, sha256)
# Only the newest BACKUP_KEEP_LOCAL (default 7) nightly folders are kept, and 5
# pre-update ones. When BACKUP_TARGET is set, a nightly folder is also sent OFF
# the server with restic (encrypted with OK_BACKUP_PASSWORD from stack.env)
# to any S3-compatible bucket (Backblaze B2, AWS S3, Wasabi…), keeping
# BACKUP_KEEP_DAILY daily, BACKUP_KEEP_WEEKLY weekly and BACKUP_KEEP_MONTHLY
# monthly copies (defaults 7 / 4 / 6).
#
# BACKUP_HOME="offsite" is for a server whose state/home is large (tens of GB):
# re-compressing all of it into home.tar.gz every night is slow, keeps
# BACKUP_KEEP_LOCAL full copies on the same disk, and defeats restic's
# de-duplication (a fresh gzip stream shares almost no chunks with yesterday's).
# With it, a nightly run that sends off-site leaves home.tar.gz out of the local
# folder and gives state/home to restic AS A FOLDER, in its own snapshot (tag
# operationkit-home): after the first night only what changed is uploaded. The
# folder's MANIFEST records that snapshot's id, so `fetch` brings back the home
# that belongs with that database, `restore` puts it back, and `verify` checks it
# is there. Any run that does NOT send off-site (manual, --no-offsite, no
# BACKUP_TARGET) still writes home.tar.gz, so a local folder is never missing it
# silently. Default "archive" = the behaviour above, unchanged.
#
# `verify` is the restore test: it downloads the newest off-server snapshot
# (or, with no BACKUP_TARGET, takes the newest backup folder on this server)
# into a scratch folder, checks the MANIFEST checksums, every archive, the
# database's PRAGMA integrity_check and its row counts, prints PASS or FAIL,
# deletes the scratch copy, and exits non-zero on FAIL. It changes nothing.
#
# `fetch` downloads an off-server backup into INSTALL_DIR/backups/restored-…/ and
# prints the folder; `restore DIR` stops the app, puts that folder's database,
# data, home and secrets back (the current ones are first moved aside to
# INSTALL_DIR/backups/pre-restore-<time>/), and starts the app again.
# INSTALL.md "Backups and restore" walks through recovering onto a new server.
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ACTION=${1:-}; shift || true
RESTORE_DIR=
if [ "$ACTION" = restore ]; then RESTORE_DIR=${1:-}; shift || true; fi
CONFIG=; LABEL=manual; OFFSITE=1; YES=0; SNAPSHOT=latest
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --label) shift; LABEL=${1:-} ;;
    --no-offsite) OFFSITE=0 ;;
    --snapshot) shift; SNAPSHOT=${1:-latest} ;;
    --yes) YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
case "$ACTION" in run|list|fetch|restore|verify|install-cron|status) ;; *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac
[ -n "$CONFIG" ] || die "--config <file> is required"
[ -f "$CONFIG" ] || die "config file not found: $CONFIG"
CONFIG=$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")
[[ "$LABEL" =~ ^[a-z][a-z-]{1,20}$ ]] || die "--label must be lowercase letters and dashes"
export DRY_RUN
conf_load "$CONFIG"; conf_validate; ok_paths
require_root

BACKUPS=$OK_DIR/backups
DB=$OK_STATE/data/command-center.db
TARGET=$(conf BACKUP_TARGET)
KEEP_DAILY=$(conf BACKUP_KEEP_DAILY 7); KEEP_WEEKLY=$(conf BACKUP_KEEP_WEEKLY 4); KEEP_MONTHLY=$(conf BACKUP_KEEP_MONTHLY 6)
HOME_MODE=$(conf BACKUP_HOME archive)
# restic's `forget` groups by host AND paths unless told otherwise. Every nightly
# folder has its own path (nightly-<time>), so each snapshot was a group of one
# and the keep-daily/weekly/monthly policy never removed anything: the repository
# only grew. Group by host + tags instead — the snapshots of one kind share both.
FORGET_GROUP=(--group-by 'host,tags')

# ── restic (off-server copies) ────────────────────────────────────────────────
# The repository password and bucket keys go through the environment and a
# mode-600 file, never argv, and are never printed.
RESTIC_PW_FILE=
VERIFY_SCRATCH=
restic_env() {
  [ -n "$TARGET" ] || die "BACKUP_TARGET is empty in $CONFIG — there is no off-server backup to talk to"
  command -v restic >/dev/null 2>&1 || die "restic is not installed (sudo apt-get install restic), needed for BACKUP_TARGET"
  local pw kid key
  pw=$(env_get "$OK_SECRETS_ENV" OK_BACKUP_PASSWORD)
  [ -n "$pw" ] || die "OK_BACKUP_PASSWORD is missing from $OK_SECRETS_ENV — re-run install.sh (it generates one), or hand the saved one over as BACKUP_PASSWORD"
  kid=$(env_get "$OK_SECRETS_ENV" OK_BACKUP_ACCESS_KEY_ID); key=$(env_get "$OK_SECRETS_ENV" OK_BACKUP_SECRET_ACCESS_KEY)
  [ -n "$kid" ] && [ -n "$key" ] || die "BACKUP_TARGET is set but the bucket keys are not: hand over BACKUP_ACCESS_KEY_ID and BACKUP_SECRET_ACCESS_KEY (INSTALL.md, Backups)"
  RESTIC_PW_FILE=$(mktemp); chmod 600 "$RESTIC_PW_FILE"
  trap 'rm -f "$RESTIC_PW_FILE"; [ -z "$VERIFY_SCRATCH" ] || rm -rf --one-file-system "$VERIFY_SCRATCH"' EXIT
  printf '%s\n' "$pw" > "$RESTIC_PW_FILE"
  export RESTIC_REPOSITORY=$TARGET RESTIC_PASSWORD_FILE=$RESTIC_PW_FILE
  case "$TARGET" in
    b2:*) export B2_ACCOUNT_ID=$kid B2_ACCOUNT_KEY=$key ;;
    *)    export AWS_ACCESS_KEY_ID=$kid AWS_SECRET_ACCESS_KEY=$key ;;
  esac
  unset pw key
}

# ── run ───────────────────────────────────────────────────────────────────────
snapshot_db() { # DEST — consistent copy of the live database, integrity-checked
  local dest=$1 out script=server/src/scripts/db-backup.ts
  if [ "$(docker inspect -f '{{.State.Running}}' command-center 2>/dev/null)" = true ]; then
    # An image built before this script existed (the first update.sh run) does
    # not have it: copy it in from this checkout.
    docker exec command-center test -f "/app/$script" \
      || docker cp "$OK_REPO_DIR/app/$script" "command-center:/app/$script" >/dev/null
    out=$(docker exec command-center tsx "$script" /app/data/.backup-tmp/command-center.db 2>&1) \
      || die "database backup failed: $out"
    mv "$OK_STATE/data/.backup-tmp/command-center.db" "$dest"
    rmdir "$OK_STATE/data/.backup-tmp" 2>/dev/null || true
    log "  database: $(jq -r '"\(.bytes) bytes, integrity \(.integrity)"' <<<"$out" 2>/dev/null || echo ok)"
  elif command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" ".backup '$dest'"
    [ "$(sqlite3 "$dest" 'PRAGMA integrity_check')" = ok ] || die "the database copy failed its integrity check"
    log "  database: copied with sqlite3 (app not running), integrity ok"
  else
    # App stopped: the files are at rest, so a plain copy (with the WAL) is consistent.
    cp -p "$DB" "$dest"; for x in -wal -shm; do [ -f "$DB$x" ] && cp -p "$DB$x" "$dest$x"; done
    log "  database: copied as files (app not running; no integrity check without sqlite3)"
  fi
}

tar_dir() { # SRC_DIR OUT.tar.gz [tar options…] — a live folder: files changing
  local src=$1 out=$2 rc=0; shift 2  # mid-read (exit 1) are fine, real errors (2) are not
  tar -C "$src" --warning=no-file-changed --warning=no-file-removed "$@" -czf "$out" . || rc=$?
  [ "$rc" -le 1 ] || die "could not archive $src (tar exit $rc)"
}

prune_local() { # LABEL KEEP
  local label=$1 keep=$2
  # Folder names sort by time (UTC stamp), newest last.
  find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -name "$label-*" | sort | head -n "-$keep" | while read -r old; do
    rm -rf --one-file-system "$old"; log "  removed old backup $(basename "$old")"
  done
}

do_run() {
  local ts dir commit image home_how sends=0 host
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  # Two runs in the same second must never share (and mix) one folder.
  while [ -e "$BACKUPS/$LABEL-$ts" ]; do sleep 1; ts=$(date -u +%Y%m%dT%H%M%SZ); done
  dir=$BACKUPS/$LABEL-$ts
  host="ok-$(conf CLIENT_SLUG)"
  [ -n "$TARGET" ] && [ "$OFFSITE" -eq 1 ] && [ "$LABEL" = nightly ] && sends=1
  # How state/home is kept by THIS run: in the folder (archive), as its own
  # restic snapshot (offsite), or not at all (pre-update: an update never writes it).
  home_how=archive
  if [ "$LABEL" = pre-update ]; then home_how=none
  elif [ "$HOME_MODE" = offsite ]; then
    if [ "$sends" -eq 1 ]; then home_how=offsite
    elif [ "$LABEL" = nightly ]; then
      warn "BACKUP_HOME=\"offsite\" but this run sends nothing off the server ($([ -z "$TARGET" ] && echo 'BACKUP_TARGET is empty' || echo '--no-offsite')): home goes into home.tar.gz instead, so it is not left out"
    fi
  fi
  step "Backup $LABEL → $dir"
  if [ ! -f "$DB" ]; then
    [ "$DRY_RUN" -eq 1 ] || die "no database at $DB — is Operation Kit installed under $OK_DIR?"
    warn "no database at $DB yet (fine for a dry run)"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would write database, data$([ "$home_how" = archive ] && echo ', home'), secrets and config into $dir"
    [ "$sends" -eq 0 ] || log "  [dry-run] would send it to $TARGET with restic"
    [ "$home_how" != offsite ] || log "  [dry-run] would send $OK_STATE/home to $TARGET as its own restic snapshot (BACKUP_HOME=offsite)"
    return 0
  fi
  install -d -m 700 "$BACKUPS"; install -d -m 700 "$dir"
  snapshot_db "$dir/command-center.db"
  tar_dir "$OK_STATE/data" "$dir/data.tar.gz" --exclude='./command-center.db' --exclude='./command-center.db-*' --exclude='./.backup-tmp'
  log "  data (seat logins, uploads, branding): $(du -h "$dir/data.tar.gz" | cut -f1)"
  if [ "$home_how" = archive ]; then
    tar_dir "$OK_STATE/home" "$dir/home.tar.gz"
    log "  home (projects, notes, memory): $(du -h "$dir/home.tar.gz" | cut -f1)"
  elif [ "$home_how" = offsite ]; then
    log "  home (projects, notes, memory): sent to $TARGET as its own snapshot below (BACKUP_HOME=offsite)"
  fi
  tar_dir "$OK_SECRETS" "$dir/secrets.tar.gz"
  cp "$CONFIG" "$dir/client.conf"
  [ -f "$OK_SETTINGS_ENV" ] && cp "$OK_SETTINGS_ENV" "$dir/install.env"
  commit=$(repo_sha); image=$(docker image inspect -f '{{.Id}}' operationkit-app:local 2>/dev/null || echo none)
  { echo "label=$LABEL"; echo "created=$ts"; echo "commit=$commit"; echo "image=$image"; echo "home=$home_how"
    [ "$home_how" != offsite ] || echo "home_path=$OK_STATE/home"
    (cd "$dir" && sha256sum -- *.db *.tar.gz client.conf); } > "$dir/MANIFEST"
  chmod -R go-rwx "$dir"
  log "  done: $(du -sh "$dir" | cut -f1) in $dir"

  case "$LABEL" in
    nightly) prune_local nightly "$(conf BACKUP_KEEP_LOCAL 7)" ;;
    pre-update) prune_local pre-update 5 ;;
  esac

  if [ "$sends" -eq 1 ]; then
    step "Off-server copy → $TARGET"
    restic_env
    restic cat config >/dev/null 2>&1 || { restic init >/dev/null; log "  new encrypted backup repository created"; }
    local prune=(); [ "$(date +%u)" = 7 ] && prune=(--prune)   # the slow repack only on Sundays
    local keep=(--keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY")
    if [ "$home_how" = offsite ]; then
      # First, so the folder that is sent next can name it: fetch/restore/verify
      # then always pair a database with the home taken the same night.
      local home_snap
      restic backup --quiet --host "$host" --tag operationkit-home --tag "$LABEL" "$OK_STATE/home"
      home_snap=$(restic snapshots --json --latest 1 --host "$host" --tag operationkit-home | jq -r '.[-1].id // empty')
      [ -n "$home_snap" ] || die "the home snapshot was sent but restic does not list it — run: sudo bash $OK_LIB_DIR/backup.sh list --config $CONFIG"
      echo "home_snapshot=$home_snap" >> "$dir/MANIFEST"
      log "  home sent (restic snapshot ${home_snap:0:8}; only what changed since the last one is uploaded)"
      restic forget --quiet --host "$host" --tag operationkit-home "${FORGET_GROUP[@]}" "${keep[@]}"
    fi
    restic backup --quiet --host "$host" --tag operationkit --tag "$LABEL" "$dir"
    restic forget --quiet --host "$host" --tag operationkit "${FORGET_GROUP[@]}" "${keep[@]}" "${prune[@]+"${prune[@]}"}"
    log "  sent (restic snapshot $(restic snapshots --json --latest 1 --host "$host" --tag operationkit | jq -r '.[-1].short_id // "?"'))"
  elif [ -z "$TARGET" ] && [ "$LABEL" = nightly ]; then
    warn "BACKUP_TARGET is empty: this backup is on the SAME server as the data. Set an off-server target (INSTALL.md, Backups)."
  fi
}

# ── restore ───────────────────────────────────────────────────────────────────
do_restore() {
  local src=$1 ts aside
  [ -n "$src" ] || die "restore needs the backup folder: install/backup.sh restore <folder> --config … --yes"
  src=$(cd "$src" 2>/dev/null && pwd) || die "no such folder: $1"
  [ -f "$src/command-center.db" ] && [ -f "$src/data.tar.gz" ] && [ -f "$src/secrets.tar.gz" ] \
    || die "$src is not a backup folder (needs command-center.db, data.tar.gz, secrets.tar.gz)"
  if [ -f "$src/MANIFEST" ] && command -v sha256sum >/dev/null; then
    (cd "$src" && grep -E '^[0-9a-f]{64}  ' MANIFEST | sha256sum -c --quiet -) || die "$src does not match its MANIFEST checksums — damaged or incomplete"
  fi
  step "Restore from $src"
  sed -n 's/^\(label\|created\|commit\)=/  \1: /p' "$src/MANIFEST" 2>/dev/null || true
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would stop the app, move the current data aside, restore, start the app"; return 0; fi
  [ "$YES" -eq 1 ] || die "this replaces the database, data, home and secrets of $(site_label). Re-run with --yes to confirm."

  ts=$(date -u +%Y%m%dT%H%M%SZ); aside=$BACKUPS/pre-restore-$ts
  install -d -m 700 "$BACKUPS" "$aside"
  log "  stopping the app"
  docker stop command-center >/dev/null 2>&1 || true
  docker ps -aq --filter 'name=^ok-jail-' | xargs -r docker rm -f >/dev/null

  log "  moving the current data aside to $aside"
  # Where this backup keeps home: home.tar.gz in the folder, or a home/ folder
  # that `fetch` downloaded from its BACKUP_HOME=offsite snapshot.
  local home_src=
  if [ -f "$src/home.tar.gz" ]; then home_src=archive; elif [ -d "$src/home" ]; then home_src=folder; fi
  mv "$OK_STATE/data" "$aside/data"; mv "$OK_SECRETS" "$aside/secrets"
  [ -z "$home_src" ] || mv "$OK_STATE/home" "$aside/home"

  install -d -m 755 "$OK_STATE/data"; install -d -m 700 "$OK_SECRETS"
  tar -C "$OK_STATE/data" -xzf "$src/data.tar.gz"
  # A -wal/-shm that landed from data.tar.gz (an older backup taken before that tarball
  # excluded them) must never survive to be paired with the database below — clear them
  # first, so a backup with no -wal of its own never restores over a stale one.
  rm -f "$DB-wal" "$DB-shm"
  install -m 644 "$src/command-center.db" "$DB"
  # A backup taken with the app stopped and no sqlite3 on the host is a file copy
  # (snapshot_db): its newest committed changes are still in the -wal file.
  [ ! -f "$src/command-center.db-wal" ] || install -m 644 "$src/command-center.db-wal" "$DB-wal"
  tar -C "$OK_SECRETS" -xzf "$src/secrets.tar.gz"; chmod 700 "$OK_SECRETS"; chmod 600 "$OK_SECRETS"/* 2>/dev/null || true
  case "$home_src" in
    archive) install -d -m 777 "$OK_STATE/home"; tar -C "$OK_STATE/home" -xzf "$src/home.tar.gz" ;;
    # A move, not a copy: home can be tens of GB and both sit under INSTALL_DIR.
    folder) mv "$src/home" "$OK_STATE/home"; chmod 777 "$OK_STATE/home"; log "  home: moved into place from $src/home" ;;
    *) if grep -q '^home=offsite$' "$src/MANIFEST" 2>/dev/null; then
         log "  home: this folder's home is in its off-site snapshot (BACKUP_HOME=offsite), not on this server — kept as it was. To restore it too: backup.sh fetch, then restore the fetched folder"
       else log "  home: not in this backup (pre-update backups skip it) — kept as it was"; fi ;;
  esac
  log "  restored database, data$([ -n "$home_src" ] && echo ', home'), secrets"

  log "  starting the app"
  dc up -d command-center >/dev/null
  local waited; waited=$(wait_healthy 240) || die "the app did not become healthy after the restore — docker logs --tail 100 command-center. The previous data is in $aside"
  log "  app healthy after ${waited}s. Previous data kept in $aside (delete it when you are happy)."
}

# ── fetch ─────────────────────────────────────────────────────────────────────
do_fetch() {
  restic_env
  local into found
  into=$BACKUPS/restored-$(date -u +%Y%m%dT%H%M%SZ)
  step "Downloading off-server backup '$SNAPSHOT' from $TARGET"
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would restic restore $SNAPSHOT into $into"; return 0; fi
  install -d -m 700 "$into"
  restic restore "$SNAPSHOT" --host "ok-$(conf CLIENT_SLUG)" --tag operationkit --target "$into" >/dev/null
  found=$(find "$into" -name command-center.db -printf '%h\n' | head -1)
  [ -n "$found" ] || die "the downloaded snapshot holds no backup folder"
  # BACKUP_HOME=offsite: the folder names the home snapshot taken the same night.
  # Download it next to the database as home/, which `restore` moves into place.
  local home_snap home_path
  home_snap=$(sed -n 's/^home_snapshot=//p' "$found/MANIFEST" 2>/dev/null | head -1)
  if [ -n "$home_snap" ]; then
    home_path=$(sed -n 's/^home_path=//p' "$found/MANIFEST" | head -1)
    [ -n "$home_path" ] || die "$found/MANIFEST names home snapshot $home_snap but not the folder it holds (home_path)"
    log "  downloading home (restic snapshot ${home_snap:0:8}) — it can be large, this may take a while"
    install -d -m 700 "$found/home"
    restic restore "$home_snap:$home_path" --target "$found/home" >/dev/null \
      || die "could not download home snapshot $home_snap — the database folder is in $found; retry: sudo bash $OK_LIB_DIR/backup.sh fetch --config $CONFIG --snapshot $SNAPSHOT"
    log "  home: $(du -sh "$found/home" | cut -f1) in $found/home"
  elif grep -q '^home=offsite$' "$found/MANIFEST" 2>/dev/null; then
    die "$found/MANIFEST says home was sent off-site but names no home snapshot — that night's home upload did not finish; fetch an older one: backup.sh list, then fetch --snapshot <id>"
  fi
  log "  downloaded. Put it back with:"
  log "    sudo bash $OK_LIB_DIR/backup.sh restore $found --config $CONFIG --yes"
}

# ── verify (restore test) ─────────────────────────────────────────────────────
# verify_home FOLDER — a BACKUP_HOME=offsite folder: the home snapshot it names
# must be in the repository and hold files. It is not downloaded (tens of GB);
# `restic check` above already proves the repository it lives in is sound.
verify_home() {
  local src=$1 snap path when entries
  snap=$(sed -n 's/^home_snapshot=//p' "$src/MANIFEST" | head -1)
  path=$(sed -n 's/^home_path=//p' "$src/MANIFEST" | head -1)
  if [ -z "$TARGET" ]; then log "  NOTE  home was sent off-site (BACKUP_HOME=offsite) — set BACKUP_TARGET to check it"; return 0; fi
  if [ -z "$snap" ]; then fail "home: the backup says home went off-site but names no home snapshot (that night's home upload did not finish)"; return 0; fi
  when=$(restic snapshots --json --host "ok-$(conf CLIENT_SLUG)" --tag operationkit-home "$snap" 2>/dev/null | jq -r '.[0].time // empty' 2>/dev/null || true)
  if [ -z "$when" ]; then fail "home: snapshot ${snap:0:8} named by this backup is not in the repository (forgotten, or the upload failed)"; return 0; fi
  # With a folder named, restic ls lists that folder only (not recursive), so this stays small.
  entries=$( (restic ls "$snap" "$path" 2>/dev/null || true) | grep -c "^$path/" || true)
  if [ "${entries:-0}" -gt 0 ]; then pass "home: off-site snapshot ${snap:0:8} (${when%%.*}) is in the repository, $entries entries in $path"
  else fail "home: off-site snapshot ${snap:0:8} holds nothing under $path"; fi
}

do_verify() {
  local src where line integrity rows f out
  if [ -n "$TARGET" ]; then
    restic_env
    where="off-server snapshot '$SNAPSHOT' in $TARGET"
    step "Restore test: $where"
    if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would restic restore $SNAPSHOT into a scratch folder and check it"; return 0; fi
    install -d -m 700 "$BACKUPS"
    VERIFY_SCRATCH=$(mktemp -d "$BACKUPS/.verify-XXXXXX")
    if restic check >/dev/null 2>&1; then pass "repository structure (restic check)"; else fail "restic check reports a damaged repository — run: restic check (with the same settings) to see why"; fi
    if restic restore "$SNAPSHOT" --host "ok-$(conf CLIENT_SLUG)" --tag operationkit --target "$VERIFY_SCRATCH" >/dev/null 2>&1; then
      pass "downloaded and decrypted snapshot $SNAPSHOT"
    else
      fail "could not restore snapshot $SNAPSHOT (wrong password, keys or BACKUP_TARGET, or no snapshot yet)"
    fi
    src=$(find "$VERIFY_SCRATCH" -name command-center.db -printf '%h\n' 2>/dev/null | head -1)
  else
    where="newest backup folder on this server (BACKUP_TARGET is empty)"
    step "Restore test: $where"
    src=$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d \( -name 'nightly-*' -o -name 'manual-*' \) 2>/dev/null | sort -t- -k2 | tail -1)
    if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would check ${src:-the newest backup folder}"; return 0; fi
  fi
  if [ -z "$src" ] || [ ! -f "$src/command-center.db" ]; then
    fail "no backup folder with a database found"
  else
    log "  checking $(basename "$src")"
    if [ -f "$src/MANIFEST" ]; then
      if (cd "$src" && grep -E '^[0-9a-f]{64}  ' MANIFEST | sha256sum -c --quiet - >/dev/null 2>&1); then pass "files match their MANIFEST checksums"
      else fail "files do not match their MANIFEST checksums (damaged or incomplete)"; fi
    else
      fail "no MANIFEST in the backup"
    fi
    for f in "$src"/*.tar.gz; do
      [ -e "$f" ] || continue
      if tar -tzf "$f" >/dev/null 2>&1; then pass "$(basename "$f") opens"; else fail "$(basename "$f") is not a readable archive"; fi
    done
    if grep -q '^home=offsite$' "$src/MANIFEST" 2>/dev/null; then verify_home "$src"; fi
    integrity=; rows=
    if out=$(db_inspect "$src/command-center.db"); then
      while IFS= read -r line; do
        case "$line" in
          integrity=*) integrity=${line#integrity=} ;;
          *=*) rows="$rows ${line%%=*} ${line#*=},"; ;;
        esac
      done <<< "$out"
      if [ "$integrity" = ok ]; then pass "database integrity_check: ok"; else fail "database integrity_check: ${integrity:-no answer}"; fi
      rows=${rows%,}
      case "$rows" in *"workspaces missing"*|*"users missing"*) fail "database rows:$rows (expected tables are missing)" ;;
        *) pass "database rows:$rows" ;; esac
    else
      fail "no tool to open the database (install sqlite3: sudo apt-get install sqlite3)"
    fi
  fi
  if [ -n "$VERIFY_SCRATCH" ]; then rm -rf --one-file-system "$VERIFY_SCRATCH"; VERIFY_SCRATCH=; fi
  if [ "$FAIL_COUNT" -eq 0 ]; then
    printf '\nRESTORE TEST: PASS (%s checks, %s)\n' "$PASS_COUNT" "$where"
  else
    printf '\nRESTORE TEST: FAIL (%s of %s checks failed, %s)\n' "$FAIL_COUNT" "$((PASS_COUNT + FAIL_COUNT))" "$where"
    exit 1
  fi
}

# ── list ──────────────────────────────────────────────────────────────────────
do_list() {
  step "Backups on this server ($BACKUPS)"
  if [ -d "$BACKUPS" ]; then
    find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | sort | while read -r d; do printf '  %-40s %s\n' "$(basename "$d")" "$(du -sh "$d" | cut -f1)"; done
  else log "  none yet"; fi
  if [ -n "$TARGET" ]; then
    step "Off-server backups ($TARGET)"
    restic_env
    restic snapshots --host "ok-$(conf CLIENT_SLUG)" --tag operationkit --compact
  fi
}

# ── status (read-only) ────────────────────────────────────────────────────────
# Is THIS script the nightly backup, and is it actually running? Prints the
# schedule, where copies go, how home is kept, the newest nightly folder and its
# age, and any other backup job on the server. Changes nothing, talks to no
# bucket. update.sh prints it at the end of every update.
do_status() {
  local cron_file=${OK_CRON_FILE:-/etc/cron.d/operationkit-backup} at newest age_h other
  step "Backups: $(site_label)"
  if grep -q 'backup.sh run --label nightly' "$cron_file" 2>/dev/null; then
    at=$(awk '!/^#/ && /backup.sh run --label nightly/ {printf "%02d:%02d", $2, $1; exit}' "$cron_file")
    log "  nightly job:  $at server time ($cron_file → install/backup.sh run --label nightly)"
  else
    warn "no built-in nightly job ($cron_file is missing) — schedule it: sudo bash $OK_LIB_DIR/backup.sh install-cron --config $CONFIG"
  fi
  if [ -n "$TARGET" ]; then log "  off-server:   $TARGET (restic; keeps $KEEP_DAILY daily / $KEEP_WEEKLY weekly / $KEEP_MONTHLY monthly)"
  else log "  off-server:   none — copies stay on this server only (set BACKUP_TARGET)"; fi
  case "$HOME_MODE:$([ -n "$TARGET" ] && echo t)" in
    offsite:t) log "  home:         its own restic snapshot each night, not archived locally (BACKUP_HOME=offsite)" ;;
    offsite:)  log "  home:         archived into each nightly folder (BACKUP_HOME=offsite is waiting for BACKUP_TARGET)" ;;
    *)         log "  home:         archived into each nightly folder as home.tar.gz (BACKUP_HOME=archive)" ;;
  esac
  newest=$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -name 'nightly-*' 2>/dev/null | sort | tail -1)
  if [ -z "$newest" ]; then
    warn "no nightly backup folder in $BACKUPS yet"
  else
    age_h=$(( ($(date +%s) - $(stat -c %Y "$newest")) / 3600 ))
    if [ "$age_h" -gt 36 ]; then warn "newest nightly backup is ${age_h}h old: $(basename "$newest") — the nightly job is not running (log: $OK_DIR/logs/backup.log)"
    else log "  newest:       $(basename "$newest") (${age_h}h ago, home=$(sed -n 's/^home=//p' "$newest/MANIFEST" 2>/dev/null | head -1))"; fi
  fi
  other=$(other_backup_jobs)
  if [ -n "$other" ]; then
    warn "other backup jobs still active on this server (switch them off once the built-in one is proven — INSTALL.md \"Switching from a hand-made backup\"):"
    while IFS= read -r at; do warn "    $at"; done <<<"$other"
  else
    log "  other jobs:   none"
  fi
}

# ── install-cron ──────────────────────────────────────────────────────────────
do_install_cron() {
  # OK_CRON_FILE: test hook only (install/test/b2-setup-test.sh runs without root).
  local at hh mm cron_file=${OK_CRON_FILE:-/etc/cron.d/operationkit-backup} line
  at=$(conf BACKUP_TIME 03:30)
  [[ "$at" =~ ^([01]?[0-9]|2[0-3]):([0-5][0-9])$ ]] || die "BACKUP_TIME must be HH:MM (got '$at')"
  hh=$((10#${BASH_REMATCH[1]})); mm=$((10#${BASH_REMATCH[2]}))
  line="$mm $hh * * * root flock -n /run/operationkit-backup.lock bash $OK_LIB_DIR/backup.sh run --label nightly --config $CONFIG >> $OK_DIR/logs/backup.log 2>&1"
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would write $cron_file: daily at $at"; return 0; fi
  command -v cron >/dev/null 2>&1 || warn "cron is not installed — the nightly backup will not run (sudo apt-get install cron)"
  install -d -m 755 "$OK_DIR/logs"
  { echo "# Operation Kit nightly backup — written by install.sh / install/backup.sh install-cron. Re-run to change."
    echo "SHELL=/bin/bash"; echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    echo "$line"; } > "$cron_file.tmp"
  chmod 644 "$cron_file.tmp"; mv "$cron_file.tmp" "$cron_file"
  log "  nightly at $at ($(timedatectl show -p Timezone --value 2>/dev/null || echo 'server time')), log: $OK_DIR/logs/backup.log"
  if [ -n "$TARGET" ]; then log "  off-server: $TARGET (encrypted with restic; keeps $KEEP_DAILY daily / $KEEP_WEEKLY weekly / $KEEP_MONTHLY monthly)"
  else warn "BACKUP_TARGET is empty — backups stay on this server only. Set it for an off-server copy (INSTALL.md, Backups)."; fi
  if [ "$HOME_MODE" = offsite ]; then
    if [ -n "$TARGET" ]; then log "  home: sent off-site as its own restic snapshot each night, not archived into the local folder (BACKUP_HOME=offsite)"
    else warn "BACKUP_HOME=\"offsite\" needs BACKUP_TARGET — until it is set, home is archived into each nightly folder"; fi
  fi
  # This job is THE nightly backup. Name any other one so it can be switched off.
  local other
  other=$(other_backup_jobs)
  if [ -n "$other" ]; then
    warn "another backup job is active on this server besides $cron_file:"
    while IFS= read -r line; do warn "    $line"; done <<<"$other"
    warn "  this nightly job already does the local copy and the off-site send, so switch the other one off to avoid two backups a night (systemctl disable --now <timer> / remove the cron line). INSTALL.md: \"Switching from a hand-made backup\""
  fi
}

case "$ACTION" in
  run) do_run ;;
  restore) do_restore "$RESTORE_DIR" ;;
  fetch) do_fetch ;;
  list) do_list ;;
  verify) do_verify ;;
  install-cron) do_install_cron ;;
  status) do_status ;;
esac
