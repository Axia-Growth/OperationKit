# Deleting archived workspaces (obj 900870)

Settings → Organizations lists archived workspaces at the bottom (obj 900683). Each
archived row has **Restore** and **Delete**. Active workspaces have no Delete — archive
first (the existing **Remove** button), then delete from the archived list.

## What Delete does

Delete is a **reversible soft-delete**. It sets `workspaces.deleted_at` / `deleted_by`
on the row and nothing else:

- The workspace leaves the admin archived list (`GET /api/admin/workspaces`).
- It was already hidden from the board, the org switcher and `GET /api/workspaces`
  because it is archived.
- **Nothing is permanently removed.** Its cards, workspace-scoped secrets, repos,
  connections and members stay. Shared (global) secrets and every other workspace are
  not touched.
- The row stays, so `merged_into` redirects and doc-path attribution for old cards
  still resolve the slug. Creating a new workspace with the same slug is refused (409)
  with a hint to undelete instead.

## API (cookie admin only — agent keys and card session tokens get 403)

| Call | Result |
|---|---|
| `POST /api/admin/workspaces/:slug/delete` body `{"confirm":"<slug>"}` | 200 deleted · 400 confirm missing/wrong · 409 `not_archived` (active) · 404 unknown or already deleted |
| `GET /api/admin/workspaces?include_deleted=1` | list including deleted rows (`deleted_at` set) |
| `POST /api/admin/workspaces/:slug/undelete` | back on the archived list, still archived · 404 if not deleted |
| `PATCH /api/admin/workspaces/:slug` on a deleted row | 404 — undelete first |

## How to recover a deleted workspace

1. `POST /api/admin/workspaces/<slug>/undelete` as an admin (or, from the host,
   `UPDATE workspaces SET deleted_at = NULL, deleted_by = NULL WHERE slug = '<slug>'`
   followed by a backend restart to clear the cache).
2. It reappears under **Archived workspaces**. Click **Restore** to make it active.

Tests: `app/server/src/routes/admin-workspaces-delete-archived.test.ts`,
`app/client/src/components/config/WorkspacesTab.delete-archived.test.tsx`.
