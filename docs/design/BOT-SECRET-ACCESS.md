# Secret access for a chat bot on one screen (obj 901484)

Status: PR only. Not merged, not deployed. No live setting, secret, Bot access
entry or bot tool is changed by this PR.

**Database change (additive, needs Operator's approval before production):** three new
tables, created with `CREATE TABLE IF NOT EXISTS` at boot. No existing table or row
is altered.

| Table | One row means |
|---|---|
| `agent_chat_bot_secret_grants` | one bot may send one named secret to the listed exact hosts with the listed methods, in one workspace |
| `agent_chat_bot_secret_all` | one bot has the "All secrets" switch on in one workspace, in `read` or `write` mode |
| `agent_chat_secret_hosts` | the host(s) an admin confirmed for one secret in one workspace (once per key, not per bot) |

None of them holds a secret value.

## The problem, counted

Giving ONE chat bot read access to FIVE keys saved at Workspace scope, before this PR:

| Step | Where | Clicks | Typed |
|---|---|---|---|
| Tick "Use secrets by name", press Save model and tools | bot settings page | 2 | |
| Per key: open Bot access, type the host, Save | Settings → Secrets | 2 × 5 = 10 | 5 hosts |
| Per key, to make it read only: untick POST, PUT, PATCH, DELETE (the dialog starts with every method ticked) | same dialog | 4 × 5 = 20 | |

So 12 clicks and 5 typed hosts on two pages if every method is left on (Operator counted
about 13), or 32 clicks for read only. A Shared secret adds a workspace tick per key.
And the result is per WORKSPACE: every other bot in that workspace that has the
secrets tool gets the same keys. Nothing confirms it worked.

## After

Everything is in a new **Secret access** section on the bot's settings page.

| Way | Clicks | Typed |
|---|---|---|
| Per key: tick 5 secrets, press Save secret access | 6 | a host only where there is no suggestion |
| All secrets: tick the switch, press Confirm hosts, press Save secret access | 3 | a host only where there is no suggestion |
| All secrets for a second bot later (hosts already confirmed) | 2 | none |

Read only (GET, HEAD) is the default in both ways. The save also switches on the
bot's "Use secrets by name" tool. **Test access** then lists, per secret, usable yes
or no and the reason.

## What Operator sees

1. Bots → a bot → settings → **Secret access**. If the bot is in more than one
   workspace there is a workspace picker.
2. **All secrets in this workspace** (a tick, off by default). When ticked: a choice
   of *Read only (GET, HEAD)* or *Read and write*, a short warning, and a list of
   keys that have no host yet, each with a host box already filled with a suggestion
   where there is one. **Confirm N hosts** takes them all in one go; **Save secret
   access** stores them.
3. Below it, the list of secrets with a tick per key, for a bot that should get only
   some keys, or to set one key differently from the switch. A ticked key shows its
   host box (suggestion filled in, labelled with where it came from) and a
   Read only / Read and write choice.
4. Each row says *Usable now* or *Not usable*. A row that is already open to every
   bot through an old Bot access entry says so.
5. **Test access** prints one line per secret: Yes/No and why.

## Rules

- **Admin only.** The list and the test need an admin. Saving needs an admin signed
  in to the browser: an API key, agent key, bearer token and card session token are
  refused (the same gate as a bot's model and tools). No chat tool, wake or card can
  reach the save.
- **Per bot.** A grant and the switch belong to one bot in one workspace. A second
  bot in the same workspace gains nothing, including from hosts confirmed for the
  workspace: those are read only for a bot whose own switch is on.
- **Values.** Never returned, stored in these tables, or logged. The panel carries
  names, hosts and methods.
- **Hosts.** Exact host names only: no wildcard, no IP address, no URL. A key with no
  host is not usable. The server never fills a host in: a save with a tick and no
  host is refused whole, and the All secrets switch does not apply a suggestion.
- **Suggested hosts**, in this order: a host already confirmed for the key in this
  workspace; a host in the key's existing Bot access entry; a host another bot was
  given for it; the host of a matching `*_BASE_URL` / `*_API_URL` / `*_URL` secret
  (host only, never the path, and nothing if the address carries a user name or
  password); a small built-in vendor map (`KNOWN_VENDOR_HOSTS`). A suggestion is text
  in a box until the admin saves it.
- **Read only is the default.** Write methods need an explicit choice, per key or as
  the switch's mode. A missing mode is read.
- **All secrets** covers every Workspace-scope secret of that workspace, read live, so
  a secret added later is covered with no click on the bot. It still needs its host
  confirmed once (per key, for every bot with the switch). Switching off ends the
  access on the next call.
- **Shared secrets are not covered by All secrets.** A Shared secret can be given to
  one bot with its own tick. The existing rule stays: a bot with Full access in any
  workspace never reaches a Shared secret.
- **Full access.** A bot with the existing Full access switch in a workspace can never
  use a secret there (obj 900972, permanent). The panel says so and the save is a 409.
  This is why the new switch is labelled "All secrets" and not "Full access to
  secrets": the two would read as one thing and do opposite things.
- **A per-key tick wins** over the switch for that one key (for example read only on
  one key while the switch is read and write).
- **Workspace access.** Grants and the switch count only while the bot may use the
  workspace; a revoke ends them without deleting rows. Deleting a bot deletes its rows.
- **Old Bot access entries keep working unchanged.** The per-bot grant is a second,
  independent way in; it is never read-modified-written into
  `secrets_broker_policy`, and it never narrows what an old entry allows.
- **Audit.** Every grant, change, removal, host confirmation, switch on, switch off and
  mode change is a `secret_access_log` row (action `bot_access`): who, bot, workspace,
  secret name, hosts, methods. The tool being switched on is a row too.

## Test access reasons

`ok`, `tool_off`, `no_host`, `workspace_not_ticked` (a Shared secret nobody gave this
bot or workspace), `bot_not_in_workspace`, `full_access_blocks_secrets`,
`shared_blocked_by_full_access`, `secret_missing`, `never_for_bots`, `value_too_short`.
It mirrors the order of checks in the chat secret tool and the broker, sends nothing
to any vendor, and reads one value only to compare its length.

## How it is wired

- `services/agent-chat/bot-secret-access.ts`: panel, save, test, suggestions.
- `services/secrets-broker.ts`: `Caller.botGrants`. A name is usable when the
  workspace-wide entry OR this bot's grant allows the host and method. A Shared
  secret seen only through a grant gets the grant's terms, never a host list written
  for another workspace. Absent `botGrants` = the old behaviour exactly (agent keys,
  card session tokens and flows are untouched).
- `services/agent-chat/tools.ts`: the chat secret tool passes the bot's grants.
- `routes/agent-chat.ts`: `GET|PUT /api/agent-chat/agents/:slug/secret-access`,
  `POST …/secret-access/test`.
- `client/.../agent-chat/SecretAccessSection.tsx`.

Scope: chat turns (and card wakes, which are chat turns). A card session's secrets are
env vars governed by the per-bot packs of obj 901330; this PR does not change them.

## How it fits with the related cards

- **#901384 (narrow Bot access by path and by bot).** This card could not read #901384
  (it is in another workspace) and nothing from it is on `main`. This PR builds the
  "by bot" half: the grant row is keyed by bot. The "by path" half fits as one more
  nullable column on `agent_chat_bot_secret_grants` and `agent_chat_secret_hosts`
  (allowed path prefixes per host), checked in `grantRefusal()` next to host and
  method. If #901384 lands its own per-bot table first, one of the two should be
  dropped before merge; they must not both exist.
- **#901386 (read-only view of bot settings and secrets for cards).** `secretAccessPanel()`
  and `testBotSecretAccess()` are pure reads of names, hosts and methods. That card can
  serve them to a card session without new logic. This PR does not open them to cards.
- **#901330 (per-bot packs for card sessions, merged).** Unchanged. Packs decide what a
  card session's env holds; this decides what a chat bot may send through the broker.

## Not built

- **A bot or card proposing a grant for one approve click.** It needs a new route a bot
  can write to and a review queue, which is its own design; left for a follow-up.
- **Path limits.** See #901384 above.

## Points for Operator to decide in review

1. The switch was asked for as "full access to secrets" in a relayed message, not a
   message typed by Operator on this card. It is built as described there, labelled
   "All secrets in this workspace". If he wants a different label, or wants it to
   cover Shared secrets, that is a small change.
2. All secrets still needs a host per key. A switch that sends any key to any host
   would let one bad instruction send every key to a stranger's server, so it is not
   offered.
