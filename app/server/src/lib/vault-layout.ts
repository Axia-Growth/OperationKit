/**
 * Vault layout registry (obj 900967; step 2 of the knowledge base migration
 * plan in the 2026-11-15 quality audit, finding 11).
 *
 * The folder names the server hard-codes inside a workspace's knowledge base
 * live here, so the vault can be restructured by changing ONE module instead
 * of the capture prompt, the capture-gap detector and the poller each spelling
 * out "decisions/" themselves.
 *
 * Every path is RELATIVE to the knowledge base root (`knowledgeBaseRoot()`),
 * uses forward slashes and has no leading or trailing slash. This module moves
 * no files and reads nothing from disk.
 *
 * `settings.kb_capture_layout` picks where a session's decision capture goes:
 *   - `decisions` (default; also any unset or unknown value): `<ws>/decisions`
 *   - `log-by-month`: `<ws>/log/YYYY-MM`
 * It changes ONLY what `captureDir()` returns, plus the two matchers that have
 * to recognise a write to that folder. With the default every prompt and regex
 * is byte-identical to what the callers produced before this module existed
 * (asserted against a fixture in vault-layout.test.ts).
 */
import type Database from 'better-sqlite3'
import { readSetting } from './install-defaults.js'

export const KB_CAPTURE_LAYOUT_SETTING = 'kb_capture_layout'
export const CAPTURE_LAYOUTS = ['decisions', 'log-by-month'] as const
export type CaptureLayout = (typeof CAPTURE_LAYOUTS)[number]
export const DEFAULT_CAPTURE_LAYOUT: CaptureLayout = 'decisions'

/** Month placeholder for prompt text, next to the `YYYY-MM-DD-<slug>.md` file name. */
export const MONTH_PLACEHOLDER = 'YYYY-MM'

type Workspace = string | null | undefined

/** Anything but an exact known value is the default. Never throws. */
export function parseCaptureLayout(raw: string | null | undefined): CaptureLayout {
  const v = (raw || '').trim().toLowerCase()
  return (CAPTURE_LAYOUTS as readonly string[]).includes(v) ? (v as CaptureLayout) : DEFAULT_CAPTURE_LAYOUT
}

/** The install's capture layout. Read at point of use; an uninitialised DB reads as the default. */
export function captureLayout(db?: Database.Database): CaptureLayout {
  return parseCaptureLayout(readSetting(KB_CAPTURE_LAYOUT_SETTING, db))
}

/** A workspace's own folder: `personal`, or `workspaces/<slug>`. */
export function workspaceDir(ws: Workspace): string {
  return !ws || ws === 'personal' ? 'personal' : `workspaces/${ws}`
}

/** The decisions folder. Fixed: it does not follow `kb_capture_layout`. */
export function decisionsDir(ws: Workspace): string {
  return `${workspaceDir(ws)}/decisions`
}

/** `YYYY-MM` of a date, in UTC (the capture prompt names files with `date -u`). */
export function captureMonth(date: Date): string {
  return date.toISOString().slice(0, 7)
}

/**
 * Where a session writes its decision capture.
 * @param date a Date for a concrete month, or a string used verbatim as the
 *   month segment (pass `MONTH_PLACEHOLDER` for prompt text). Ignored by the
 *   `decisions` layout.
 */
export function captureDir(ws: Workspace, date: Date | string = new Date(), layout: CaptureLayout = captureLayout()): string {
  if (layout === 'log-by-month') {
    return `${workspaceDir(ws)}/log/${typeof date === 'string' ? date : captureMonth(date)}`
  }
  return decisionsDir(ws)
}

/**
 * The data-access map folder (obj 901772): `data-access/` inside a workspace's
 * knowledge folder holds `map.md` (where current data lives and how to query
 * it) and `flags/` (one file per "the map is wrong" report). Fixed name; it
 * does not follow `kb_capture_layout`. See services/data-access-map.ts.
 */
export const DATA_ACCESS_SUBDIR = 'data-access'
export const DATA_ACCESS_MAP_NAME = 'map.md'
export const DATA_ACCESS_FLAGS_NAME = 'flags'

/** The workspace's entry-point page. */
export function activeFile(ws: Workspace): string {
  return `${workspaceDir(ws)}/active.md`
}

/** The workspace's auto-generated menu page. */
export function indexFile(ws: Workspace): string {
  return `${workspaceDir(ws)}/index.md`
}

/** The capture folder with the workspace part removed: `decisions`, or `log/<month>`. */
export function captureSubdir(date: Date | string = new Date(), layout: CaptureLayout = captureLayout()): string {
  return captureDir('personal', date, layout).slice(workspaceDir('personal').length + 1)
}

/**
 * Matches a touched file that is a capture doc in the vault. `log-by-month`
 * also keeps accepting `decisions/`, so docs written before (or during) a
 * layout switch are not reported as a capture gap.
 */
export function captureDocPattern(layout: CaptureLayout = captureLayout()): RegExp {
  return layout === 'log-by-month'
    ? /(?:^|\/)second-brain\/.*\/(?:decisions|log\/\d{4}-\d{2})\/[^/]+\.md$/
    : /(?:^|\/)second-brain\/.*\/decisions\/[^/]+\.md$/
}

/** Path fragments that mark a file write as a knowledge write (live poller scan). */
export function knowledgePathMarkers(layout: CaptureLayout = captureLayout()): string[] {
  const markers = [`second-brain/${decisionsDir('personal')}/`, 'second-brain/workspaces/', 'second-brain/personal/insights/']
  if (layout === 'log-by-month') markers.push(`second-brain/${workspaceDir('personal')}/log/`)
  return markers
}

/** Is this written path a decision capture (as opposed to any other knowledge write)? */
export function isCapturePath(filePath: string, layout: CaptureLayout = captureLayout()): boolean {
  if (filePath.includes('/decisions/')) return true
  return layout === 'log-by-month' && /\/log\/\d{4}-\d{2}\//.test(filePath)
}
