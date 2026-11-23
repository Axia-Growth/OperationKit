# App map: a current map of the app's pages for chat bots

_obj 901493. Code: `app/client/src/lib/app-map/generate.ts` (generator),
`app/shared/app-map.generated.json` (the map, generated), `app/shared/app-map.ts` (its
types), `app/server/src/services/agent-chat/app-routes-tool.ts` (the `app_routes` chat
tool)._

A chat bot cannot see the web app. When someone asks "where do I set this?", the bot
used to answer from its instructions or an old note, and the path went stale when a
page moved. The Operation Kit Dev bot sent the owner to "Settings → Platform → Queue
auto-start" after that tab was removed; the panel is really at **Workflows → Runs →
Queue auto-start**.

The app map fixes that at the source: it is generated from the client's code, and a
test fails when the committed map and the code disagree.

## What is in the map

For every page: its route, its title, the menu path a person clicks, who sees it
(everyone signed in, or admins only), its tabs, and the named panels on it with the
labels of the fields under each. Old addresses that redirect are listed with where
they go now.

| Read from | What |
|---|---|
| `App.tsx` | every `<Route>`: pages, nested routes (the Settings tabs), redirects |
| `lib/routes.ts` | route constants and the redirect tables (imported, not parsed) |
| `Layout.tsx` | `NAV_GROUPS` (main menu) and `ACCOUNT_MENU` (avatar menu), with their admin gates |
| each page component, and the components it renders | `<Tabs>` / `<SegmentedControl>` sets and the `tab === 'x' && …` branches under them; admin guards (`isAdmin && …`, `if (role !== 'admin') return`); headings (`SettingsSection`, `SectionHeader`, `CardHeader`, `h2`–`h4`); field labels (`<label>`, `<legend>`, `label="…"`) |

It holds static text from the client source only: page names, paths, headings and
field labels. No secret names or values, no user data, nothing from the database.

What code cannot say is how to reach a page with no menu entry (a card, the archive,
Needs you). Those few lines are `ROUTE_NOTES` in the generator. The test fails when a
note names a route that is gone, or a page has neither a menu path nor a note.

## Keeping it current

```bash
npm run gen:app-map --workspace=client             # rewrite app/shared/app-map.generated.json
npm run gen:app-map --workspace=client -- --check  # exit 1 when it is out of date
```

`client/src/lib/app-map/app-map.staleness.test.ts` runs in the normal client suite (so
in the `gate` check on every pull request). It regenerates the map and compares it
with the committed file. Add, move, rename or remove a route, a tab, a panel or a
field label and the test fails until you run the command above and commit the new
map. The same file proves the guard works by editing a copy of the source (a new
route, a removed route, a panel moved to another tab, a renamed panel, a new Settings
tab).

The generator is not part of `npm run build`: the running server serves a bind-mounted
checkout, and a build that rewrote a file under `app/shared` would trip the drift
guard. The test is the gate instead.

## How bots use it: the `app_routes` tool

`app_routes({ query? })` searches the map and returns up to 8 matches, each with the
click path (`Workflows > Runs > Queue auto-start`), the address (`/jobs?view=runs`),
who sees it, and the field labels. An old address comes back as `moved`, with where it
goes now. No match returns an empty list and "do not guess". No query lists every page.

**Why a tool and not a block in the prompt.** Measured on this map (22 pages, 19 tabs,
101 panels, 111 field labels, 30 redirects): about 5,500 tokens as JSON, about 1,500
even as a bare outline with no descriptions or redirects. A prompt block is paid on
every turn of every bot that has it, and grows with the app. The tool costs its
description and one prompt line (about 200 tokens) per turn, plus 100 to 300 tokens on
the turns that really need a click path.

**Who has it.**

- Operation Kit Dev always (`APP_ROUTES_DEFAULT_BOTS`), whatever its agent file or
  bot page lists. An install's own copy of the file was written before the tool
  existed.
- Any other bot: tick **App map (pages and settings)** under *This app* in the bot's
  settings, or list `app_routes` under `tools:` in its file. "All tools" includes it.

A bot that has the tool also gets one line in its system prompt: look the path up
before telling the person where to click, and say so when it is not found.

The built-in Dev bot file also has a short "Where things live in the app" table.
`app-routes-tool.test.ts` checks every row of it against the map, so that table
cannot go stale either.

## Limits

- A heading whose words are computed (a bot's name, a workspace name, "Run #12") has
  no entry. The generated file lists each one under `undescribed`.
- Dialogs and menus that open on a click are skipped, and the card viewer is described
  on the card page only.
- A tab chosen by a prop from the parent (the Registry and Assignments tabs of Bots &
  skills share one component) can list a panel under both tabs.
- "Admins only" comes from the menu gates and the admin checks in the page code. A
  page that hides something by another rule (a workspace role, a feature switch) is
  listed as visible to everyone.
- The map describes the full build. A page left out of a build by a build-time switch
  is still listed.
