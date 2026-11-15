#!/usr/bin/env bash
# install-backup-timer.sh must refuse to put the old-layout cc-backup timer on a
# server that runs an Operation Kit install (backed up by install/backup.sh).
#   bash scripts/migrate/legacy-backup-guard-test.sh      No root, no network.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }
guard() { OK_INSTALL_MARKERS="$1" bash -c 'source "$0/lib.sh"; refuse_on_operationkit_install && echo allowed' "$HERE" 2>&1; }

touch "$WORK/operationkit-backup"
out=$(guard "$WORK/nope $WORK/operationkit-backup")
check "refuses when an Operation Kit install is found" "$(grep -c 'runs an Operation Kit install' <<<"$out")" 1
check "  and says what backs it up instead" "$(grep -c 'install/backup.sh' <<<"$out")" 1
check "  and never continues" "$(grep -c allowed <<<"$out" || true)" 0
check "allows a server without one" "$(guard "$WORK/nope $WORK/nope2")" allowed
check "install-backup-timer.sh runs the guard right after the root check" \
  "$(grep -A1 'die "run as root"' "$HERE/install-backup-timer.sh" | grep -c '^refuse_on_operationkit_install$')" 1
check "cc-backup.sh itself is left alone (an existing job is never changed by a code update)" \
  "$(grep -c refuse_on_operationkit_install "$HERE/cc-backup.sh" || true)" 0

if [ "$fails" -eq 0 ]; then echo "legacy-backup-guard-test: all passed"; else echo "legacy-backup-guard-test: $fails failed"; exit 1; fi
