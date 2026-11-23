# Per-bot secret allowlists and connector scoping (obj 901330)

Status: shipped as a PR only. **No live setting is changed by this PR.** Every step
under "Rollout" that writes `secret_env_allowlist`, `secrets_session_env_mode`,
`connector_access` or `connector_access_default_deny` waits for Operator's approval.

## Problem

Live OVH has an empty `secret_env_allowlist` and no `secrets_session_env_mode` row,
so it runs in **migration** mode: a card session gets every key the store resolves
(384 global keys), including Stripe, Railway and Twilio. With no `connector_access`
rows for Operator, his Google connection and his GitHub PAT (last 4 `KnMP`) reach any
agent's card session. A new Example bot starting a card inherits all of it.

## What the code does

`app/server/src/services/bot-session-scope.ts` names eight **scoped bots** and their
packs (`EXAMPLE_BOT_PACKS`). A card session for a scoped bot is filtered to its pack
**whatever the global mode is**:

| Bot | Keys (names only) | Connectors |
|---|---|---|
| `example-cfo` | `STRIPE_READONLY_BACKFILL_KEY`. Denied: `STRIPE_SECRET_KEY`, `STRIPE_RESTRICTED_KEY`, `STRIPE_WEBHOOK_SECRET`, `MERCURY_*`, `RAMP_*` | Google (read + drafts) |
| `example-general-counsel` | `DOCUSEAL_API_KEY`, `DOCUSEAL_API_URL` | Google (drafts only) |
| `example-seo` | `POSTHOG_EXAMPLE_584614_PROJECT_KEY` (not saved yet), `POSTHOG_HOST`. Denied: `POSTHOG_OK_TOKEN`, `POSTHOG_PERSONAL_KEY` | none |
| `example-paid-ads` | as SEO + `META_SYSTEM_USER_TOKEN` (not saved yet) | none |
| `example-client-success` | `TWENTY_API_URL`, `TWENTY_BD_API_KEY`, `GRANOLA_API_KEY` | Google (drafts only) |
| `example-business-development` | `TWENTY_API_URL`, `TWENTY_BD_API_KEY`, `GRANOLA_API_KEY` | Google (drafts only) |
| `example-cto` | `RAILWAY_*`, `TWENTY_API_URL`, `TWENTY_API_KEY_EXAMPLE` | GitHub (the existing connection; never replaced or widened) |
| `example-gtm-engineer` | `EMAILBISON_API_KEY`(+`_BASE_URL`), `SENDIVO_API_KEY`, `TELNYX_API_KEY`, `APIFY_API_TOKEN`, `GETLEADS_API_KEY`, `MILLIONVERIFIER_API_KEY`(+`_BASE_URL`), `BOUNCEBAN_API_KEY`(+`_BASE_URL`), `TWENTY_API_URL`, `TWENTY_API_KEY_EXAMPLE`. Denied: `INSTANTLY_*` | none |

`*_BASE_URL` / `*_API_URL` companions are endpoints, not credentials; they are on
the pack so the worker knows where the key points.

Rules:

- **Keys.** Store keys are injected only if on the pack (exact name or `PREFIX_*`
  family), or named by an explicit `secret_env_allowlist` row for that bot (or the
  `*` baseline). A pack's deny list beats every allowlist row. A key the pack names
  but the store does not hold is simply absent; nothing fills the gap with another
  bot's key.
- **Connectors.** A connector reaches a scoped bot only if it is on the pack AND the
  owner's Settings → Connectors → *Who can use it* rule (`connector_access.agents`)
  names the bot. **No row is not a grant** for a scoped bot (fails closed).
- **Google drafts.** The session gets `CC_GOOGLE_USE=drafts_only|read_and_drafts`.
  This is a policy marker, not an OAuth scope: narrowing the real scope would mean
  replacing Operator's credential, which this card forbids. Send / Add to calendar stays
  a person's click.
- **MCP servers** from Settings → Integrations reach a scoped bot only when the pack
  lists their slug (none today).
- **Secrets broker.** A scoped bot's `CC_SESSION_TOKEN` sees only its pack through
  `/api/secrets-broker`, so a withheld key is not one HTTP call away.
- **Which bot.** `agent_context` and `cardOwnerBot()`. A bot filing a card under the
  `general` persona is still scoped. Two scoped bots on one card → intersection.
- **Kill switch.** `settings.bot_session_scope_enabled='0'` (or env
  `CC_BOT_SESSION_SCOPE=0`) turns per-bot scoping off.

## What changes on deploy (needs Operator's go-ahead to deploy)

- The eight bots' card sessions stop seeing keys outside their pack. No other
  agent's session changes.
- Until Operator adds a *Who can use it* grant, **`example-cto` has no GitHub** and the four
  Google bots have no Google in card sessions. That is the requested fail-closed
  behaviour; step 1 below restores it per bot.

## Rollout (each step is a live change: Operator approves first)

1. **Connector grants.** In Settings → Connectors, for Operator's connections:
   - GitHub → Who can use it: keep every agent that uses it today (at least
     `general`, which opens PRs) and add `example-cto`. Nothing about the PAT changes.
   - Google Workspace → add `example-cfo`, `example-general-counsel`,
     `example-client-success`, `example-business-development` (+ the agents that use it today).
   Writing a list makes it an allow-list for **every** agent, so list today's users
   first. `GET /api/secrets/env-policy` + the migration usage log
   (`secret_env_usage`) and `connector_access_log` show who used what.
2. **Missing keys.** Operator saves `POSTHOG_EXAMPLE_584614_PROJECT_KEY` and
   `META_SYSTEM_USER_TOKEN` when he has them. They appear in SEO / paid-ads sessions on
   the next spawn with no code change.
3. **Allowlists for everyone else.** Read the migration report
   (`tsx server/src/scripts/secrets-env-allowlist.ts report --since 30`) and add rows
   per agent for what they actually referenced. Keep the `*` baseline tiny.
4. **Dry-run enforce.** For a week, read `report` again: any key a session referenced
   that is not allowlisted is a missing row. Fix those.
5. **Flip enforce.** `secrets-env-allowlist.ts mode enforce` (audited). From then on an
   empty allowlist means **no** store keys, not all 384; the rest stay usable through
   the broker. Roll back with `mode migration`.
6. **Connector default deny.** `settings.connector_access_default_deny='1'` (or env
   `CC_CONNECTOR_ACCESS_DEFAULT_DENY=1`): a connection with no rule is no longer
   available to every agent; the rule must name the agent. Only after step 1 covers
   every agent that legitimately uses a connection. Default OFF in this PR.

Fail-closed behaviour covered by `bot-session-scope.test.ts`: enforce + empty
allowlist → zero store keys; enforce + unreadable allowlist → zero store keys for an
unscoped agent and only the code pack for a scoped bot; scoped bot with no connector
grant → no GitHub/Google.

## Open points for Operator

- **Twenty key for CTO and GTM.** The card says "Twenty" without a key name; the pack
  uses `TWENTY_API_KEY_EXAMPLE`. BD/CS use `TWENTY_BD_API_KEY` as the card names. Change
  if a different key is meant.
- **`STRIPE_RESTRICTED_KEY`** is denied for the CFO (only the read-only backfill key is
  allowed). If that restricted key is itself read-only and wanted, it is a one-line
  pack change.
- **PostHog key name.** `POSTHOG_EXAMPLE_584614_PROJECT_KEY` is the name the pack expects;
  save the key under that name.
