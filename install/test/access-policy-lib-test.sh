#!/usr/bin/env bash
# install/access-policy-lib.sh (obj 900023): a re-run of the installer MERGES
# client.conf into the "Allowed people" include list instead of replacing it,
# so teammates added from Settings -> Users survive every update.sh.
#   bash install/test/access-policy-lib-test.sh      (needs jq; no network)
set -uo pipefail
LIB=$(cd "$(dirname "$0")/.." && pwd)
fails=0; check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got $2, want $3)"; fails=$((fails+1)); fi; }
f() { bash -c 'set -euo pipefail; source "$0/access-policy-lib.sh"; fn=$1; shift; "$fn" "$@"' "$LIB" "$@"; }

D='{"email_domain":{"domain":"acme.com"}}'
A='{"email":{"email":"contractor@outside.dev"}}'
B='{"email":{"email":"advisor@another.org"}}'
O='{"email":{"email":"owner@acme.com"}}'
X='{"group":{"id":"dashboard-made-group"}}'

check "conf include: emails lowercased + trimmed, domain last" "$(f ok_access_conf_include ' Owner@ACME.com , ' '@Acme.com')" "[$O,$D]"
check "conf include: empty conf is empty" "$(f ok_access_conf_include '' '')" '[]'
check "first install (no policy yet) = client.conf" "$(f ok_access_merge_include '' "[$D]" '' '')" "[$D]"
check "re-run keeps app-added emails" "$(f ok_access_merge_include "[$D,$A,$B]" "[$D]" '' 'acme.com')" "[$D,$A,$B]"
check "re-run keeps rules made by hand (unknown kinds verbatim)" "$(f ok_access_merge_include "[$D,$X]" "[$D]" '' 'acme.com')" "[$D,$X]"
check "a newly listed client.conf address is appended once" "$(f ok_access_merge_include "[$D,$A]" "[$O,$D]" '' 'acme.com')" "[$D,$A,$O]"
check "idempotent: merging the result again changes nothing" "$(f ok_access_merge_include "[$D,$A,$O]" "[$O,$D]" 'owner@acme.com' 'acme.com')" "[$D,$A,$O]"
check "case-insensitive: no duplicate for OWNER@ACME.COM" "$(f ok_access_merge_include '[{"email":{"email":"OWNER@ACME.COM"}},'"$D"']' "[$O,$D]" '' '')" '[{"email":{"email":"OWNER@ACME.COM"}},'"$D"']'
check "address dropped from client.conf is removed (installer owned it)" "$(f ok_access_merge_include "[$D,$A,$O]" "[$D]" 'owner@acme.com' 'acme.com')" "[$D,$A]"
check "domain changed in client.conf: old one out, new one in, teammates kept" "$(f ok_access_merge_include "[$D,$A]" '[{"email_domain":{"domain":"acme.io"}}]' '' 'acme.com')" '['"$A"',{"email_domain":{"domain":"acme.io"}}]'
check "an app-added email is never dropped just because conf changed" "$(f ok_access_merge_include "[$D,$A]" "[$O]" 'owner@acme.com' '')" "[$D,$A,$O]"
check "count of addresses outside client.conf" "$(f ok_access_app_added "[$D,$A,$B,$O]" "[$O,$D]")" 2
check "the library holds no token handling" "$(grep -vE '^[[:space:]]*#' "$LIB/access-policy-lib.sh" | grep -ciE 'token|secret|curl' | tr -d ' ')" 0

[ "$fails" -eq 0 ] && echo "access-policy lib test: ALL PASS" || { echo "access-policy lib test: $fails FAILED"; exit 1; }
