# Open-loop tracking (Operation Kit Dev)

obj 901382. Code: `app/server/src/services/agent-chat/open-loops.ts` (+ `open-loops-hook.ts`), tests `open-loops.test.ts`. The operator copy of this page is the knowledge-base runbook `workspaces/operationkit/runbooks/open-loop-tracking.md`.

## What it is

Operation Kit Dev keeps one list of everything still open from its chats with the owner:

`workspaces/operationkit/bots/operation-kit-dev/open-loops.md`

That file is the single source of truth. Do not move or rename it. The server now keeps Dev in step with it in three places.

## How it works

1. **Every chat.** At the start of every chat turn the server reads the file and puts it, with the rules for keeping it, into Dev's instructions. Dev knows the open loops without being asked, in both workspaces (operationkit and your-org). It is read fresh each turn, so an edit shows up on the next message.
2. **During a chat.** The same instructions tell Dev to update the file in the same turn when a loop opens (a card filed, a decision raised, a promise such as "I'll report back", something waiting on the owner), moves or closes.
3. **Every High Agency wake.** The wake brief has an "Open loops" step. For each loop with a card number the wake checks the card. Done or cancelled: the loop moves to "Closed". No movement for more than 3 days: the loop is marked `STALE since <date>`. A card Dev owns that is missing from the list is added. If anything changed, the wake writes one line in `workspaces/operationkit/bots/operation-kit-dev/journal.md`.
4. **Digest.** When a wake ends and at least one loop waits on the owner, the server posts the top 5 lines of the "Waiting on" section into Dev's chat thread with the owner. It posts once per list per day: again only when the list changed or a new day began. No email.

## The loop format

One numbered line per loop:

`N. **<title>** (#<card number> if there is one, opened YYYY-MM-DD). <status: where it stands>. Waiting on: <who>. Next: <next step>.`

Sections are by who the loop waits on. `## Waiting on <owner>` is always the first section, most important first (the digest reads the first "Waiting on" section). Closed loops move to `## Closed` with the date.

## Limits

- The wake can only read cards Dev owns in its wake workspace. A loop whose card is in another workspace, or is not Dev's, is left as it is on a wake.
- The wake brief is a copy saved with the High Agency setting. It is refreshed when the server starts and when the setting is saved on Dev's settings panel.
- A person who cannot see the operationkit workspace never gets the list in their chat with Dev.
- The chat instructions carry the first 12,000 characters of the list. A longer list is cut on a whole line, and the cut says how long the file is and the exact `read_file` call (path and `offset`) that returns the rest. The bot must read every page before it writes the file back. Keep "Closed" short anyway: every extra page is one more tool call per turn.
- `read_file` returns up to 20,000 characters per call. A longer file comes back with `"truncated": true`, `next_offset` and `total_chars`; calling again with `offset` set to `next_offset` returns the next page, until `next_offset` is null (obj 901494). Before that change the rest of a long file could not be read in chat at all.

## Switch it off

Set the setting `open_loops_bots` to `0`. No restart is needed for the chat and the digest. The wake brief drops the step at the next server start or when High Agency is saved on Dev's panel.

On the server (whoever runs it):

```bash
docker exec command-center sqlite3 /app/data/command-center.db \
  "INSERT INTO settings (key, value) VALUES ('open_loops_bots', '0') ON CONFLICT(key) DO UPDATE SET value = '0'"
```

Switch it back on by deleting that row (the default is Operation Kit Dev only):

```bash
docker exec command-center sqlite3 /app/data/command-center.db "DELETE FROM settings WHERE key = 'open_loops_bots'"
```

There is no button for this in Settings yet.

## Other bots

The setting takes a comma-separated list of bot slugs (for example `operation-kit-dev,gtm-engineer`). A bot on the list needs its own file at `workspaces/<workspace>/bots/<slug>/open-loops.md`, that folder in its knowledge folders, and the `write_doc` tool. Only Operation Kit Dev is on by default.

## If something looks wrong

- Dev does not know the loops in a new chat: check the file exists at the path above, the setting is not `0`, and the fix is deployed (the pull request for #901382 merged and the server restarted after it).
- No digest after a wake: nothing waits on the owner, or the same list was already posted today. The server log line is `[open-loops] posted the waiting-on-owner digest`.
- The wake did not reconcile: open the wake card and check its brief has the "Open loops" section. If not, save High Agency on Dev's panel once, or restart the server.
