#!/usr/bin/env bash
# A backup taken while the app is stopped, on a host without sqlite3, is a plain
# file copy of the database plus its -wal file (install/backup.sh, snapshot_db).
# A fresh Ubuntu 24.04 server has no sqlite3, so that is the path a client's
# server takes. Restore must put the -wal file back: the newest committed
# changes are only in there. No root, no Docker, no network.
#   bash install/test/backup-wal-restore-test.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
INST=$HERE/..
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }

# ── a fake install whose database was left the way a stopped app leaves it ────
OK=$WORK/ok
mkdir -p "$OK/state/data" "$OK/state/home" "$OK/secrets" "$WORK/bin"
chmod 700 "$OK/secrets"
sed -e "s#^INSTALL_DIR=.*#INSTALL_DIR=\"$OK\"#" "$INST/client.conf.example" > "$WORK/client.conf"
printf 'OK_BACKUP_PASSWORD=%s\n' "fake-restic-password-for-tests" > "$OK/secrets/stack.env"; chmod 600 "$OK/secrets/stack.env"
DB=$OK/state/data/command-center.db
# One row reaches the database file, the second is committed but still in the
# -wal file. os._exit skips SQLite's close, as a stopped or killed app does, so
# no checkpoint folds the -wal back in.
python3 -I - "$DB" <<'PY'
import os, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.executescript("""CREATE TABLE workspaces(id); CREATE TABLE users(id); CREATE TABLE objectives(id); CREATE TABLE projects(id);
INSERT INTO objectives VALUES(1);""")
c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA wal_autocheckpoint=0")
c.execute("INSERT INTO objectives VALUES(2)"); c.commit()
os._exit(0)
PY
rows() { python3 -I -c 'import sqlite3,sys; print(sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True).execute("SELECT count(*) FROM objectives").fetchone()[0])' "$1"; }

# ── shims: root without root; the app is stopped, then starts healthy ─────────
cat > "$WORK/bin/id" <<'EOF2'
#!/usr/bin/env bash
if [ "${1:-}" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi
EOF2
cat > "$WORK/bin/docker" <<'EOF2'
#!/usr/bin/env bash
case "${1:-}" in inspect|image) exit 1 ;; *) exit 0 ;; esac
EOF2
cat > "$WORK/bin/curl" <<'EOF2'
#!/usr/bin/env bash
[[ " $* " == *" http://127.0.0.1:3002/api/health "* ]]
EOF2
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH"
# CI runners and most laptops have sqlite3; a fresh Ubuntu 24.04 server does not.
command() { if [ "${1:-}" = -v ] && [ "${2:-}" = sqlite3 ]; then return 1; fi; builtin command "$@"; }
export -f command
BK="$INST/backup.sh"; CONF=$WORK/client.conf

echo "== backup with the app stopped and no sqlite3: a file copy, with the -wal file"
out=$(bash "$BK" run --config "$CONF" --no-offsite 2>&1) && rc=0 || rc=$?
check "backup exits 0" "$rc" 0
check "it was the file-copy path" "$(grep -c 'copied as files' <<<"$out")" 1
dir=$(find "$OK/backups" -mindepth 1 -maxdepth 1 -type d -name 'manual-*' | sort | tail -1)
check "the -wal file is in the backup and not empty" "$([ -s "$dir/command-center.db-wal" ] && echo yes || echo no)" yes

echo "== restore: both committed rows are back"
# The data folder is replaced wholesale, so nothing of the old database is left to help.
out=$(bash "$BK" restore "$dir" --config "$CONF" --yes 2>&1) && rc=0 || rc=$?
check "restore exits 0" "$rc" 0
check "rows after the restore" "$(rows "$DB")" 2

echo "== a backup without a -wal file still restores"
rm -f "$dir/command-center.db-wal" "$dir/command-center.db-shm"
out=$(bash "$BK" restore "$dir" --config "$CONF" --yes 2>&1) && rc=0 || rc=$?
check "restore exits 0" "$rc" 0
check "rows after the restore (the database file alone)" "$(rows "$DB")" 1

if [ "$fails" -eq 0 ]; then echo; echo "backup-wal-restore-test: all checks passed"; else echo; echo "backup-wal-restore-test: $fails check(s) failed"; exit 1; fi
