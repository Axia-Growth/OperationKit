#!/usr/bin/env bash
# Exercise install/b2-setup.sh and install/backup.sh (retention, verify) against
# install/test/b2-mock.mjs and a fake restic. No root, no network, no real
# Backblaze account, fake sample keys only.   bash install/test/b2-setup-test.sh
#
# Covers: the prompt is skipped when not interactive; Enter skips; a bad key, a
# key without delete and a wrong bucket are refused; the application key never
# appears in output, logs, curl's argv or client.conf; BACKUP_TARGET lands in
# client.conf (mode kept) and the keys in stack.env (mode 600); exactly one
# nightly job; retention settings reach restic forget; verify prints PASS and
# FAIL; a re-run is idempotent.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
INST=$HERE/..
WORK=$(mktemp -d); MOCK=
trap '[ -z "$MOCK" ] || kill "$MOCK" 2>/dev/null || true; rm -rf "$WORK"' EXIT
PORT=$((20000 + RANDOM % 20000))
PORT=$PORT node "$HERE/b2-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done

KID=000000000000000000000001a
KEY=fakekeyfakekeyfakekeyfakekey11
KID_NODELETE=000000000000000000000002a
KEY_NODELETE=fakekeyfakekeyfakekeyfakekey22
WANT_TARGET=s3:https://s3.us-west-004.backblazeb2.com/ok-test-bucket/operationkit

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }
count() { grep -c -- "$1" "$2" 2>/dev/null || true; }

# ── a fake install: config, secrets, a small database, home ──────────────────
OK=$WORK/ok
mkdir -p "$OK/state/data" "$OK/state/home/projects" "$OK/secrets" "$OK/logs" "$WORK/bin" "$WORK/repo"
chmod 700 "$OK/secrets"
sed -e "s#^INSTALL_DIR=.*#INSTALL_DIR=\"$OK\"#" "$INST/client.conf.example" > "$WORK/client.conf"
chmod 640 "$WORK/client.conf"
printf 'OK_BACKUP_PASSWORD=%s\n' "fake-restic-password-for-tests" > "$OK/secrets/stack.env"; chmod 600 "$OK/secrets/stack.env"
echo "note" > "$OK/state/home/projects/readme.txt"
SQL="CREATE TABLE workspaces(id); CREATE TABLE users(id); CREATE TABLE objectives(id); CREATE TABLE projects(id);
INSERT INTO workspaces VALUES(1); INSERT INTO users VALUES(1),(2); INSERT INTO objectives VALUES(1),(2),(3);"
if command -v sqlite3 >/dev/null 2>&1; then sqlite3 "$OK/state/data/command-center.db" "$SQL"
elif command -v python3 >/dev/null 2>&1; then python3 -I -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit()' "$OK/state/data/command-center.db" "$SQL"
else node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite"); new DatabaseSync(process.argv[1]).exec(process.argv[2])' "$OK/state/data/command-center.db" "$SQL"; fi

# ── shims: root without root, no docker, a recording curl, a fake restic ──────
REAL_CURL=$(command -v curl)
cat > "$WORK/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi
EOF
# docker: absent, unless FAKE_DOCKER_OK=1 (restore stops/starts the app). Never `inspect`.
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" != inspect ] || exit 1
[ "${FAKE_DOCKER_OK:-0}" = 1 ] && { echo "docker $*" >> "$FAKE_REPO/docker.log"; exit 0; }
exit 1
EOF
cat > "$WORK/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
[ -z "${FAKE_TIMERS:-}" ] || printf 'Mon 2026-11-02 04:00:00 UTC 4h - - %s b2-backup.service\n' "$FAKE_TIMERS"
EOF
cat > "$WORK/bin/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WORK/curl-argv.log"
# The app's health check after a restore: healthy when FAKE_DOCKER_OK=1.
if [ "\${FAKE_DOCKER_OK:-0}" = 1 ] && [[ " \$* " == *" http://127.0.0.1:3002/api/health "* ]]; then exit 0; fi
exec "$REAL_CURL" "\$@"
EOF
cat > "$WORK/bin/restic" <<'EOF'
#!/usr/bin/env bash
# Fake restic: a folder per snapshot under $FAKE_REPO (snap-N/, paths kept
# absolute like restic does) plus snap-N.meta (id, host, tags). Logs the
# arguments and whether the credentials arrived (compared here, never logged).
set -euo pipefail
creds=bad
[ "${AWS_ACCESS_KEY_ID:-}" = "$FAKE_EXPECT_KID" ] && [ "${AWS_SECRET_ACCESS_KEY:-}" = "$FAKE_EXPECT_KEY" ] \
  && [ -r "${RESTIC_PASSWORD_FILE:-/nonexistent}" ] && [ "$RESTIC_REPOSITORY" = "$FAKE_EXPECT_TARGET" ] && creds=ok
echo "creds=$creds $*" >> "$FAKE_REPO/restic.log"
[ "$creds" = ok ] || { echo "Fatal: wrong credentials" >&2; exit 1; }
cmd=$1; shift
# Split the rest into options and positional arguments.
host=; tags=(); pos=(); target=; latest=0; json=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host=$2; shift ;;
    --tag) tags+=("$2"); shift ;;
    --target) target=$2; shift ;;
    --latest) latest=$2; shift ;;
    --keep-*|--group-by|--read-data-subset) shift ;;
    --json) json=1 ;;
    --*) ;;
    *) pos+=("$1") ;;
  esac
  shift
done
snaps() { # every snapshot matching --host / --tag, oldest first
  local m t ok
  for m in $(find "$FAKE_REPO" -maxdepth 1 -name 'snap-*.meta' | sort -V); do
    ok=1
    [ -z "$host" ] || grep -qx "host=$host" "$m" || ok=0
    for t in "${tags[@]+"${tags[@]}"}"; do grep -q "^tags=.*,$t," "$m" || ok=0; done
    [ "$ok" -eq 0 ] || echo "${m%.meta}"
  done
}
by_id() { grep -lx "id=$1" "$FAKE_REPO"/snap-*.meta 2>/dev/null | head -1 | sed 's/\.meta$//'; }
json_of() { local s=$1 id; id=$(sed -n 's/^id=//p' "$s.meta"); printf '{"id":"%s","short_id":"%s","time":"2026-11-15T03:30:00.123Z"}' "$id" "${id:0:8}"; }
case "$cmd" in
  cat) [ -f "$FAKE_REPO/config" ] ;;
  init) touch "$FAKE_REPO/config" ;;
  backup) n=$(find "$FAKE_REPO" -maxdepth 1 -name 'snap-*.meta' | wc -l); s=$FAKE_REPO/snap-$n
          for p in "${pos[@]}"; do mkdir -p "$s$p"; cp -a "$p/." "$s$p/"; done
          { printf 'id=f00d%04d%056d\n' "$n" 0; echo "host=$host"; printf 'tags=,'; printf '%s,' "${tags[@]}"; echo; } > "$s.meta" ;;
  forget|check) [ "$cmd" != check ] || [ "${FAKE_RESTIC_CORRUPT:-0}" = 0 ] ;;
  snapshots) list=$(snaps); [ "${#pos[@]}" -eq 0 ] || list=$(grep -Fx "$(by_id "${pos[0]}")" <<<"$list" || true)
             [ "$latest" = 0 ] || list=$(tail -n "$latest" <<<"$list")
             if [ "$json" = 1 ]; then printf '['; sep=; for s in $list; do printf '%s' "$sep"; json_of "$s"; sep=,; done; echo ']'
             else for s in $list; do sed -n 's/^id=\(.\{8\}\).*/\1  snapshot/p' "$s.meta"; done; fi ;;
  ls) s=$(by_id "${pos[0]}"); [ -n "$s" ] || exit 1; d=${pos[1]:-/}
      echo "snapshot ${pos[0]:0:8}:"; echo "$d"; for e in "$s$d"/*; do [ -e "$e" ] && echo "$d/$(basename "$e")"; done; true ;;
  restore) spec=${pos[0]}; sub=
           case "$spec" in *:*) sub=${spec#*:}; spec=${spec%%:*} ;; esac
           if [ "$spec" = latest ]; then s=$(snaps | tail -1); else s=$(by_id "$spec"); fi
           [ -n "$s" ] || exit 1
           mkdir -p "$target"; cp -a "$s$sub/." "$target/"
           if [ "${FAKE_RESTIC_CORRUPT:-0}" = 1 ]; then f=$(find "$target" -name command-center.db | head -1); printf 'garbage' > "$f"; fi ;;
  *) echo "fake restic: unsupported $cmd" >&2; exit 1 ;;
esac
EOF
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH" OK_B2_API_BASE="http://127.0.0.1:$PORT" OK_CRON_FILE="$WORK/cron.d/operationkit-backup"
# other_backup_jobs (install/lib.sh) reads these instead of /etc/cron.d and root's crontab.
export OK_CRON_DIR="$WORK/cron.d" OK_ROOT_CRONTAB="$WORK/root.crontab"
mkdir -p "$OK_CRON_DIR"; printf '# m h dom mon dow command\n0 4 * * * /usr/bin/certbot renew\n' > "$OK_ROOT_CRONTAB"
printf '#!/bin/sh\n# nothing about backups in here\n0 5 * * * root e2scrub_all\n' > "$OK_CRON_DIR/e2scrub_all"
export FAKE_REPO=$WORK/repo FAKE_EXPECT_KID=$KID FAKE_EXPECT_KEY=$KEY FAKE_EXPECT_TARGET=$WANT_TARGET
B2="$INST/b2-setup.sh"; BK="$INST/backup.sh"; CONF=$WORK/client.conf
conf_val() { sed -n "s/^$1=\"\(.*\)\"$/\1/p" "$CONF"; }

echo "== not interactive: no prompt, nothing changes"
out=$(bash "$B2" --config "$CONF" < /dev/null 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "says it was skipped and how to run it later" "$(grep -c 'skipped (not an interactive terminal)' <<<"$out")" 1
check "BACKUP_TARGET still empty" "$(conf_val BACKUP_TARGET)" ""
check "install.sh only offers it in a terminal" "$(grep -c '\[ -t 0 \] && \[ -t 1 \]; then' "$INST/../install.sh")" 1

export OK_B2_ASSUME_TTY=1
echo "== interactive, Enter = skip"
out=$(printf '\n' | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "skipped" "$(grep -c 'skipped. Backups stay on this server only' <<<"$out")" 1
check "BACKUP_TARGET still empty" "$(conf_val BACKUP_TARGET)" ""

echo "== wrong key is refused, and never printed"
out=$(printf 'y\n%s\n%s\n' "$KID" "fakekeyWRONGfakekeyWRONGfakekey" | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits non-zero" "$([ "$rc" -ne 0 ] && echo yes)" yes
check "plain message" "$(grep -c 'did not accept this keyID' <<<"$out")" 1
check "wrong key not echoed" "$(grep -c 'WRONG' <<<"$out" || true)" 0

echo "== key without deleteFiles is refused"
out=$(printf 'y\n%s\n%s\n' "$KID_NODELETE" "$KEY_NODELETE" | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits non-zero" "$([ "$rc" -ne 0 ] && echo yes)" yes
check "names the missing capability" "$(grep -c 'cannot deleteFiles' <<<"$out")" 1

echo "== bucket other than the key's is refused"
out=$(printf 'y\n%s\n%s\nsome-other-bucket\n' "$KID" "$KEY" | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits non-zero" "$([ "$rc" -ne 0 ] && echo yes)" yes
check "says which bucket the key is limited to" "$(grep -c "limited to the bucket 'ok-test-bucket'" <<<"$out")" 1
check "nothing written yet" "$(conf_val BACKUP_TARGET)" ""

echo "== good key: saved, scheduled once, first snapshot, restore test"
# The hand-made backups a server may already run (what OVH had): a timer, a cron file, a root crontab line.
printf '30 3 * * * root /usr/local/bin/b2-backup.sh >> /var/log/b2-backup.log 2>&1\n' > "$OK_CRON_DIR/b2-backup"
printf '0 4 * * * /usr/bin/certbot renew\n15 2 * * * restic -r s3:example/legacy backup /opt/operationkit\n' > "$OK_ROOT_CRONTAB"
out=$(printf 'y\n%s\n%s\n\n\n' "$KID" "$KEY" | FAKE_TIMERS=b2-backup.timer bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
check "exits 0" "$rc" 0
check "BACKUP_TARGET written to client.conf" "$(conf_val BACKUP_TARGET)" "$WANT_TARGET"
check "client.conf keeps its mode" "$(stat -c %a "$CONF")" 640
check "client.conf holds no key" "$(count "$KEY" "$CONF")" 0
check "key ID stored in stack.env" "$(grep -c "^OK_BACKUP_ACCESS_KEY_ID=$KID\$" "$OK/secrets/stack.env")" 1
check "application key stored in stack.env" "$(grep -c "^OK_BACKUP_SECRET_ACCESS_KEY=$KEY\$" "$OK/secrets/stack.env")" 1
check "stack.env is mode 600" "$(stat -c %a "$OK/secrets/stack.env")" 600
check "backup password kept" "$(grep -c '^OK_BACKUP_PASSWORD=fake-restic-password-for-tests$' "$OK/secrets/stack.env")" 1
check "application key never printed" "$(grep -c "$KEY" <<<"$out" || true)" 0
check "application key not in any log" "$(grep -rl "$KEY" "$OK/logs" "$WORK/repo/restic.log" 2>/dev/null | wc -l)" 0
check "application key never on curl's command line" "$(count "$KEY" "$WORK/curl-argv.log")" 0
check "Backblaze got the right key (via the header)" "$(curl -fs "http://127.0.0.1:$PORT/__state" | jq -r '.[-1]|"\(.id) \(.ok)"')" "$KID true"
check "session token never printed" "$(grep -c 'MOCK-SESSION-TOKEN' <<<"$out" || true)" 0
check "exactly one nightly job" "$(grep -c 'backup.sh run --label nightly' "$OK_CRON_FILE")" 1
check "warns that another backup job is active" "$(grep -c 'another backup job is active' <<<"$out")" 1
check "  names the hand-made timer" "$(grep -c 'systemd timer b2-backup.timer' <<<"$out")" 1
check "  names the hand-made cron file" "$(grep -c "cron file $OK_CRON_DIR/b2-backup" <<<"$out")" 1
check "  names the root crontab line" "$(grep -c 'root crontab: 15 2 \* \* \* restic' <<<"$out")" 1
check "  does not flag unrelated cron jobs" "$(grep -cE 'e2scrub_all|certbot' <<<"$out" || true)" 0
check "  says how to switch it off" "$(grep -c 'Switching from a hand-made backup' <<<"$out")" 1
check "restic got the credentials every time" "$(count 'creds=bad' "$WORK/repo/restic.log")" 0
check "first snapshot sent" "$(count 'creds=ok backup' "$WORK/repo/restic.log")" 1
check "default retention 7/4/6" "$(grep -c -- '--keep-daily 7 --keep-weekly 4 --keep-monthly 6' "$WORK/repo/restic.log")" 1
check "retention groups by host + tags (one group per kind, not one per folder)" "$(grep 'creds=ok forget' "$WORK/repo/restic.log" | grep -vc -- '--group-by host,tags' || true)" 0
check "one-line result" "$(grep -c "^Off-site backups: ON -> $WANT_TARGET | first snapshot f00d0000 sent, restore test PASS" <<<"$out")" 1
check "setup log is mode 600" "$(stat -c %a "$OK/logs/b2-setup.log")" 600

echo "== re-run: keep (default) changes nothing"
cp "$CONF" "$WORK/conf.before"; cp "$OK/secrets/stack.env" "$WORK/env.before"
out=$(printf '\n' | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "says it is already set up" "$(grep -c 'already set up' <<<"$out")" 1
check "client.conf unchanged" "$(cmp -s "$CONF" "$WORK/conf.before" && echo same)" same
check "stack.env unchanged" "$(cmp -s "$OK/secrets/stack.env" "$WORK/env.before" && echo same)" same

echo "== re-run: replace with the same key is idempotent"
out=$(printf 'y\n%s\n%s\n\n\n' "$KID" "$KEY" | bash "$B2" --config "$CONF" --skip-first-backup 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "one BACKUP_TARGET line" "$(grep -c '^BACKUP_TARGET=' "$CONF")" 1
check "one key ID line" "$(grep -c '^OK_BACKUP_ACCESS_KEY_ID=' "$OK/secrets/stack.env")" 1
check "one application key line" "$(grep -c '^OK_BACKUP_SECRET_ACCESS_KEY=' "$OK/secrets/stack.env")" 1
check "still exactly one nightly job" "$(grep -c 'backup.sh run --label nightly' "$OK_CRON_FILE")" 1
check "key not printed on re-run" "$(grep -c "$KEY" <<<"$out" || true)" 0

echo "== retention settings are honoured"
sed -i -e 's/^BACKUP_KEEP_DAILY=.*/BACKUP_KEEP_DAILY="3"/' -e 's/^BACKUP_KEEP_WEEKLY=.*/BACKUP_KEEP_WEEKLY="2"/' -e 's/^BACKUP_KEEP_MONTHLY=.*/BACKUP_KEEP_MONTHLY="12"/' "$CONF"
bash "$BK" run --label nightly --config "$CONF" > "$WORK/run.out" 2>&1 || { cat "$WORK/run.out"; false; }
check "restic forget used 3/2/12" "$(grep -c -- '--keep-daily 3 --keep-weekly 2 --keep-monthly 12' "$WORK/repo/restic.log")" 1
sed -i 's/^BACKUP_KEEP_DAILY=.*/BACKUP_KEEP_DAILY="seven"/' "$CONF"
out=$(bash "$BK" list --config "$CONF" 2>&1) && rc=0 || rc=$?
check "a non-number is refused" "$(grep -c 'BACKUP_KEEP_DAILY must be a whole number' <<<"$out")" 1
sed -i 's/^BACKUP_KEEP_DAILY=.*/BACKUP_KEEP_DAILY="7"/' "$CONF"

echo "== verify: PASS on a good snapshot"
out=$(bash "$BK" verify --config "$CONF" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
check "exits 0" "$rc" 0
check "prints PASS" "$(grep -c '^RESTORE TEST: PASS' <<<"$out")" 1
check "integrity checked" "$(grep -c 'PASS  database integrity_check: ok' <<<"$out")" 1
check "row counts shown" "$(grep -c 'workspaces 1, users 2, objectives 3' <<<"$out")" 1
check "scratch copy removed" "$(find "$OK/backups" -maxdepth 1 -name '.verify-*' | wc -l)" 0

echo "== verify: FAIL on a damaged snapshot"
out=$(FAKE_RESTIC_CORRUPT=1 bash "$BK" verify --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits non-zero" "$([ "$rc" -ne 0 ] && echo yes)" yes
check "prints FAIL" "$(grep -c '^RESTORE TEST: FAIL' <<<"$out")" 1
check "scratch copy removed after FAIL" "$(find "$OK/backups" -maxdepth 1 -name '.verify-*' | wc -l)" 0

echo "== verify without BACKUP_TARGET checks the newest local backup"
sed -i 's/^BACKUP_TARGET=.*/BACKUP_TARGET=""/' "$CONF"
out=$(bash "$BK" verify --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "local restore test PASS" "$(grep -c '^RESTORE TEST: PASS.*on this server' <<<"$out")" 1

echo "== BACKUP_HOME=offsite: home goes to restic as a folder, not into a nightly tarball"
sed -i "s#^BACKUP_TARGET=.*#BACKUP_TARGET=\"$WANT_TARGET\"#" "$CONF"
grep -q '^BACKUP_HOME=' "$CONF" || echo 'BACKUP_HOME="archive"' >> "$CONF"
sed -i 's/^BACKUP_HOME=.*/BACKUP_HOME="offsite"/' "$CONF"
mkdir -p "$OK/state/home/memory"; echo "agent memory" > "$OK/state/home/memory/general.md"
: > "$WORK/repo/restic.log"
out=$(bash "$BK" run --label nightly --config "$CONF" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
check "exits 0" "$rc" 0
night=$(find "$OK/backups" -maxdepth 1 -name 'nightly-*' | sort | tail -1)
check "no home.tar.gz in the local folder" "$([ -e "$night/home.tar.gz" ] && echo present || echo absent)" absent
check "database, data, secrets still in it" "$(n=0; for x in command-center.db data.tar.gz secrets.tar.gz; do [ -s "$night/$x" ] && n=$((n+1)); done; echo "$n")" 3
check "MANIFEST: home=offsite" "$(grep -c '^home=offsite$' "$night/MANIFEST")" 1
check "MANIFEST: home_path" "$(grep -c "^home_path=$OK/state/home\$" "$night/MANIFEST")" 1
home_snap=$(sed -n 's/^home_snapshot=//p' "$night/MANIFEST")
check "MANIFEST names the home snapshot" "$([ -n "$home_snap" ] && echo yes)" yes
check "home sent as a folder with its own tag" "$(grep -c -- "backup --quiet --host ok-[a-z0-9-]* --tag operationkit-home --tag nightly $OK/state/home\$" "$WORK/repo/restic.log")" 1
check "home sent BEFORE the folder that names it" "$(grep 'creds=ok backup' "$WORK/repo/restic.log" | head -1 | grep -c operationkit-home)" 1
check "the folder snapshot holds the MANIFEST with that id" "$(grep -rl "^home_snapshot=$home_snap\$" "$WORK/repo"/snap-*/ 2>/dev/null | wc -l)" 1
check "both kinds are kept by the retention policy" "$(grep -c 'forget .*--tag operationkit-home' "$WORK/repo/restic.log") $(grep -c 'forget .*--tag operationkit --group-by' "$WORK/repo/restic.log")" "1 1"
check "MANIFEST checksums still verify" "$(cd "$night" && grep -E '^[0-9a-f]{64}  ' MANIFEST | sha256sum -c --quiet - >/dev/null 2>&1 && echo ok)" ok

echo "== BACKUP_HOME=offsite: the restore test checks the home snapshot"
out=$(bash "$BK" verify --config "$CONF" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
check "exits 0" "$rc" 0
check "prints PASS" "$(grep -c '^RESTORE TEST: PASS' <<<"$out")" 1
check "home snapshot found and not empty" "$(grep -c "PASS  home: off-site snapshot ${home_snap:0:8} .* entries in $OK/state/home" <<<"$out")" 1
hm=$(grep -lx "id=$home_snap" "$WORK/repo"/snap-*.meta); mv "$hm" "$hm.hidden"    # that night's home snapshot "forgotten"
out=$(bash "$BK" verify --config "$CONF" 2>&1) && rc=0 || rc=$?
mv "$hm.hidden" "$hm"
check "a missing home snapshot is a FAIL" "$([ "$rc" -ne 0 ] && grep -c 'home: snapshot .* is not in the repository' <<<"$out")" 1

echo "== BACKUP_HOME=offsite: fetch brings home back with its database, restore puts it in place"
out=$(bash "$BK" fetch --config "$CONF" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
check "exits 0" "$rc" 0
fetched=$(sed -n 's/.*backup.sh restore \(.*\) --config .*/\1/p' <<<"$out" | tail -1)
check "home downloaded next to the database" "$(cat "$fetched/home/memory/general.md" 2>/dev/null)" "agent memory"
check "and the projects too" "$(cat "$fetched/home/projects/readme.txt" 2>/dev/null)" "note"
echo "changed after the backup" > "$OK/state/home/memory/general.md"
out=$(FAKE_DOCKER_OK=1 bash "$BK" restore "$fetched" --config "$CONF" --yes 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
check "restore exits 0" "$rc" 0
check "home is back as it was that night" "$(cat "$OK/state/home/memory/general.md")" "agent memory"
check "the replaced home was moved aside, not deleted" "$(cat "$(find "$OK/backups" -maxdepth 1 -name 'pre-restore-*' | sort | tail -1)/home/memory/general.md")" "changed after the backup"
check "says home was restored" "$(grep -c 'restored database, data, home, secrets' <<<"$out")" 1

echo "== BACKUP_HOME=offsite: a run that sends nothing off-site still archives home"
out=$(bash "$BK" run --label manual --config "$CONF" 2>&1) && rc=0 || rc=$?
man=$(find "$OK/backups" -maxdepth 1 -name 'manual-*' | sort | tail -1)
check "manual: home.tar.gz written" "$([ -s "$man/home.tar.gz" ] && echo yes)" yes
check "manual: MANIFEST home=archive" "$(grep -c '^home=archive$' "$man/MANIFEST")" 1
sleep 1
out=$(bash "$BK" run --label nightly --no-offsite --config "$CONF" 2>&1) && rc=0 || rc=$?
night=$(find "$OK/backups" -maxdepth 1 -name 'nightly-*' | sort | tail -1)
check "--no-offsite: home.tar.gz written" "$([ -s "$night/home.tar.gz" ] && echo yes)" yes
check "--no-offsite: says why" "$(grep -c 'home goes into home.tar.gz instead' <<<"$out")" 1
out=$(bash "$BK" install-cron --config "$CONF" 2>&1)
check "install-cron reports the mode" "$(grep -c 'BACKUP_HOME=offsite' <<<"$out")" 1
echo "== status: which nightly backup runs here (read-only; update.sh prints it)"
out=$(bash "$BK" status --config "$CONF" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
check "exits 0" "$rc" 0
check "shows the built-in nightly job and its time" "$(grep -c 'nightly job:  03:30 server time' <<<"$out")" 1
check "shows the off-site target" "$(grep -c "off-server:   $WANT_TARGET" <<<"$out")" 1
check "shows how home is kept" "$(grep -c 'home:         its own restic snapshot each night' <<<"$out")" 1
check "shows the newest nightly folder" "$(grep -c "newest:       $(basename "$night")" <<<"$out")" 1
check "still names the hand-made job" "$(grep -c "cron file $OK_CRON_DIR/b2-backup" <<<"$out")" 1
touch -d '3 days ago' "$night"
check "a stale nightly is called out" "$(bash "$BK" status --config "$CONF" 2>&1 | grep -c 'is 72h old')" 1
touch "$night"
check "update.sh prints it at the end" "$(grep -c 'backup.sh" status --config "$CONFIG"' "$INST/update.sh")" 1
rm -f "$OK_CRON_DIR/b2-backup"; printf '0 4 * * * /usr/bin/certbot renew\n' > "$OK_ROOT_CRONTAB"
check "no warning once the hand-made jobs are gone" "$(bash "$BK" install-cron --config "$CONF" 2>&1 | grep -c 'another backup job' || true)" 0
check "status: other jobs none" "$(bash "$BK" status --config "$CONF" 2>&1 | grep -c 'other jobs:   none')" 1
mv "$OK_CRON_FILE" "$OK_CRON_FILE.off"
check "status: a missing nightly job is called out" "$(bash "$BK" status --config "$CONF" 2>&1 | grep -c 'no built-in nightly job')" 1
mv "$OK_CRON_FILE.off" "$OK_CRON_FILE"
sed -i 's/^BACKUP_HOME=.*/BACKUP_HOME="tarball"/' "$CONF"
out=$(bash "$BK" list --config "$CONF" 2>&1) && rc=0 || rc=$?
check "a wrong BACKUP_HOME is refused" "$(grep -c 'BACKUP_HOME must be archive or offsite' <<<"$out")" 1
sed -i 's/^BACKUP_HOME=.*/BACKUP_HOME="archive"/' "$CONF"

echo
if [ "$fails" -eq 0 ]; then echo "b2-setup-test: all checks passed"; else echo "b2-setup-test: $fails check(s) FAILED"; exit 1; fi
