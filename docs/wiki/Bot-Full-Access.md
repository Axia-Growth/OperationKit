# Bot Full access (per workspace)

Full access is a switch an admin flips for **one bot in one workspace**
(**Bots → a bot → Settings → Full access**). It sits on top of the bot's
[workspace access list](./Bot-Workspace-Access.md): the workspace has to be
granted to the bot first, and revoking the workspace ends Full access there.

It is off for every bot until an admin switches it on. It can carry an optional
expiry (24 hours, 7, 30 or 90 days in the panel; up to 365 days through the
API). With no expiry it stays on until someone switches it off.

## What it adds

In the workspace where it is on, and nowhere else, the bot may:

| Ability | How the bot does it |
|---|---|
| See where it has Full access, the expiry and whether Billing is on | `full_access_status` |
| Read any card in full, whoever owns it | `card_read` |
| Take a card over (become its worker and owner) | `card_take_over` |
| Hand a card to another owner | `card_reown` (an agent or bot that may work there, and/or a person in the workspace) |
| Comment on any card | `card_comment` (the worker is woken to read it) |
| Restart any card | `card_restart` |
| Ask for an AI review of its OWN card (obj 901457) | `card_request_review`: only a card the bot owns (`cardOwnerBot`), in review with a PR and no verdict, inside the review bounce cap (`AI_REVIEW_ITERATION_CAP`, 2 rounds). Same service as `POST /api/internal/ai-review/request` (`requestAiReview`); the work is not re-run |
| Read and write the whole workspace knowledge base | the ordinary `search`, `list_folders`, `read_file`, `write_doc`, now over the workspace's whole folder, not just the bot's `knowledge_folders` |
| Read and edit workflows | `workflow_list`, `workflow_read`, `workflow_save_draft` (a draft; publishing stays the owner's click) |
| Read and edit scheduled tasks | `routine_list`, `routine_read`, `routine_update` (schedule, on/off, an AI task's title and brief) |
| Read bot settings and run history | `bot_list`, `bot_read`, `bot_run_history` (bots that may work in that workspace) |
| Get a repo checkout from chat | `repo_session_start` files a card on one of the workspace's projects, owned by the bot, and starts it; the card session runs in its own git worktree |
| File and own cards past the workspace agent pool | `create_objective`; the bot's slug passes the pool through the one helper from obj 900948 (`botGrantedWorkspace` inside `checkAgentInWorkspacePool`). There is no second bypass. |

### In a card session (a High Agency wake)

A card worked by the bot (a High Agency wake, or a card it filed) is a session on
the internal API, not a chat. With its own session token it can:

| Call | What it does |
|---|---|
| `GET /api/internal/full-access` | Says whether this card carries Full access, the expiry, and whether billing is switched on. |
| `POST /api/internal/objectives/:id/message` | Message a card it has no parent, child or sibling link to, in the same workspace (otherwise a `403`). |
| `POST /api/internal/full-access/cards/:id/take-over` | Become the worker and owner of a card in the same workspace. |

The card carries Full access only when its `agent_context` is the bot's slug, the
bot has Full access in the card's workspace, the card runs for an admin (its
assignee), **and** the card provably came from an admin or the bot's own
schedule. One of:

- it is the bot's own High Agency wake (`routine_id` points at the routine named
  `high-agency:<slug>`; only the scheduler sets that column);
- the bot filed it from an admin's chat (an `agent_chat_cards` row for this bot
  whose person is an admin);
- an admin created it directly (`created_by` is an admin and the card has no
  parent; a child inherits `created_by` from a parent its caller names, so an
  inherited value is not proof).

Being assigned to an admin is not enough: a card a member creates and assigns to
an admin carries no Full access (`cardSessionFullAccess`). The sender is always taken from the session token, never from the
request body. The wake brief tells the bot to check once and what it never covers.

### When it applies

All of these, checked again on every call:

1. Full access is on for that bot in that workspace, and has not expired.
2. The workspace is still on the bot's granted list.
3. The bot is working **for an admin**: the person chatting with it, or the
   person a bot-to-bot message or a wake runs for. A bot acts for the person in
   front of it; Full access does not let a member reach, through the bot, cards
   and settings they cannot reach themselves. For a member the bot behaves
   exactly as it does without Full access.
4. In a bot-to-bot wake, only the conversation's workspace counts.

### What it never edits

- A scheduled task's **script command** (that is a command on the host), its
  kind, workspace or agent.
- A **High Agency wake schedule** (a bot must not schedule itself).
- A published workflow: the bot saves drafts, a person publishes.
- Anything in a workspace it is not granted, or a project (repo) the workspace
  has never worked in.

## The hard exclusions

Four kinds of action are **not** part of Full access. Three are permanent and
one is a switch:

| Kind | Covers | Can it be switched on? |
|---|---|---|
| Secret values | Using secrets through the secrets broker (`secrets_list`, `secret_http`), Shared secrets included, and connectors to secret stores. | **Never.** No switch. |
| Minting or revoking keys | Calls that create, rotate or revoke keys and tokens at a provider. | **Never.** No switch. |
| DNS and Cloudflare Access | DNS providers and Cloudflare (the whole Cloudflare API), by host, path, secret name or connector. | **Never.** No switch. |
| Billing | Billing, payment and subscription systems, by host, path, secret name or connector. | Yes: one switch, **off by default**, back to off whenever Full access goes off. |

For a bot that has Full access in a workspace, these are walls on its two doors
to the outside in that workspace — the secrets broker and the workspace's MCP
connectors — whoever is chatting with it and whatever tools its own file lists.
The call is refused **before anything is sent** and the refusal is written to
the audit log (`exclusion_refused`).

What this means in practice:

- Full access **never adds the `secrets` tool**. In a workspace where the bot
  has Full access, every `secrets_list` / `secret_http` call is refused, even
  when the bot's own file lists `secrets`. Because every broker call uses a
  secret, the Billing switch only opens billing **connectors** (MCP).
- A bot that has Full access in **any** workspace never reaches a **Shared**
  (install-wide) secret, in any chat: Shared names are left out of
  `secrets_list` and a `secret_http` call that names one is refused and logged.
- The settings API rejects `allow.secret_values`, `allow.keys` and
  `allow.dns_access` with `400 exclusion_permanent`. The table has no column
  for them.

What a call is aimed at is decided in one place,
`services/agent-chat/full-access-exclusions.ts` (`classifyOutbound`). It errs
toward refusing. A bot without Full access in that workspace is not touched.

The gate (`exclusionGate`) is called from exactly those two doors today: the
secrets tools in `services/agent-chat/tools.ts` and MCP calls in
`services/agent-chat/mcp-tools.ts`. Other chat tools that reach outside (for
example `email` / `calendar` drafts, or the Operation Kit Dev operator tools,
which have their own rules) do not go through it. A new outward door that
should honour these walls must call `exclusionGate` itself; nothing applies it
automatically.

Not covered by these walls, by design: a card session's own environment.
Cards the bot files run like any other card, under the normal card-session
secret rules (the D4 allowlist). Key minting inside Operation Kit itself (agent
keys in Settings) has no bot path at all: it stays a signed-in person's action.

## Protected pull requests

`FULL_ACCESS_PROTECTED_PRS` (`app/shared/full-access.ts`) lists pull requests no
Full access ability may touch. It contains **645**. A card whose `pr_number` is
on the list, or whose PR link ends in that number, is refused by
`protectedCardRefusal` with a `protected_refused` audit row in these places
(and only these):

- every Full access chat tool that takes a card (`card_read`, `card_take_over`,
  `card_reown`, `card_comment`, `card_restart`, `card_request_review`), and `get_objective` for a bot
  with Full access in the card's workspace;
- the `card_sandbox` tools (`card-sandbox-tools.ts`), which also log it to their
  own sandbox audit;
- `repo_session_start`, when the title or brief names the pull request
  (`PR 645`, `#645`, `pull/645`);
- `POST /api/internal/full-access/cards/:id/take-over` (`403`, `code:
  "protected_pr"`);
- the Full access branch of `POST /api/internal/objectives/:id/message` (`403`,
  same code). The ordinary one-hop relations (parent, child, sibling) are not
  changed by this.

`repo_session_start` checks the title and brief text (`protectedPrInText`)
rather than a card. This is not a check on every card path: `list_objectives`,
`board_briefing`, `create_objective`, `get_objective` for a bot without Full
access in that workspace, and one-hop `/message` do not consult the list.
Separately, the card-wake own-card tools refuse a protected card
(`isProtectedCard`, `card-wake-tools.ts`), and merging or closing (grant merge,
`dev_merge_pr`, `dev_close_card`) refuses the grant-merge reserved list
(`GRANT_MERGE_RESERVED_SEED` in `services/grant-merge.ts`: PR 645 in both
`operationkit` and `operationkit`, plus the `grant_merge_reserved_prs`
setting / `CC_GRANT_MERGE_RESERVED_PRS` env).

Adding a pull request to the list is a code change.

## Merge and deploy

Full access never approves a merge, a prod migration or a deploy. Those are
decided only by `services/delegated-approvals.ts` and `services/bot-close-eligibility.ts`,
which read `delegation_grants` ("Approve on my behalf") and nothing else. A
comment a bot posts with Full access reaches the card as an unverified relay
and says in its first line that it is not an approval.

**Standing merge (obj 901388).** A merge grant can carry one more switch,
**Merge without asking me each time** (`delegation_grants.standing_merge`, off by
default, set only when the grant is issued, merge grants only). With it on, the
server merges the bot's OWN cards that reach review with AI review `pass` and a PR
(`services/standing-merge.ts`), through the same `runGrantApprovedMerge` →
`mergeUnderGrant` path and guards as a chat merge, and posts one line in the bot's
chat ("merged, not live until you deploy"). Full access plays no part in it: the
switch lives on the grant, and Full access neither turns it on nor stands in for it.
Deploys, production migrations, secrets, keys, DNS and Cloudflare Access, billing and
protected PRs stay out of reach either way.

## Who can change it

Only an **admin signed in to the browser** (the httpOnly cookie). An agent API
key, a legacy key, a Bearer JWT and a card session token are refused, so a bot
can never give itself Full access or switch billing on. No API key scope was
widened.

```
GET /api/agent-chat/agents/:slug/full-access              per granted workspace + the audit log
PUT /api/agent-chat/agents/:slug/full-access/:workspace   { enabled?, expires_at?, allow?: { billing? } }
```

`GET /api/agent-chat/agents` carries `full_access.workspaces` per bot (where it
is on right now, and the expiry) for the badge. A member sees only workspaces
they belong to.

## The audit log

`agent_chat_bot_full_access_audit`, append-only. One row per:

- settings change: `enabled`, `disabled`, `expiry_changed`, `exclusion_changed`
  (who, when, bot, workspace, on or off, expiry, which exclusion);
- `expired` (written once, the first time a check finds the expiry passed) and
  `workspace_revoked`;
- `ability_used` (each change a bot makes with Full access), `ability_refused`,
  `exclusion_refused` and `protected_refused`.

Settings changes also appear in the activity feed
(`metadata.kind = 'bot_full_access_changed'`), and uses as
`bot_full_access_used`. The panel shows the newest 50 rows under "Change log".

## In the app

- A **Full access** badge on the bot's row in the Bots sidebar (a small shield
  on a pinned tile) and on the bot page header, where it names the workspace
  and the expiry.
- The settings section: one card per granted workspace with the switch, the
  expiry picker, a "Never included" list (secret values, keys, DNS and
  Cloudflare Access, protected pull requests: always blocked, no switch) and
  the Billing switch.

## Code

| Piece | File |
|---|---|
| Switch, expiry, exclusions, audit | `app/server/src/services/agent-chat/bot-full-access.ts` |
| Exclusion classifier and gate | `app/server/src/services/agent-chat/full-access-exclusions.ts` |
| The bot's tools | `app/server/src/services/agent-chat/full-access-tools.ts` |
| Routes | `app/server/src/routes/agent-chat-full-access.ts` (settings), `internal-full-access.ts` (card sessions) |
| Tables | `app/server/src/db/schema/agent-chat.ts` |
| Shared types | `app/shared/full-access.ts` |
| UI | `app/client/src/components/agent-chat/FullAccessSection.tsx`, `FullAccessBadge.tsx` |
| Tests | `bot-full-access.test.ts`, `agent-chat-full-access.test.ts` (server); `FullAccessSection.test.tsx`, `BotSidebar.test.tsx` (client) |
| Screenshots | `tests/smoke/bot-full-access/` |
