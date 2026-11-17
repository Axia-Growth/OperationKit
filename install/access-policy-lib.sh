#!/usr/bin/env bash
# install/access-policy-lib.sh — build the "Allowed people" include list on a
# re-run without wiping the teammates the app added (obj 900023).
#
# Two writers share that one Cloudflare Access policy:
#   * the INSTALLER, from client.conf (ACCESS_ALLOWED_EMAILS and
#     ACCESS_ALLOWED_EMAIL_DOMAIN), on every install.sh / update.sh run;
#   * the APP, when an admin adds, re-emails or removes someone in
#     Settings -> Users and the install holds an Access sync token. It only
#     ever adds or drops a single {email:{email}} entry.
#
# The installer used to REPLACE the include list with client.conf's entries, so
# every update wiped every teammate added from the UI. This merge keeps them:
#
#   result = existing include
#            - entries the installer itself wrote LAST time that client.conf no
#              longer lists (so taking an address out of client.conf still works)
#            + client.conf's entries that are not there yet
#
# "Written last time" is what the previous run recorded in stack.env
# (OK_CF_ACCESS_PROTECTED_EMAILS / OK_CF_ACCESS_ALLOWED_DOMAIN). Anything else
# in the policy — UI-added emails, rules someone made by hand in the Cloudflare
# dashboard, rule kinds this script does not understand — is carried through
# verbatim. Matching is case-insensitive; order is kept, new entries go last.
#
# Pure: reads its arguments, prints JSON, calls nothing. Needs jq.

# ok_access_conf_include EMAILS_CSV DOMAIN -> the include entries client.conf asks for.
ok_access_conf_include() {
  jq -nc --arg emails "${1-}" --arg dom "${2-}" '
    [($emails | split(",")[] | gsub("\\s"; "") | ascii_downcase | select(length > 0) | {email:{email:.}}),
     ($dom | gsub("\\s"; "") | ascii_downcase | ltrimstr("@") | select(length > 0) | {email_domain:{domain:.}})]'
}

# ok_access_merge_include EXISTING_INCLUDE_JSON CONF_INCLUDE_JSON PREV_EMAILS_CSV PREV_DOMAIN
#   EXISTING_INCLUDE_JSON  the policy's current include array ("" or "null" = no policy yet)
#   CONF_INCLUDE_JSON      ok_access_conf_include's output for THIS run
#   PREV_*                 what the previous run recorded as installer-owned
ok_access_merge_include() {
  local existing=${1:-} conf=${2:-[]}
  [ -n "$existing" ] || existing='[]'
  jq -nc --argjson ex "$existing" --argjson conf "$conf" --arg pe "${3-}" --arg pd "${4-}" '
    def em: (.email.email? // empty) | ascii_downcase;
    def dm: (.email_domain.domain? // empty) | ascii_downcase;
    def key: if (.email.email? | type) == "string" then "e:" + (.email.email | ascii_downcase)
             elif (.email_domain.domain? | type) == "string" then "d:" + (.email_domain.domain | ascii_downcase)
             else "x:" + tojson end;
    ($conf | map(key)) as $want
    | ([$pe | split(",")[] | gsub("\\s"; "") | ascii_downcase | select(length > 0) | "e:" + .]
       + [$pd | gsub("\\s"; "") | ascii_downcase | ltrimstr("@") | select(length > 0) | "d:" + .]) as $prev
    | (if ($ex | type) == "array" then $ex else [] end)
    | map(select(key as $k | ($prev | index($k)) == null or ($want | index($k)) != null))
    | . as $kept
    | ($kept | map(key)) as $have
    | $kept + ($conf | map(select(key as $k | ($have | index($k)) == null)))'
}

# ok_access_app_added MERGED_INCLUDE_JSON CONF_INCLUDE_JSON -> how many single
# emails are in the policy that client.conf does not list (the app's / by hand).
ok_access_app_added() {
  jq -nc --argjson m "${1:-[]}" --argjson c "${2:-[]}" '
    ($c | map(.email.email? // empty | ascii_downcase)) as $ce
    | [$m[] | .email.email? // empty | ascii_downcase | select(. as $e | ($ce | index($e)) == null)] | length'
}
