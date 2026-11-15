# Quality audit: bots, knowledge base, codebase (2026-11-15)

Result record for card #900940 (step 1 of the quality pass, standing objective #900936). The audit was read-only: this PR adds this file and nothing else. No product code changed, nothing was merged or deployed.

## What was delivered

1. **The audit file**, in the knowledge base of the workspace that owns this product: `decisions/2026-11-15-opkit-quality-audit.md`. It holds a summary, 21 ranked findings (each with area, impact, file and line evidence, proposed fix and size), the status of the earlier audits, the answer on cards closed without a passing review, one target structure for the knowledge base with a seven-step migration plan, the child cards in working order, and what could not be checked.
2. **Twenty child cards** under #900936, all in queue, none started, in priority order:

| Order | Card | Change |
|---:|---|---|
| 1 | #900951 | Bot knowledge tools list only folders that exist, and report search failures |
| 2 | #900952 | Agent-key card closes are recorded as the bot and need a passing review or a stated reason |
| 3 | #900953 | `{workspace}` token in a bot file's `knowledge_folders`; fix the built-in setup bot file |
| 4 | #900954 | A broken install bot file must not silently fall back to the built-in bot |
| 5 | #900955 | Sandboxed cards can write their artifact, notes and live files through a session-token route |
| 6 | #900956 | One rule for which bot owns a card, used by the supervisor and bot approval |
| 7 | #900957 | Internal card create accepts `owner_bot`; High Agency wake cards carry it |
| 8 | #900958 | Chat `create_objective` accepts `parent_id` |
| 9 | #900959 | Runner failures are not a review verdict; show when a card was closed over a non-pass review |
| 10 | #900960 | Chat `create_objective`: one code path with duplicate guard and idempotency |
| 11 | #900961 | High Agency save keeps the owner and the paused state unless the admin changes them |
| 12 | #900962 | Knowledge base search applies the caller scope before taking the top results |
| 13 | #900963 | Workspace search honours a workspace's custom vault folder |
| 14 | #900964 | One way to find the knowledge base root |
| 15 | #900965 | One re-index hook on every knowledge base write path, with a guard test |
| 16 | #900966 | One shared list of bot tools for the server, the client and the docs |
| 17 | #900967 | Vault layout registry: decision-capture paths come from one module |
| 18 | #900968 | Vault move tool (dry run by default): moves files, rewrites links, adds front matter |
| 19 | #900969 | Remove dead server modules and untangle the three "approval" file names |
| 20 | #900970 | Architecture overview and a fuller CONTRIBUTING guide |

A second batch of 18 follow-ups is listed in the audit file. It was not filed because a parent card may have at most 20 open children.

## Top findings, in one line each

1. The built-in setup bot declares knowledge folders at the knowledge base root, where no install has them, so it sees an empty knowledge base (`app/server/src/services/agent-chat/builtin/operation-kit-dev/agent.md:9-14`, `app/server/src/services/agent-chat/tools.ts:1052-1056`).
2. A card can be marked done, and its PR merged, without a passing review, and an agent key's close is recorded as a human's (`app/server/src/routes/objectives-status.ts:112`, `:519-520`; the pass rule exists only at `app/server/src/services/bot-approval.ts:163`).
3. Three different rules decide which bot owns a card (`owner_bot` versus `agent_context`), so a High Agency bot and its supervisor miss cards the bot filed from chat (`app/server/src/services/high-agency-supervisor.ts:279`, `app/server/src/services/agent-chat/tools.ts:515-526`).
4. A card filed from chat cannot have a parent (`app/server/src/services/agent-chat/tools.ts:133-138`).
5. Sandboxed card sessions are told to write their artifact to a folder that is not mounted (`app/server/src/services/prompt-builder.ts:665`, `app/server/src/services/kb-access-prompt.ts:49`).
6. Scoped knowledge base search filters after taking the top results (`app/server/src/services/kb-semantic/search.ts:75-104`).

## Evidence for "done looks like"

| Requirement | Evidence |
|---|---|
| Audit file exists with ranked findings, file-path evidence and fixes | Written through the docs API; the write returned `ok: true`, size 40,002 bytes; read back with 21 findings and the card table |
| Child cards exist under #900936, each sized for a 30-minute review | `GET /api/internal/objectives?parent_id=900936` returned 20 cards, #900951 to #900970, all `queue`, `create_pr = 1` |
| Owned by the setup bot | **Not met by field.** `owner_bot` is empty on all 20: the only create route a card session can reach rejects `owner_bot`, and the routes that set it need a browser login or an agent key. Each card names the owner in its text. Card #900957 fixes the route |
| No product code changed, nothing deployed or merged | This PR is one markdown file |

## Not checked

Live chat behaviour of the setup bot, who closed the three cards (audit trail needs a login), anything on the live host, typecheck and test runs (no code changed and the sandbox has no installed dependencies), and the bot settings panels in a browser.
