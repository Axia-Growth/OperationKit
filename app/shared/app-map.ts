/**
 * The app map (obj 901493): every page of the web app, the menu path a person
 * clicks to reach it, who can see it, and the named panels and settings on it.
 *
 * The DATA lives in `app-map.generated.json`, written by
 * `npm run gen:app-map --workspace=client` from the client's real router
 * (App.tsx), navigation (Layout.tsx) and page components. Nobody edits it by
 * hand: `client/src/lib/app-map/app-map.staleness.test.ts` regenerates the map
 * in CI and fails when the committed copy differs, so a route, tab or panel
 * cannot be added, moved or removed without the map changing with it.
 *
 * Chat bots read it through the `app_routes` tool
 * (`server/src/services/agent-chat/app-routes-tool.ts`).
 *
 * It holds page names, paths, headings and field labels only. No secret
 * names or values and no user data: everything in it is static text from the
 * client source.
 */

export type AppMapAudience = 'everyone' | 'admin'

/** A named panel (a section heading) on a page, or on one tab of it. */
export interface AppMapPanel {
  name: string
  /** Tab labels between the page and the panel, outermost first. Empty = on the page itself. */
  trail: string[]
  /** Bigger headings this one sits under on the page, outermost first (e.g. ["Bot settings"]). */
  under?: string[]
  audience: AppMapAudience
  /** The section's own one-line description, when the page states one. */
  description?: string
  /** Labels of the fields / switches under this heading. */
  settings?: string[]
}

/** A tab inside a page (not a route of its own). */
export interface AppMapTab {
  label: string
  /** Parent tab labels, outermost first. */
  trail: string[]
  audience: AppMapAudience
  /** Deep link, when the tab is addressed in the URL. */
  url?: string
}

export interface AppMapPage {
  /** Route pattern, e.g. `/jobs` or `/o/:id`. */
  path: string
  title: string
  /** What a person clicks, in order: e.g. ["Avatar menu", "Settings", "Secrets"]. */
  click_path: string[]
  /** One line on reaching a page that is not a menu entry, or on finding something on it. */
  how?: string
  audience: AppMapAudience
  /** Same page as this other path: its tabs and panels are listed there. */
  same_as?: string
  tabs: AppMapTab[]
  panels: AppMapPanel[]
}

/** An old URL that now lands somewhere else. */
export interface AppMapRedirect {
  from: string
  to: string
}

export interface AppMap {
  pages: AppMapPage[]
  redirects: AppMapRedirect[]
  /** What the generator saw but could not describe (computed headings, computed redirect targets). */
  undescribed: string[]
}

/** "Workflows > Runs > Queue auto-start": the click path to a panel, tab or page. */
export function appMapClickPath(page: AppMapPage, trail: string[] = [], leaf?: string): string {
  return [...page.click_path, ...trail, ...(leaf ? [leaf] : [])].join(' > ')
}
