# shellcheck shell=bash
# install/verify-lib.sh — the throw-away test card install/verify.sh (check 8)
# creates, kept here so it can be unit-tested (install/test/verify-card-test.sh).
#
# The card must be creatable on EVERY run, not just the first. The board's
# duplicate-title guard (app/server/src/lib/objective-dedupe.ts) answers 409 to a
# second open card with the same normalized title in the same workspace inside its
# window, and verify used to post the fixed title "Install check: say hello", so
# every verify after the first one failed with "could not create the test card
# (409)" (cards #900022 / #900069, fixed in PR #628). Two guards, either of which
# is enough on its own:
#   * the title carries this run's unique marker, so it never equals an older one
#   * `force: true` tells the guard to create the card anyway
# verify.sh also deletes the card again on the way out, pass or fail.
#
# PURE: strings in, JSON / strings out. No network, no secrets.

# A marker no other run shares: epoch seconds, a random number, and the PID.
# The worker must echo it back, so the same value proves the AI answered.
ok_verify_marker() { printf 'OK-INSTALL-CHECK-%s-%s-%s' "$(date +%s)" "$RANDOM" "$$"; }

# ok_verify_card_json WORKSPACE MARKER — the POST /api/objectives body.
ok_verify_card_json() {
  local ws=${1:?workspace} m=${2:?marker}
  jq -nc --arg w "$ws" --arg m "$m" '{
    title: ("Install check: say hello " + $m),
    workspace: $w, start: true, skip_ai_review: true, force: true,
    description: ("This is an automated install check. Reply with exactly this text and nothing else, then stop: " + $m + ". Do not create or edit any files.")
  }'
}
