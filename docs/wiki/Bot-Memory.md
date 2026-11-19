# Bot memory: profile and journal

obj 901500. Code: `app/server/src/services/agent-chat/bot-memory.ts`, tests `bot-memory.test.ts`. It sits next to open-loop tracking (`docs/wiki/Open-Loop-Tracking.md`) and uses the same folder.

## What it is

A chat bot with memory switched on keeps three files in `workspaces/<workspace>/bots/<bot-slug>/`. Each has one job.

| File | Holds | How it is kept |
|---|---|---|
| `profile.md` | Lasting rules and decisions | One dated sentence per line. When a rule changes, the old line is replaced. |
| `journal.md` | Dated events: merges, deploys, decisions answered, loops closed | Newest first, one line each, with the card number and the sha. |
| `open-loops.md` | Only what is still open | A loop that closes is taken out and written as a journal line. |

The server loads the profile and the journal into the bot's instructions at the start of every chat turn, card wake and bot-to-bot wake, ahead of the open-loops list. The bot does not have to read them, and the owner does not have to repeat a rule.

## Line formats

- Profile: `- YYYY-MM-DD: <the rule or decision, in one sentence>.`
- Journal: `- YYYY-MM-DD HH:MM: <what happened> (#<card number>, PR <number>, <short sha> when there is one).`

## Size limits

| File | Limit | What happens |
|---|---|---|
| `profile.md` | 8,000 characters | The bot is told the size on every turn. From 80% it gets a warning to merge or delete lines. Past the limit only the first part is loaded, and the bot is told to shorten the file before adding anything. |
| `journal.md` | 8,000 characters or 50 entries | The server moves the oldest entries out until 30 entries and about 5,000 characters are left. |

The numbers are `PROFILE_MAX_CHARS`, `PROFILE_WARN_RATIO` and `JOURNAL_LIMITS` in `bot-memory.ts`.

## The journal archive

Older journal entries move to `journal-archive/YYYY-MM.md` in the same folder, one file per month, by the date written on the entry. They are ordinary knowledge-base files, so search and `read_file` still find them.

The server does the move, not the bot. It runs before each prompt load and when a High Agency wake card ends. The archive file is written first and never gets the same entry twice, so an entry cannot be lost if the server stops halfway.

The journal file itself is trimmed (instead of loading the last few entries of a file that grows for ever) because a chat bot can only replace a whole file. A bot that sees part of a file and saves it deletes the rest. What the bot is shown is always the whole of `journal.md`.

An entry is a top-level bullet or a heading that starts with a date. Lines before the first entry (the title) stay in `journal.md`.

## The rules the bot is given

- Write in the same turn as the decision or the ship.
- Replace a profile line when the rule changes. Do not keep both.
- Never write a password, key or token. Name the secret only.
- A note is what was true when it was written. Re-check the card or the pull request before saying something is merged, deployed, open or waiting.
- Do not trim the journal and do not edit an archive file.

The High Agency wake brief carries the same rules for a wake.

## Switching it on

`settings.bot_memory_bots` is a comma-separated list of chat slugs. No row means Operation Kit Dev only. `0`, `off` or an empty value switches it off for every bot. It is read at point of use, so no restart is needed. There is no database migration and no new route.

When a bot is switched on and has no files yet, its instructions say where to create them: the folder its open-loops list is in, else `workspaces/<chat workspace>/bots/<slug>/`.

## Safety

- Both files are read through the same gate as the bot's own `read_file` (knowledge folders plus the workspace wall). A person or bot that could not read the file gets no memory block.
- Both files reach the model inside an untrusted-content frame (boundary 14 in `docs/security/untrusted-content.md`). They are data, not instructions.
- The roll-over never writes through a symlink.

## Limits

- A journal that is over its limit and cannot be trimmed (one very long entry, or a long title block) is loaded cut and marked partial. The bot is told not to write it back.
- With memory on, the open-loops rules stop using a `## Closed` section. An existing `## Closed` section is moved to the journal by the next wake or the next chat turn that closes a loop.
