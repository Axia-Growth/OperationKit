# UI SDK world-class pass: interaction audit, 2026-11-14 (obj 900819)

Owner ask (Nov 14): walk every Operation Kit screen, button and flow, and rebuild the
interactive parts on the Vercel UI SDK behavior layer (`@ui-sdk/core` + `@ui-sdk/react`,
Apache-2.0, beta) so the product feels like an enterprise tool from a top AI lab: one
accent color, clean text and backgrounds in light and dark, easy to white-label.

This audit is the **interaction** companion to the Nov 13 visual polish audit
(`docs/audits/2026-11-13-product-polish/`, obj 900799). That one covered type, color,
spacing and copy. This one covers what happens when a person uses the keyboard, a
screen reader or a mouse: focus, dismissal, arrow keys, roles, hit targets and states.
Where the two overlap, this document points at the existing card (#900802 to #900810)
instead of filing a duplicate.

The same file is captured in the knowledge base as
`decisions/2026-11-14-ui-sdk-world-class-audit.md`.

## 1. Method

- **Build under test:** `main` at `f4013fb` (PR #762), served by a scratch copy of the
  server (`CC_SCRATCH_SERVER=1`, temp DB, one admin, six sample cards).
- **Screens:** 19 views x 2 themes = 38 screenshots in `shots/before/`
  (`NN-<screen>-<light|dark>.png`), 1440x900, headless Chromium. Sample data is neutral
  (workspaces Acme, Northwind, …; user "alex") so the evidence is safe for the public repo.
- **Keyboard probe:** a Playwright script tabbed through the first 45 stops of each of the
  17 routed screens and recorded, for every stop: tag, role, accessible name, whether a
  focus ring paints, and the hit box. It also counted buttons without a name, native
  `<select>`s, sub-24px targets, tablists and tabpanels. Raw output: `probe-before.json`.
- **Code inventory:** every hand-rolled dialog, menu, popover, select, tab bar, list,
  tree, switch, toast and drag interaction in `app/client/src` (file:line below).
- **UI SDK:** version `0.1.0-beta.2` (npm `beta` tag; `latest` still points at
  `beta.1`). Docs read from the installed package (`@ui-sdk/react/docs`), following the
  `ui-sdk` agent skill (`npx skills add vercel-labs/ui --skill ui-sdk`).

## 2. What is already good

- **A focus ring paints on every tab stop.** 0 of 444 recorded stops lacked a visible
  ring, in both themes (`:focus-visible` token, `--focus-ring`).
- **No unnamed buttons** on any screen (probe: 0 everywhere).
- **One shared Modal.** 15 dialogs already go through `ui/Modal`, which traps Tab,
  closes on Escape, locks scroll and returns focus. 26 confirms go through `useConfirm()`.
- **The Bots context menu** (`agent-chat/ContextMenu.tsx`) is the best hand-rolled widget
  in the app: roles, arrow keys with wrap, Home/End, submenus, Escape steps back.
- **Theme plumbing is right.** One `data-theme` on `<html>`, tokens only, no `dark:`
  classes. That makes a behavior layer with no styles of its own easy to adopt.

## 3. Measurements (before)

Keyboard probe on `main`, retaken on neutral sample data (`probe-before.json`). The
same script measures the after state in section 7.

<!-- before-table -->
| Screen | Tab stops | Native selects | Sub-24px targets | Tablists | Tabpanels |
|---|---:|---:|---:|---:|---:|
| Board | 37 | 0 | 2 | 0 | 0 |
| Card viewer | 19 | 0 | 0 | 0 | 0 |
| Archive | 18 | 0 | 1 | 0 | 0 |
| Bots (chat) | 19 | 0 | 0 | 0 | 0 |
| Context (knowledge) | 12 | 0 | 0 | 0 | 0 |
| Context setup | 16 | 1 | 1 | 0 | 0 |
| Workflows (jobs) | 16 | 0 | 0 | 2 | 0 |
| Agents & skills | 33 | 0 | 1 | 2 | 0 |
| System | 15 | 0 | 0 | 1 | 0 |
| Settings · Models | 42 | 3 | 13 | 1 | 0 |
| Settings · API & MCP | 29 | 0 | 4 | 2 | 0 |
| Settings · Secrets | 23 | 1 | 0 | 2 | 0 |
| Settings · Integrations | 19 | 1 | 0 | 1 | 0 |
| Settings · Workspaces | 29 | 0 | 5 | 2 | 0 |
| Settings · Branding | 41 | 0 | 6 | 1 | 0 |
| Settings · Email | 21 | 0 | 0 | 1 | 0 |
| Setup | 15 | 0 | 0 | 0 | 0 |
<!-- /before-table -->

Code-wide (non-test `.tsx`): 228 raw `<button>`s, 50 native `<select>`s, 0
`role=combobox`, 0 `role=tree`, 0 `role=tabpanel`, 0 `aria-activedescendant`, 0 `inert`,
3 `aria-modal`, 255 `title=` attributes standing in for tooltips, 2 `createPortal`s.

Command palette (Ctrl/⌘K) probe: focus lands in the input, but there is no
`role=dialog`, the input is not a `combobox`, and after Escape focus falls to `<body>`.

## 4. Findings by primitive

Key: **KB** keyboard model, **FT** focus trap, **FR** focus return, **OC** outside press.

### 4.1 Dialogs, sheets, overlays
- `ui/Modal.tsx`: good FT/FR/Escape, but the page behind is **not inert** (comment at
  `:74`), so a screen reader can still read and reach it; scroll lock is a body style.
  Every caller passes an inline `onClose`, which once broke focus (obj 700071).
- Seven hand-rolled overlays with no FT and no FR: `CommandPalette.tsx:53`,
  `ObjectiveSearchPanel.tsx:165`, `FileEditorOverlay.tsx:127`, `PlanningPanel.tsx:226`
  (no Escape at all), `SessionViewer.tsx:448` (dialog role, no FT/FR),
  `DocsPage.tsx:395` mobile tree drawer (scrim only), `kb-wiki/WorkspaceGraph.tsx:295`.
- `ui/ConfirmDialog.tsx` renders `role=dialog`, not `alertdialog`; `PlanningPanel.tsx:216`
  still calls the native `confirm()`.

### 4.2 Menus and popovers
- Account menu (`Layout.tsx:351-428`): `role=menu` with `menuitem`s but **no arrow keys,
  no initial focus, no focus return**: a menu in name only.
- `FilterDropdown.tsx` (Workspace switcher, Owner filter, Project filter): trigger says
  `aria-haspopup="true"`, the panel has no role, no arrow keys, focus never moves in and
  never comes back. Options are `aria-pressed` buttons.
- `agent-chat/ContextMenu.tsx`: solid, but no typeahead, checked items are plain
  `menuitem`s with a tick icon (should be `menuitemradio`/`menuitemcheckbox`), and it is a
  second menu implementation to maintain.
- `AlertBell.tsx:166`: a popover with `role=dialog`, but focus does not move in or return.

### 4.3 Selects and comboboxes
- 50 native `<select>`s with two style helpers (`config/config-form.tsx:12`,
  `objective-modal/form-tokens.ts:5`). In dark mode the OS list paints light on most
  platforms. The filter-bar ones (Secrets "All scopes", Integrations workspace, Project
  filter) sit next to custom buttons and look foreign.
- The command palette and card search are comboboxes in all but markup (no
  `aria-activedescendant`, no `aria-expanded`, no `aria-controls`).

### 4.4 Tabs
- `ui/Tabs.tsx` (14 call sites) sets `tablist`/`tab`/`aria-selected` only. **No arrow
  keys, no roving tabindex, no `tabpanel`, no `aria-controls`.** Its header comment claims
  "arrow nav by the browser"; there is none. Every tab is a separate Tab stop.
- Hand-rolled tab rows: `AlertBell.tsx:187`, `ConnectMcpServerDialog.tsx:175`, the lane
  strip in `AgentChatPage.tsx:107`. Pressed-button rows acting as tabs:
  `PreviewArchive.tsx:124`, `WorkflowsPanel.tsx:396`, `DesignCanvas.tsx:70`,
  `ObjectiveSearchPanel.tsx:190`.

### 4.5 Lists and trees
- KB tree (`DocsPage.tsx:129-178`): nested buttons, **no `tree`/`treeitem`, no
  `aria-expanded`, no arrow keys**; the selected file is shown by color only.
- Bots sidebar (`agent-chat/BotSidebar.tsx`): `nav > section > ul > button` with
  `aria-current`. Fine as navigation, but every bot is its own Tab stop and section headers
  are the only `aria-expanded` toggles. Pins move by menu ("Move pin left/right").
- `jobs/ExecutionsPanel.tsx:211`: `role=listbox` wrapping buttons, no keyboard model.

### 4.6 Toggles and switches
- Three switch implementations: `SettingsSeats.tsx:144` (`Switch`),
  `QueueAutostartPanel.tsx:41` (`Toggle`, near copy), `HighAgencySection.tsx:182`
  (checkbox with `role=switch`).
- Settings · Models has 36 sub-24px targets: 16x16 radios and checkboxes for enable,
  default and planner.
- Radio groups without arrow keys: `EmailSettingsPanel.tsx:200`, `SecretFields.tsx:27`.

### 4.7 Tooltips, toasts, drag and drop
- No tooltip component; 255 `title=`s, which never show on keyboard focus or touch.
- `ui/Alert.tsx` `Toast` is used once (`BotSidebar.tsx:751`) with a hand-rolled timer.
  `JobsBoard.tsx:924` and `WorkflowsPanel.tsx:220` render inline "toasts" with no live
  region.
- **Drag and drop:** `@dnd-kit/*` is installed but imported nowhere. The only drags are
  file drops (`hooks/useFileDrop.ts` and three inline `onDrop`s). Pins reorder by menu.

### 4.8 Hit targets and states
- Sub-24px (WCAG 2.2 SC 2.5.8): Models radios/checkboxes (16px), API & MCP inline links
  (17px), Workspaces rows (21px), Branding swatch toggles (14-16px), card titles (19px).
- Loading: `Button` has `loading`, but most async buttons set `disabled` only, so a click
  gives no feedback until it lands. Disabled accent buttons fade with `opacity-50`
  (#900805 lists them).

## 5. Ranked fix list

Rank = reach x severity. Status is as of PR #764 (branch
`cc/obj-900819-world-class-ui-pass-every-screen-button`, not merged).

| # | Fix | Severity | Reach | Status |
|---|---|---|---|---|
| U1 | Tabs: arrow keys, roving tabindex, tab panels (`ui/Tabs` on UI SDK Tabs) | High | 14 call sites, every Settings page | **Done.** Filter rows that only looked like tabs became `ui/SegmentedControl` |
| U2 | Command palette as a real dialog + combobox; focus returns to where it was | High | Every page (Ctrl/⌘K) | **Done.** UI SDK Command in `ui/Modal`; board "/" search too; both load on first open |
| U3 | `ui/Modal` on UI SDK Dialog: page behind becomes inert, top layer | High | 15 dialogs | **Done** |
| U4 | Account menu and FilterDropdown on UI SDK Menu / Popover | High | Header on every page, board filters | **Done.** New shared `ui/Menu` |
| U5 | Bots sidebar context menu on UI SDK Menu (typeahead, radio items) | Medium | Bots | **Done.** Same props, so the sidebar is unchanged |
| U6 | Confirms on UI SDK Alert Dialog; drop the native `confirm()` | Medium | 26 confirms | **Done.** 0 native `confirm()` left |
| U7 | One `ui/Switch` on UI SDK Switch; replace the three copies | Medium | Models, Queue, High Agency, Seats | **Done.** Models' per-model enable is a switch too |
| U8 | KB tree on UI SDK Tree | Medium | Context | **Done** |
| U9 | `ui/Select` on UI SDK Select | Medium | All forms and filters | **Done.** All 48 native selects moved (0 left) |
| U10 | `ui/Tooltip` on UI SDK Tooltip for icon-only buttons | Medium | Header, card actions | **Done** for `IconButton` (17 uses) and the header; the remaining 252 `title=`s are hints on text controls, left for #900805/#900806 |
| U11 | Design foundations | Medium | All screens | **Done** (#900802, F1) |
| U12 | Hit targets to 24px minimum | Medium | Models, Workspaces, … | **Done** for Models (13 → 2 by the probe; those two are 16px radios inside 32px labels), Workspaces (5 → 0), Context and Branding rows; the rest are inline text links (exempt under WCAG 2.5.8) |
| U13 | Overlays without focus handling onto Dialog | Medium | 7 overlays | **Done.** File editor, planning, session viewer, KB drawer, graph full screen |
| U14 | Toasts on UI SDK toast with a live region | Low | Workflows, Jobs | **Done.** New `ui/Toaster`, mounted once, lazy |
| U15 | Radio groups on UI SDK Radio | Low | Email, secret fields | **Done.** New `ui/RadioGroup` |
| U16 | Remove unused `@dnd-kit/*` | Low | Bundle hygiene | **Done.** No drag interaction exists to migrate (file drops only) |
| U17 | Visual polish cards F2-F9 | Mixed | All | See section 6 |

Also moved, not on the original list: the alert bell (Popover + Tabs), the MCP-connect and
chat-lane tab strips (Tabs), the Executions run list (UI SDK Listbox), and four one-of-N
button rows (SegmentedControl).

## 6. Polish cards from Nov 13: covered or sequenced

| Card | Title | Status |
|---|---|---|
| #900802 | F1 design foundations | **Fully covered** in PR #764 (can be closed when it merges) |
| #900804 | F3 dark mode in third-party widgets | **Fully covered** in PR #764: React Flow colorMode + token chrome, Mermaid classDefs on tokens, BlockNote follows the theme, meeting badge, disk banner, skill graph redraw, branding tiles, changelog page brand + dark |
| #900803 | F2 white-label leaks | **Sequenced first after #764 merges.** Touches `JobsBoard.tsx` and `index.css`, which #764 edits. Seen again during this pass: a fresh scratch DB seeds the operator's own workspaces |
| #900805 | F4 board + card viewer primitives | Sequenced after F2. Partly prepared: `ui/Select`, `ui/Tooltip`, `IconButton` defaults |
| #900806 | F5 Settings, Secrets, sign-in forms | Sequenced after F4. Its "styled, not native Select" item is done here (`ui/Select`) |
| #900807 | F6 page shell + hierarchy | Sequenced after F5. Palette hints and duplicate "Settings" row left for it |
| #900808 | F7 plain language | Sequenced after F6 (copy across files #764 touches) |
| #900809 | F8 loading, empty, error states | Sequenced after F7 |
| #900810 | F9 icons + dead code | Sequenced last |

Order: F2 → F4 → F5 → F6 → F7 → F8 → F9, one at a time, each started after the previous
merges, because they share files with each other and with #764.

## 7. After (PR #764)

Same scratch server, same sample data, same probe script, on this branch's build.
`probe-after.json` is the raw output; `shots/after/` holds the 38 matching screenshots plus
open-state shots of the migrated primitives (`19`–`25`: account menu, card search, filter
popover, Bots context menu, select list, tooltip on keyboard focus, tabs after →), each in
light and dark.

<!-- after-table -->
| Screen | Tab stops | Native selects | Sub-24px targets | Tablists | Tabpanels |
|---|---:|---:|---:|---:|---:|
| Board | 37 | 0 | 2 | 0 | 0 |
| Card viewer | 19 | 0 | 0 | 0 | 0 |
| Archive | 18 → **17** | 0 | 1 | 0 | 0 |
| Bots (chat) | 19 | 0 | 0 | 0 | 0 |
| Context (knowledge) | 12 | 0 | 0 | 0 | 0 |
| Context setup | 16 | 1 → **0** | 1 | 0 | 0 |
| Workflows (jobs) | 16 → **14** | 0 | 0 | 2 → **1** | 0 |
| Agents & skills | 33 → **29** | 0 | 1 | 2 | 0 → **2** |
| System | 15 → **11** | 0 | 0 | 1 → **0** | 0 |
| Settings · Models | 42 → **36** | 3 → **0** | 13 → **2** | 1 | 0 → **1** |
| Settings · API & MCP | 29 → **20** | 0 | 4 | 2 → **1** | 0 → **1** |
| Settings · Secrets | 23 → **15** | 1 → **0** | 0 | 2 | 0 → **2** |
| Settings · Integrations | 19 → **13** | 1 → **0** | 0 | 1 | 0 → **1** |
| Settings · Workspaces | 29 → **22** | 0 | 5 → **0** | 2 | 0 → **2** |
| Settings · Branding | 41 → **35** | 0 | 6 → **5** | 1 | 0 → **1** |
| Settings · Email | 21 → **13** | 0 | 0 | 1 | 0 → **1** |
| Setup | 15 | 0 | 0 | 0 | 0 |
<!-- /after-table -->

Fewer tab stops is the point: a tab list, segmented control, tree or radio group is now
one Tab stop with arrow keys inside it (roving focus), and every tab list has real tab
panels. The remaining sub-24px hits are inline text links (exempt under WCAG 2.5.8), the
Models default/planner radios (16px inputs inside a 32px clickable label; the probe
measures the input), and Branding checkboxes inside their text labels.

Screen-reader pass (accessibility tree of each migrated primitive, reached by keyboard):
[`screen-reader-pass.md`](./screen-reader-pass.md).

<!-- checks -->
| Check | Before (main) | After (this PR) |
|---|---|---|
| ⌘K palette | dialog role: no · field is a combobox: no · active option announced after ↓: no · focus after Escape: **page body (lost)** | dialog role: yes · field is a combobox: yes · active option announced after ↓: yes · focus after Escape: "Switch to dark mode" (back where it was) |
| Account menu by keyboard | Enter on the avatar focuses: **nothing in the menu** · ↓ moves to: **nowhere** · focus after Escape: "Account menu" | Enter on the avatar focuses: the first item ("Settings") · ↓ moves to: "System" · focus after Escape: "Account menu" |
<!-- /checks -->

### What each primitive runs on now

| Primitive | Shared component | UI SDK part | Interaction test |
|---|---|---|---|
| Dialog, sheet | `ui/Modal` | Dialog (page inert, top layer) | `ui/Modal.test.tsx` + one per overlay |
| Confirm | `ui/ConfirmDialog` / `useConfirm()` | Alert Dialog (focus on Cancel) | `ui/ConfirmDialog.test.tsx` |
| Tabs | `ui/Tabs` | Tabs | `ui/Tabs.test.tsx` (pattern check) |
| One-of-N filter | `ui/SegmentedControl` | Segmented Control | `ui/Tabs.test.tsx`, `PreviewArchive.test.tsx`, `DesignCanvas.test.tsx` |
| Menu, context menu | `ui/Menu`, `agent-chat/ContextMenu` | Menu (submenus, radio items, typeahead) | `ui/Menu.test.tsx`, `ContextMenu.test.tsx` (pattern checks) |
| Popover | `FilterDropdown`, `AlertBell` | Popover | `FilterDropdown.test.tsx`, `AlertBell.test.tsx` |
| Tooltip | `ui/Tooltip`, `IconButton` | Tooltip | `ui/Tooltip.test.tsx` |
| Select | `ui/Select` (all 48 former native selects) | Select | `ui/Select.test.tsx` + updated call-site tests |
| Command palette, card search | `CommandPalette`, `ObjectiveSearchPanel` | Command in Dialog | `CommandPalette.test.tsx`, `ObjectiveSearchPanel.test.tsx` |
| Tree | Knowledge base page tree | Tree | `DocsPage.tree.test.tsx` (pattern check) |
| Listbox | Executions run list | Listbox | `JobsBoard.executions.test.tsx` (pattern check) |
| Switch | `ui/Switch` (Seats, Queue, High Agency, Models) | Switch | `ui/Switch.test.tsx` (pattern check), `ModelsModule.test.tsx` |
| Radio group | `ui/RadioGroup` | Radio | `ui/RadioGroup.test.tsx` (pattern check) |
| Toast | `ui/Toaster` | Toast | `ui/Toaster.test.tsx` |
| Drag and drop | none in the app (file drops only) | — | — |

### Bundle size

No size budget exists in the repo, so this is measured against `main` (vite production
build, gzip level 9):

| | main | this PR | change |
|---|---:|---:|---:|
| Entry chunk (first load) | 82.7 kB | 162.4 kB | +79.7 kB |
| All JS | 1,761.2 kB | 1,887.4 kB | +126.2 kB (+7%) |

The entry grows because the header (menu, tooltip), board (dialogs, selects, popovers,
tabs) and Settings now use the SDK on first paint. Interaction-only parts load on demand:
the ⌘K palette and card search load on first open, and the toast stack mounts lazily
(entry was 178.1 kB before that split). Next lever if the entry matters more than repeat
visits: a cached vendor chunk for `@ui-sdk/*`, like the React one.

### Tests

Client: 134 files, 829 tests, exit 0, no unhandled errors (`npx vitest run`). `tsc` clean
for client and server. jsdom gained stubs the SDK needs (`matchMedia`, `CSS.escape`,
`CSS.supports`) in `src/test/setup.ts`.
