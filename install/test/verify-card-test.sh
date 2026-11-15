#!/usr/bin/env bash
# The install/verify.sh test card must be creatable on every re-run, not just the
# first (cards #900022 / #900069, PR #628): a unique title per run, `force: true`,
# and the card deleted again on the way out, pass or fail.
#   bash install/test/verify-card-test.sh
# No root, no network, no running app. The same titles are also run through the
# board's real duplicate guard in app/server/src/lib/install-verify-card.test.ts.
# shellcheck disable=SC2016  # the greps below match verify.sh source text literally
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=$HERE/..
V=$LIB/verify.sh

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }
# b FN ARGS… — one library call in a fresh shell, like a separate verify run.
b() { bash -c 'set -euo pipefail; source "$0/verify-lib.sh"; f=$1; shift; "$f" "$@"' "$LIB" "$@"; }

echo "== every run gets its own marker, so its own title"
markers=$(for _ in $(seq 25); do b ok_verify_marker; echo; done)
check "25 runs, 25 different markers" "$(sort -u <<<"$markers" | grep -c .)" 25
check "marker shape" "$(grep -cE '^OK-INSTALL-CHECK-[0-9]{9,}-[0-9]+-[0-9]+$' <<<"$markers")" 25

echo "== the card body"
m1=$(b ok_verify_marker); m2=$(b ok_verify_marker)
j1=$(b ok_verify_card_json acme "$m1"); j2=$(b ok_verify_card_json acme "$m2")
check "force is true (the duplicate guard creates it anyway)" "$(jq -r '.force' <<<"$j1")" true
check "title carries the marker" "$(jq -r '.title' <<<"$j1")" "Install check: say hello $m1"
check "two runs, two different titles" "$([ "$(jq -r .title <<<"$j1")" != "$(jq -r .title <<<"$j2")" ] && echo yes)" yes
check "the worker is asked to echo the same marker" "$(jq -r '.description | contains($m)' --arg m "$m1" <<<"$j1")" true
check "starts at once, no AI review, right workspace" "$(jq -r '"\(.start) \(.skip_ai_review) \(.workspace)"' <<<"$j1")" "true true acme"
check "a missing workspace is refused" "$(b ok_verify_card_json "" "$m1" >/dev/null 2>&1 && echo accepted || echo refused)" refused

echo "== verify.sh uses it, and removes its card however it exits"
check "sources verify-lib.sh" "$(grep -c 'source "$(dirname "${BASH_SOURCE\[0\]}")/verify-lib.sh"' "$V")" 1
check "builds the card with ok_verify_card_json" "$(grep -c 'card=$(ok_verify_card_json "$SLUG" "$marker")' "$V")" 1
check "the title is only built in the lib (no copy in verify.sh)" "$(grep -c "Install check: say hello" "$V")" 0
check "cleanup runs on EXIT" "$(grep -c '^trap cleanup EXIT$' "$V")" 1
check "cleanup deletes the test card" "$(grep -c 'api DELETE "/api/objectives/$VERIFY_CARD_ID"' "$V")" 1
# The id must be recorded BEFORE the wait loop, or a timeout leaves the card behind.
id_line=$(grep -n 'VERIFY_CARD_ID=$id' "$V" | cut -d: -f1); wait_line=$(grep -n 'while \[ "$waited" -lt "$CARD_TIMEOUT" \]' "$V" | cut -d: -f1)
check "card id recorded before the wait loop" "$([ -n "$id_line" ] && [ -n "$wait_line" ] && [ "$id_line" -lt "$wait_line" ] && echo yes)" yes

echo
if [ "$fails" -eq 0 ]; then echo "verify-card-test: all passed"; else echo "verify-card-test: $fails failed"; exit 1; fi
