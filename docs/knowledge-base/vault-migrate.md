# Moving knowledge base files without breaking links

`scripts/vault-migrate.mjs` moves files inside **one workspace folder** of the knowledge
base. It fixes every link that pointed at a moved file, adds the missing front matter,
and keeps a table of where everything went. Use it to reorganise a folder that has grown
too big (for example a flat `decisions/` folder) instead of moving files by hand.

It is a command-line tool for whoever runs the server. It changes nothing unless you add
`--apply`.

## 1. Write the mapping

A CSV file with one row per file. Paths are relative to the workspace folder.

```csv
old_path,new_path,type
decisions/2026-01-05-pricing-model.md,products/pricing/2026-01-05-pricing-model.md,decision
decisions/old-name.md,topics/new-name.md,topic
runbooks/restart.md,runbooks/restart.md,runbook
```

- `type` is what goes into the page's `type:` front matter if the page has none. Leave it
  empty to use the new top folder (`decisions/` gives `decision`).
- A row with the same old and new path moves nothing and only adds front matter.
- The header row, blank lines and lines starting with `#` are skipped.

## 2. Dry run (the default)

```bash
node scripts/vault-migrate.mjs --workspace /path/to/vault/workspaces/acme --map mapping.csv
```

This prints the full report and writes nothing: the files it would move, each link it
would rewrite, the front matter it would add, and any warnings. Read it before going on.
Add `--json` for a machine-readable report.

## 3. Apply

Take a backup or commit the vault first, so one `git checkout` undoes the run. Then:

```bash
node scripts/vault-migrate.mjs --workspace /path/to/vault/workspaces/acme --map mapping.csv --apply
```

Running it again with the same mapping does nothing ("Nothing to do.").

## What it does

| Step | Detail |
|---|---|
| Moves files | Creates the new folders. Never overwrites a file. Empty old folders are left in place. |
| Rewrites wiki links | `[[folder/page]]`, `[[page]]`, `[[page#heading]]`, `[[page\|label]]` and `![[embeds]]`, in every markdown file of the workspace. A `[[page]]` link written by name only is left alone when the file kept its name, because it still finds it. |
| Rewrites markdown links | Relative links such as `[text](../folder/page.md#part)` and images. Links inside a moved page are recalculated too, because its own folder changed. |
| Leaves alone | Web links, links to files that did not move, and anything inside code (backticks or fenced blocks). |
| Adds front matter | To the pages in the mapping only: `title` (first heading, else the file name), `type`, `date` (from a `YYYY-MM-DD` file name, else the file's last-modified date) and `workspace` (the folder name, or `--workspace-name`). A key the page already has is never changed. |
| Redirect table | Appends one row per moved file to `archive/moved.md` in the workspace: old path, new path, type, date. |
| Report | Printed at the end. It also lists old paths that are still written as plain text (not a link), which it does not change. |

## What it refuses

Any one of these stops the whole run before anything is written, and the report lists
every problem with its row number:

- a path that is absolute, contains `..`, uses backslashes, or passes through a symlink
- a source file that does not exist, or a destination that already exists
- the same old path or new path on two rows, or a new path that is another row's old path
- moving or replacing `archive/moved.md`

Nothing outside the folder given to `--workspace` is ever written.

## Options

| Option | Meaning |
|---|---|
| `--workspace <folder>` | The workspace folder to work in. Required. |
| `--map <file.csv>` | The mapping file. Required. It can live anywhere. |
| `--apply` | Write the changes. Without it the run is a dry run. |
| `--json` | Print the report as JSON. |
| `--workspace-name <name>` | Value for the `workspace` front matter key. Default: the folder name. |
| `--date <YYYY-MM-DD>` | Date written into the redirect table. Default: today. |

Exit code `0` means the run (or dry run) is clean, `1` means it was refused, `2` means the
command line was wrong.

## Good to know

- Apply is not a single transaction. If it is interrupted halfway, restore the vault from
  the backup or commit and run it again.
- The tool edits files on disk and does not tell the server. Search picks the moves up on
  its next reconcile pass (about 15 minutes); an admin can also run the index from
  **Jobs → Knowledge index**.
- A `[[page]]` link that could mean two different files is left as written and listed
  under Warnings.

Tests: `app/server/src/scripts/vault-migrate.test.ts`, on the fixture vault in
`app/server/src/scripts/fixtures/vault-migrate/`.
