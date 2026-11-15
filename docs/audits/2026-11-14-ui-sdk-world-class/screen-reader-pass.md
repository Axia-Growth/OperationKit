# Screen-reader pass: accessibility tree of the migrated primitives (obj 900819)

What a screen reader is given, captured with Playwright `ariaSnapshot()` from the after
build (same scratch server and sample data as `shots/after/`). Each state was reached by
keyboard where the heading says so. This is the automated half of the pass; it checks
roles, names, states and structure. It does not replace listening with NVDA/VoiceOver,
which this sandbox cannot run.

Found and fixed during this pass: the open list of `ui/Select` had no name (now named
like its field, test added).

### Header (desktop)

```yaml
- banner:
  - navigation "Primary":
    - link "Operation Kit home":
      - /url: /
      - img "Operation Kit"
    - link "Bots":
      - /url: /chat
    - link "Board":
      - /url: /
    - link "Context":
      - /url: /knowledge
    - link "Workflows":
      - /url: /jobs
  - button "Jump to a page (command palette)": Jump to page… ⌘K
  - 'button "Workspace: All workspaces"': Workspace All workspaces
  - button "Notifications":
    - img
  - button "Switch to dark mode"
  - button "Account menu": A alex
```

### Account menu open (keyboard: Enter on avatar)

```yaml
- menu "Account menu":
  - group "alex admin":
    - text: alex admin
    - menuitem "Settings"
    - menuitem "System"
    - menuitem "Agents & Skills"
  - separator
  - menuitem "Log out"
```

### ⌘K palette open, after ↓

```yaml
- dialog "Jump to a page":
  - heading "Jump to a page" [level=2]
  - combobox "Jump to a page" [expanded]
  - text: esc
  - status
  - listbox:
    - option "Bots /chat"
    - option "Board /" [selected]
    - option "Context /knowledge"
    - option "Workflows /jobs"
    - option "Settings /settings"
    - option "System /system"
    - option "Agents & Skills /agents"
    - option "Settings /settings"
    - option "Integrations /settings/integrations"
    - option "Secrets /settings/secrets"
    - option "Workspace settings /settings/workspaces"
    - option "Agent registry /agents?tab=registry"
    - option "Agent templates /agents?tab=templates"
```

### Board card search open

```yaml
- dialog "Search objectives":
  - heading "Search objectives" [level=2]
  - combobox "Search objectives" [expanded]
  - text: esc
  - radiogroup "Search mode":
    - radio "Keyword" [checked]
    - radio "AI"
  - status: 0 results
  - listbox
```

### Settings · Secrets scope select open

```yaml
- listbox "Scope":
  - option "All scopes" [selected]
  - option "Everywhere"
  - option "Workspace"
  - option "User"
  - option "Workspace + User"
```

### Settings tabs

```yaml
- tablist "Settings sections":
  - tab "Models" [selected]
  - tab "API & MCP"
  - tab "Integrations"
  - tab "Secrets"
  - tab "Workspaces"
  - tab "Branding"
  - tab "Email"
```

### Bots context menu (keyboard: Enter on ⋯)

```yaml
- menu "Actions for Knowledge Base Setup":
  - menuitem "Pin to top"
  - menuitem "Move to section"
  - menuitem "Mark as unread"
  - menuitem "Rename…"
  - menuitem "Copy ID kb-setup"
  - menuitem "Hide from sidebar"
  - separator
  - menuitem "Delete… Ships with the app — hide it instead" [disabled]
```

### Alert bell popover

```yaml
- dialog "Notifications":
  - text: Notifications
  - tablist "Filter notifications":
    - tab "Unread" [selected]
    - tab "All"
  - tabpanel "Unread":
    - text: You’re all caught up
    - paragraph: Problems the platform spots on its own — failed jobs, deploy drift, low disk — show up here.
```
