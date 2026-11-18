#!/usr/bin/env bash
# app/server/src/services/dev-ops/host-runner.sh — the HOST half of the
# Operation Kit Dev operator tools (obj 901424).
#
# The app container cannot run update.sh or read the installer's Cloudflare
# token: both live on the host. services/dev-ops/host-exec.ts runs THIS file on
# the host (a throwaway privileged helper container that nsenters PID 1, the
# same way services/preview-spool.ts reaches the host), passing the script text
# itself as `bash -c`, so what runs is always the version the running server
# shipped with, never a file a deploy is rewriting mid-run.
#
#   host-runner.sh deploy <SRC> <CONF> <ID> <HEALTH_URL> <HOST_DATA_DIR>
#   host-runner.sh <cf-op> <SRC> <CONF>          (request JSON on stdin)
#        cf-op: access-list | access-add | access-remove
#               dns-list | dns-upsert | dns-delete | cf-run
#
# deploy runs exactly:
#   sudo bash <SRC>/install/update.sh --config <CONF>
# (no --skip-cloudflare, no --skip-backup, no force flag — none exists and none
# is ever added), then waits for the app, runs install/verify.sh and checks
# HEALTH_URL. If verify or health fails it rolls back with update.sh's own
# rollback steps: the old commit, the pre-update images, the pre-update
# database backup (install/backup.sh restore --yes), and starts the stack.
# Outcome: <HOST_DATA_DIR>/dev-ops/deploy-<ID>.json (the app reads it as
# /app/data/dev-ops/…). The full log stays on the host in
# <INSTALL_DIR>/dev-ops/deploy-<ID>.log (outside the data folder a restore
# moves aside).
#
# Cloudflare ops read the installer's token from <INSTALL_DIR>/secrets/
# cloudflare-api-token and hand it to curl on STDIN (`curl -K -`), so it is
# never in a process argument list, never printed and never in the output.
# Guards repeated here (the server checks them first):
#   * Access: one exact {email:{email}} entry added or dropped per call; never
#     an email_domain / everyone / other rule; a protected address (the seed
#     hashes below, OK_CF_ACCESS_PROTECTED_EMAILS, and the request's lists) is
#     never removed; a remove may drop ONLY the address it names; every other
#     entry must still be there after the write.
#   * DNS: only inside ZONE, never the install's own DOMAIN record, only
#     A / AAAA / CNAME / TXT / MX, and a change or delete must match exactly one
#     record.
# Every op prints ONE JSON line last on stdout: {"ok":true|false,"code":…,…}.
set -uo pipefail

ACTION=${1:-}
SRC=${2:-}
CONFIG_FILE=${3:-}
CF_API=${OK_DEVOPS_CF_API:-https://api.cloudflare.com/client/v4}
# The owner's two Access sign-in addresses, as SHA-256 of the lower-cased address
# (same values as ACCESS_PROTECTED_SEED_SHA256 in cloudflare.ts; hashes so the OSS
# publish cannot rewrite them and no address is published).
SEED_PROTECTED_SHA256="4dbf772d2cbb322b1e9f8e01905405fba1008e5b95a605ea339597e960161536
7f65a1e471709cd9bf4414ee24a7210e5e692a36be87828edc18de6bf1a1a5f2"
ACCESS_POLICY="Allowed people"

out() { printf '%s\n' "$1"; }
fail_json() { jq -nc --arg c "$1" --arg m "$2" '{ok:false, code:$c, message:$m}'; }

safe_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$1" != *..* ]]; }
safe_path "$SRC" && safe_path "$CONFIG_FILE" || { out '{"ok":false,"code":"bad_args","message":"source or config path is not a plain absolute path"}'; exit 2; }
command -v jq >/dev/null 2>&1 || { out '{"ok":false,"code":"no_jq","message":"jq is not installed on the host"}'; exit 2; }
[ -f "$SRC/install/lib.sh" ] || { fail_json no_source "no Operation Kit source at $SRC"; exit 2; }
[ -f "$CONFIG_FILE" ] || { fail_json no_config "config file not found: $CONFIG_FILE"; exit 2; }

DRY_RUN=0
# shellcheck source=install/lib.sh
source "$SRC/install/lib.sh" >&2
# lib.sh turns errexit on; this runner handles every failure itself (a failed
# update must still reach the rollback below), so switch it back off.
set +e
conf_load "$CONFIG_FILE" >&2 || { fail_json bad_config "could not read $CONFIG_FILE"; exit 2; }
ok_paths

stack_env() { sed -n "s/^$1=//p" "$OK_SECRETS_ENV" 2>/dev/null | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

# ── deploy ───────────────────────────────────────────────────────────────────
if [ "$ACTION" = deploy ]; then
  ID=${4:-}; HEALTH=${5:-}; HOSTDATA=${6:-}
  [[ "$ID" =~ ^[0-9]{1,12}$ ]] || { fail_json bad_args "deploy id must be a number"; exit 2; }
  [[ "$HEALTH" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]*$ ]] || { fail_json bad_args "health URL must be https"; exit 2; }
  safe_path "$HOSTDATA" || { fail_json bad_args "host data dir is not a plain absolute path"; exit 2; }
  STATUS_DIR=$HOSTDATA/dev-ops
  STATUS=$STATUS_DIR/deploy-$ID.json
  LOG_DIR=$OK_DIR/dev-ops
  LOG=$LOG_DIR/deploy-$ID.log
  install -d -m 755 "$STATUS_DIR" "$LOG_DIR"
  exec 9>"$LOG_DIR/deploy.lock"
  if ! flock -n 9; then
    jq -nc --arg id "$ID" '{id:($id|tonumber), state:"failed", step:"lock", message:"another deploy is already running on this server"}' > "$STATUS"
    exit 1
  fi
  exec >>"$LOG" 2>&1

  OLD_SHA=$(git -c safe.directory='*' -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)
  START_TS=$(date -u +%Y%m%dT%H%M%SZ)
  BACKUP=""; NEW_SHA=""
  status() { # state step message
    local tail_txt; tail_txt=$(tail -c 6000 "$LOG" 2>/dev/null || true)
    install -d -m 755 "$STATUS_DIR"
    jq -nc --arg id "$ID" --arg s "$1" --arg step "$2" --arg m "$3" --arg from "$OLD_SHA" --arg to "$NEW_SHA" \
      --arg b "$BACKUP" --arg t "$tail_txt" --arg at "$(date -u +%FT%TZ)" \
      '{id:($id|tonumber), state:$s, step:$step, message:$m, from_sha:$from, to_sha:$to, backup_dir:$b, log_tail:$t, at:$at}' > "$STATUS.tmp" \
      && mv -f "$STATUS.tmp" "$STATUS"
  }
  # Waits are tunable only so the runner's own test does not sleep for minutes.
  PAUSE=${OK_DEVOPS_PAUSE:-5}
  wait_local() { # up to ~4 min for the app on the server itself
    local i; for i in $(seq 1 48); do curl -fsS --max-time 5 http://127.0.0.1:3002/api/health >/dev/null 2>&1 && return 0; sleep "$PAUSE"; done; return 1
  }
  check_health() { # the public URL, a few tries (~1 min). A real 200 only: a redirect
    # (e.g. Cloudflare Access sending to its login page) is NOT healthy.
    local i code; for i in $(seq 1 12); do
      code=$(curl -sS -o /dev/null -w '%{http_code}' --max-redirs 0 --max-time 10 "$HEALTH" 2>/dev/null || true)
      [ "$code" = 200 ] && return 0; sleep "$PAUSE"
    done; return 1
  }
  complete_backups() { # only folders backup.sh finished (restore refuses anything else)
    local d; while IFS= read -r d; do [ -f "$d/command-center.db" ] && [ -f "$d/data.tar.gz" ] && printf '%s\n' "$d"; done; return 0
  }
  newest_since() { # newest name (by its UTC stamp) at or after START_TS, from stdin
    local best="" n stamp
    while IFS= read -r n; do
      stamp=${n##*pre-update-}
      [[ "$stamp" < "$START_TS" ]] && continue
      [[ -z "$best" || "${best##*pre-update-}" < "$stamp" ]] && best=$n
    done
    printf '%s' "$best"
  }

  echo "== Operation Kit Dev deploy #$ID at $START_TS: $OLD_SHA → origin main"
  status running update "running update.sh"
  # The standard live flow, exactly. update.sh takes the pre-update backup itself.
  sudo bash "$SRC/install/update.sh" --config "$CONFIG_FILE"
  UPDATE_RC=$?
  NEW_SHA=$(git -c safe.directory='*' -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)
  BACKUP=$(find "$OK_DIR/backups" -mindepth 1 -maxdepth 1 -type d -name 'pre-update-*' 2>/dev/null | complete_backups | newest_since)

  FAILED_STEP=""
  if [ "$UPDATE_RC" -ne 0 ]; then
    FAILED_STEP=update
  else
    status running verify "waiting for the app, then verify.sh"
    wait_local || echo "WARN: the app did not answer on 127.0.0.1:3002 within 4 minutes"
    if ! sudo bash "$SRC/install/verify.sh" --config "$CONFIG_FILE"; then
      FAILED_STEP=verify
    else
      status running health "checking $HEALTH"
      check_health || FAILED_STEP=health
    fi
  fi

  if [ -z "$FAILED_STEP" ]; then
    status deployed done "deployed $NEW_SHA; verify.sh passed and $HEALTH answers"
    exit 0
  fi

  if [ -z "$BACKUP" ]; then
    # update.sh stops before changing anything when its backup step fails.
    status failed "$FAILED_STEP" "$FAILED_STEP failed before a pre-update backup existed: nothing was changed, so nothing was rolled back"
    exit 1
  fi

  echo "== $FAILED_STEP failed — rolling back to $OLD_SHA with $BACKUP"
  status running rollback "$FAILED_STEP failed; rolling back"
  RB_OK=1
  REPO_OWNER=$(stat -c %U "$SRC")
  if [ "$REPO_OWNER" != root ] && command -v sudo >/dev/null 2>&1; then
    sudo -u "$REPO_OWNER" -H git -c safe.directory='*' -C "$SRC" checkout --quiet --detach "$OLD_SHA" || RB_OK=0
  else
    git -c safe.directory='*' -C "$SRC" checkout --quiet --detach "$OLD_SHA" || RB_OK=0
  fi
  for img in operationkit-app ok-jail ok-jail-browser; do
    tag=$(docker image ls "$img" --format '{{.Tag}}' 2>/dev/null | grep '^pre-update-' | newest_since)
    if [ -n "$tag" ]; then docker tag "$img:$tag" "$img:local" || RB_OK=0; fi
  done
  sudo bash "$SRC/install/backup.sh" restore "$BACKUP" --config "$CONFIG_FILE" --yes || RB_OK=0
  # The restore moved the data folder aside: write the status into the restored one.
  status running rollback "restored $BACKUP; starting the previous version"
  docker compose --project-name operationkit --env-file "$OK_SETTINGS_ENV" --env-file "$OK_SECRETS_ENV" \
    -f "$SRC/install/docker-compose.yml" up -d || RB_OK=0
  NEW_SHA=$(git -c safe.directory='*' -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)
  wait_local || true
  if [ "$RB_OK" -eq 1 ] && check_health; then
    status rolled_back "$FAILED_STEP" "$FAILED_STEP failed after the update; rolled back to $OLD_SHA and restored $BACKUP; $HEALTH answers again"
    exit 1
  fi
  status rollback_failed "$FAILED_STEP" "$FAILED_STEP failed and the rollback did not bring $HEALTH back — the site needs a person (log: $LOG)"
  exit 1
fi

# ── Cloudflare ───────────────────────────────────────────────────────────────
REQ=$(cat)
jq -e . >/dev/null 2>&1 <<<"$REQ" || { fail_json bad_request "request is not JSON"; exit 2; }
arg() { jq -r --arg k "$1" '.[$k] // empty | tostring' <<<"$REQ"; }

TOKEN_FILE=$OK_SECRETS/cloudflare-api-token
ZONE=$(conf ZONE); DOMAIN=$(conf DOMAIN)
ZONE=${ZONE,,}; DOMAIN=${DOMAIN,,}

# curl reads the Authorization header from stdin: the token is never an argument.
cf() { # METHOD PATH [BODY]
  local m=$1 p=$2 b=${3-} tok
  tok=$(<"$TOKEN_FILE"); tok=${tok//[$'\r\n\t ']/}
  if [ -n "$b" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl -sS --max-time 20 -K - -X "$m" -H 'Content-Type: application/json' --data "$b" "$CF_API$p"
  else
    printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl -sS --max-time 20 -K - -X "$m" "$CF_API$p"
  fi
}
cf_ok() { jq -e '.success == true' >/dev/null 2>&1 <<<"$1"; }

if [ "$ACTION" = cf-run ]; then
  CMD=$(arg command)
  case "$CMD" in status|api-bypass|api-bic) ;; *) fail_json bad_command "only status, api-bypass and api-bic may run"; exit 2 ;; esac
  # Never down, never up --replace-dns, never agent-pass add.
  OUTPUT=$(bash "$SRC/install/cloudflare.sh" "$CMD" --config "$CONFIG_FILE" 2>&1); RC=$?
  jq -nc --argjson ok "$([ $RC -eq 0 ] && echo true || echo false)" --arg c "$CMD" --arg o "$(tail -c 12000 <<<"$OUTPUT")" \
    '{ok:$ok, code:(if $ok then "ran" else "command_failed" end), command:$c, output:$o}'
  exit 0
fi

[ -s "$TOKEN_FILE" ] || { fail_json no_token "the installer's Cloudflare API token file is missing on this server"; exit 0; }
[ -n "$ZONE" ] || { fail_json no_zone "client.conf has no ZONE"; exit 0; }

ZRES=$(cf GET "/zones?name=$ZONE")
cf_ok "$ZRES" || { fail_json cloudflare_error "could not read zone $ZONE"; exit 0; }
ZONE_ID=$(jq -r '.result[0].id // empty' <<<"$ZRES")
ACCOUNT_ID=$(jq -r '.result[0].account.id // empty' <<<"$ZRES")
[ -n "$ZONE_ID" ] || { fail_json no_zone "zone $ZONE not found for this token"; exit 0; }

case "$ACTION" in
access-list|access-add|access-remove)
  AUD=$(stack_env OK_CF_ACCESS_AUD)
  [ -n "$AUD" ] || { fail_json no_access_app "OK_CF_ACCESS_AUD is not set in secrets/stack.env"; exit 0; }
  APPS=$(cf GET "/accounts/$ACCOUNT_ID/access/apps?per_page=100")
  cf_ok "$APPS" || { fail_json cloudflare_error "could not list Access applications"; exit 0; }
  APP_ID=$(jq -r --arg a "$AUD" '[.result[]? | select(.aud == $a)][0].id // empty' <<<"$APPS")
  [ -n "$APP_ID" ] || { fail_json no_access_app "this install's Access application was not found"; exit 0; }
  read_policy() {
    local r; r=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies")
    cf_ok "$r" || return 1
    jq -c --arg n "$ACCESS_POLICY" '[.result[]? | select(.name == $n and (.decision // "") == "allow")][0] // empty' <<<"$r"
  }
  POLICY=$(read_policy) || { fail_json cloudflare_error "could not read the Access policies"; exit 0; }
  [ -n "$POLICY" ] || { fail_json no_policy "the '$ACCESS_POLICY' allow policy was not found"; exit 0; }
  INC=$(jq -c '.include // []' <<<"$POLICY")
  summary() { jq -c '{emails: [.[] | .email.email? // empty | ascii_downcase], domains: [.[] | .email_domain.domain? // empty | ascii_downcase], other_rules: ([.[] | select((has("email") or has("email_domain")) | not)] | length)}' <<<"$1"; }
  if [ "$ACTION" = access-list ]; then
    jq -nc --argjson s "$(summary "$INC")" '{ok:true, code:"listed", allow:$s}'
    exit 0
  fi
  EMAIL=$(arg email); EMAIL=${EMAIL,,}
  [[ "$EMAIL" =~ ^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$ ]] || { fail_json bad_email "one exact email address is required (no domain, no wildcard)"; exit 0; }
  # Every writable policy setting is carried over unchanged; only `include` changes.
  POLICY_KEYS='["name","decision","exclude","require","precedence","session_duration","approval_required","approval_groups","purpose_justification_required","purpose_justification_prompt","isolation_required","mfa_config","connection_rules"]'
  settings_of() { jq -c --argjson k "$POLICY_KEYS" 'with_entries(select(.key as $x | $k | index($x))) | with_entries(select(.value != null))' <<<"$1"; }
  put_include() { # NEW_INCLUDE_JSON
    local body; body=$(jq -c --argjson inc "$1" --argjson s "$(settings_of "$POLICY")" '$s + {include:$inc}' <<<'{}')
    local r; r=$(cf PUT "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies/$(jq -r .id <<<"$POLICY")" "$body")
    cf_ok "$r"
  }
  # Every include entry in $1 (except the dropped email) must be in $2 — rules of
  # every kind, not just emails.
  kept_all() { jq -e -n --argjson before "$1" --argjson after "$2" --arg drop "${3-}" '
    [$before[] | select(((.email.email? // null) | if . == null then true else (ascii_downcase != $drop) end))] as $want
    | ($after | map(tojson)) as $have | all($want[]; (tojson) as $t | $have | index($t) != null)' >/dev/null; }
  # The policy's other settings must be unchanged after the write.
  same_settings() { [ "$(settings_of "$1" | jq -S -c .)" = "$(settings_of "$2" | jq -S -c .)" ]; }
  if [ "$ACTION" = access-add ]; then
    if jq -e --arg e "$EMAIL" 'any(.[]; (.email.email? // "" | ascii_downcase) == $e)' >/dev/null <<<"$INC"; then
      jq -nc --arg e "$EMAIL" '{ok:true, code:"already_allowed", email:$e}'; exit 0
    fi
    if jq -e --arg d "${EMAIL##*@}" 'any(.[]; (.email_domain.domain? // "" | ascii_downcase) == $d)' >/dev/null <<<"$INC"; then
      jq -nc --arg e "$EMAIL" '{ok:true, code:"covered_by_domain", email:$e}'; exit 0
    fi
    NEW=$(jq -c --arg e "$EMAIL" '. + [{email:{email:$e}}]' <<<"$INC")
    [ "$(jq length <<<"$NEW")" -eq $(( $(jq length <<<"$INC") + 1 )) ] || { fail_json guard "refused: the change was not exactly one added email"; exit 0; }
    put_include "$NEW" || { fail_json cloudflare_error "Cloudflare refused the policy update"; exit 0; }
    AFTER_POLICY=$(read_policy); AFTER=$(jq -c '.include // []' <<<"$AFTER_POLICY")
    kept_all "$INC" "$AFTER" || { fail_json verify_failed "after the write an existing entry was missing — check the policy now"; exit 0; }
    same_settings "$POLICY" "$AFTER_POLICY" || { fail_json verify_failed "after the write a policy setting changed — check the policy now"; exit 0; }
    jq -nc --arg e "$EMAIL" '{ok:true, code:"added", email:$e}'
    exit 0
  fi
  # access-remove
  PROTECTED=$( { stack_env OK_CF_ACCESS_PROTECTED_EMAILS | tr ',' '\n'; jq -r '.protected[]? // empty' <<<"$REQ"; } | tr 'A-Z' 'a-z' | sed 's/[[:space:]]//g' | grep '@' || true)
  PROTECTED_SHA=$( { printf '%s\n' "$SEED_PROTECTED_SHA256"; jq -r '.protected_sha256[]? // empty' <<<"$REQ"; } | tr 'A-F' 'a-f' | grep -E '^[0-9a-f]{64}$' || true)
  EMAIL_SHA=$(printf '%s' "$EMAIL" | sha256sum | cut -d' ' -f1)
  if grep -qxF "$EMAIL" <<<"$PROTECTED" || grep -qxF "$EMAIL_SHA" <<<"$PROTECTED_SHA"; then
    fail_json protected "that address is protected and is never removed from Access"; exit 0
  fi
  NEW=$(jq -c --arg e "$EMAIL" '[.[] | select((.email.email? // "" | ascii_downcase) != $e)]' <<<"$INC")
  [ "$(jq length <<<"$NEW")" -lt "$(jq length <<<"$INC")" ] || { jq -nc --arg e "$EMAIL" '{ok:true, code:"not_present", email:$e}'; exit 0; }
  [ "$(jq length <<<"$NEW")" -gt 0 ] || { fail_json would_empty_policy "removing it would leave nobody allowed in"; exit 0; }
  # The ONLY address a remove may drop is the one it names.
  DROPPED=$(jq -r -n --argjson a "$INC" --argjson b "$NEW" '[$a[] | .email.email? // empty | ascii_downcase] - [$b[] | .email.email? // empty | ascii_downcase] | unique | .[]')
  [ "$DROPPED" = "$EMAIL" ] || { fail_json guard "refused: the change would drop more than the one address"; exit 0; }
  put_include "$NEW" || { fail_json cloudflare_error "Cloudflare refused the policy update"; exit 0; }
  AFTER_POLICY=$(read_policy); AFTER=$(jq -c '.include // []' <<<"$AFTER_POLICY")
  kept_all "$INC" "$AFTER" "$EMAIL" || { fail_json verify_failed "after the write another entry was missing — check the policy now"; exit 0; }
  same_settings "$POLICY" "$AFTER_POLICY" || { fail_json verify_failed "after the write a policy setting changed — check the policy now"; exit 0; }
  jq -nc --arg e "$EMAIL" '{ok:true, code:"removed", email:$e}'
  exit 0
  ;;

dns-list|dns-upsert|dns-delete)
  NAME=$(arg name); NAME=${NAME,,}; NAME=${NAME%.}
  rec_view='{id, type, name, content, proxied, ttl, priority}'
  if [ "$ACTION" = dns-list ]; then
    Q="per_page=100"; [ -n "$NAME" ] && Q="$Q&name=$NAME"
    R=$(cf GET "/zones/$ZONE_ID/dns_records?$Q")
    cf_ok "$R" || { fail_json cloudflare_error "could not list DNS records"; exit 0; }
    jq -c --arg z "$ZONE" "{ok:true, code:\"listed\", zone:\$z, records:[.result[] | $rec_view]}" <<<"$R"
    exit 0
  fi
  TYPE=$(arg type); TYPE=${TYPE^^}
  CONTENT=$(arg content)
  case "$TYPE" in A|AAAA|CNAME|TXT|MX) ;; *) fail_json bad_type "only A, AAAA, CNAME, TXT and MX records may be changed"; exit 0 ;; esac
  [[ "$NAME" == "$ZONE" || "$NAME" == *".$ZONE" ]] || { fail_json outside_zone "the name must be inside $ZONE"; exit 0; }
  [ -n "$DOMAIN" ] && [ "$NAME" = "$DOMAIN" ] && { fail_json own_record "this install's own record ($DOMAIN) is managed by install/cloudflare.sh only"; exit 0; }
  ENC_NAME=$(jq -rn --arg v "$NAME" '$v|@uri')
  R=$(cf GET "/zones/$ZONE_ID/dns_records?type=$TYPE&name=$ENC_NAME&per_page=100")
  cf_ok "$R" || { fail_json cloudflare_error "could not read DNS records"; exit 0; }
  if [ "$ACTION" = dns-delete ]; then
    if [ -n "$CONTENT" ]; then M=$(jq -c --arg c "$CONTENT" '[.result[] | select(.content == $c)]' <<<"$R"); else M=$(jq -c '.result' <<<"$R"); fi
    N=$(jq length <<<"$M")
    [ "$N" -eq 1 ] || { fail_json "$([ "$N" -eq 0 ] && echo not_found || echo ambiguous)" "a delete must match exactly one record (matched $N); give the content to pick one"; exit 0; }
    RID=$(jq -r '.[0].id' <<<"$M")
    D=$(cf DELETE "/zones/$ZONE_ID/dns_records/$RID")
    cf_ok "$D" || { fail_json cloudflare_error "Cloudflare refused the delete"; exit 0; }
    jq -c "{ok:true, code:\"deleted\", record:(.[0] | $rec_view)}" <<<"$M"
    exit 0
  fi
  # dns-upsert
  [ -n "$CONTENT" ] || { fail_json bad_content "content is required"; exit 0; }
  PROXIED=$(arg proxied); TTL=$(arg ttl); PRIO=$(arg priority)
  BODY=$(jq -nc --arg t "$TYPE" --arg n "$NAME" --arg c "$CONTENT" --arg p "${PROXIED:-false}" --arg ttl "${TTL:-1}" --arg pr "${PRIO:-10}" '
    {type:$t, name:$n, content:$c, ttl:($ttl|tonumber)}
    + (if ($t == "A" or $t == "AAAA" or $t == "CNAME") then {proxied:($p == "true")} else {} end)
    + (if $t == "MX" then {priority:($pr|tonumber)} else {} end)')
  if [ "$TYPE" = TXT ] || [ "$TYPE" = MX ]; then
    # Several TXT / MX records may share a name: add unless the same content exists.
    if jq -e --arg c "$CONTENT" 'any(.result[]; .content == $c)' >/dev/null <<<"$R"; then
      jq -c --arg c "$CONTENT" "{ok:true, code:\"unchanged\", record:([.result[] | select(.content == \$c)][0] | $rec_view)}" <<<"$R"; exit 0
    fi
    W=$(cf POST "/zones/$ZONE_ID/dns_records" "$BODY"); CODE=created
  else
    N=$(jq '.result | length' <<<"$R")
    if [ "$N" -gt 1 ]; then fail_json ambiguous "$N $TYPE records share that name; change one by deleting the others first"; exit 0; fi
    if [ "$N" -eq 1 ]; then
      W=$(cf PUT "/zones/$ZONE_ID/dns_records/$(jq -r '.result[0].id' <<<"$R")" "$BODY"); CODE=updated
    else
      W=$(cf POST "/zones/$ZONE_ID/dns_records" "$BODY"); CODE=created
    fi
  fi
  cf_ok "$W" || { fail_json cloudflare_error "Cloudflare refused the record ($(jq -r '[.errors[]?.message] | join("; ")' <<<"$W" 2>/dev/null | head -c 300))"; exit 0; }
  jq -c --arg code "$CODE" "{ok:true, code:\$code, record:(.result | $rec_view)}" <<<"$W"
  exit 0
  ;;
*)
  fail_json bad_action "unknown action"
  exit 2
  ;;
esac
