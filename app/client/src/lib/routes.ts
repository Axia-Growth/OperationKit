/**
 * Route constants shared across navigation surfaces (obj 900495, Sprint 4a).
 *
 * One place to change a path that more than one surface links to, so sibling
 * sprints coordinate on a constant instead of a string scattered across files.
 */

/** The System page (formerly "Dashboard"): AI usage, spend, host stats. */
export const SYSTEM_ROUTE = '/system'

/** Old System URLs. Kept as redirects so bookmarks keep working. */
export const LEGACY_SYSTEM_ROUTES = ['/dashboard', '/costs'] as const

/**
 * The one place to manage agents AND skills (nav label "Agents & Skills").
 * Tabs are addressed with `?tab=`. Settings no longer has its own copy
 * (obj 900684): /settings/agents-skills redirects here.
 */
export const AGENTS_ROUTE = '/agents'
// One tab level (obj 900807): the registry's old inner Roster / Assignments /
// Skill graph tabs are top-level tabs now. 'registry' is the roster.
export const AGENTS_TABS = ['registry', 'assignments', 'graph', 'board', 'templates'] as const
export type AgentsTab = typeof AGENTS_TABS[number]
export const agentsTabRoute = (tab: AgentsTab) => `${AGENTS_ROUTE}?tab=${tab}`

/** Jobs, and the anchor of its host-cron section (was Settings → Platform). */
export const JOBS_ROUTE = '/jobs'
/** The Needs you decision stack (obj 901084). */
export const NEEDS_YOU_ROUTE = '/needs-you'
export const HOST_CRON_ANCHOR = 'host-cron'
export const HOST_CRON_ROUTE = `${JOBS_ROUTE}#${HOST_CRON_ANCHOR}`
/** Queue auto-start + Job time limit card on the Jobs page's Runs tab (obj 901490): /jobs#queue-auto-start. */
export const QUEUE_AUTOSTART_ANCHOR = 'queue-auto-start'
export const QUEUE_AUTOSTART_ROUTE = `${JOBS_ROUTE}#${QUEUE_AUTOSTART_ANCHOR}`

/**
 * Where AI accounts (subscription seats) are managed. Sprint 4b (obj 900496)
 * renamed Settings → Seats to Settings → Models; '/settings/seats' now
 * redirects here. Every link (the System page's included) follows this one
 * constant.
 */
export const MODELS_SETTINGS_ROUTE = '/settings/models'

/**
 * Routes that scroll the whole page instead of a nested inner scroller
 * (obj 900680). Settings used to scroll inside <main>, which cut off its
 * bottom (most visibly on mobile, where the browser bar never collapses
 * because the document itself never scrolls). App.tsx passes this to
 * Layout's pageScroll; the page uses <PageContainer scroll="page">.
 */
export const PAGE_SCROLL_PREFIXES: ReadonlyArray<string> = ['/settings']

export function usesPageScroll(pathname: string): boolean {
  return PAGE_SCROLL_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * Old URLs → their new homes (obj 900495). App.tsx renders exactly this table
 * as `<Navigate replace>` routes, and routes.redirects.test.tsx drives it
 * through a real router, so the two cannot drift.
 */
export const LEGACY_REDIRECTS: ReadonlyArray<{ from: string; to: string }> = [
  { from: '/dashboard', to: SYSTEM_ROUTE },
  { from: '/costs', to: SYSTEM_ROUTE },
  { from: '/agent-templates', to: agentsTabRoute('templates') },
  { from: '/settings/agents', to: agentsTabRoute('registry') },
  // Settings → Agents & Skills was a second copy of the registry (obj 900684).
  { from: '/settings/agents-skills', to: agentsTabRoute('registry') },
  { from: '/settings/platform', to: HOST_CRON_ROUTE },
]

/**
 * Unfinished surfaces removed in obj 900543: Notes (/loops), Feed, Strategies,
 * Development, Status and Contacts. Their pages are gone; old URLs (bookmarks,
 * links in old messages) redirect to the board ('/') instead of 404-ing, so a
 * stale link always lands somewhere useful. `/*` entries cover sub-paths such as
 * /strategy/12 and /development/DEV-4. routes.redirects.test.tsx drives every
 * entry through a real router.
 */
export const REMOVED_ROUTES: ReadonlyArray<string> = [
  '/loops',
  '/feed',
  '/strategies',
  '/strategy/*',
  '/development/*',
  '/feedback',
  '/status',
  '/contacts',
]

/**
 * The Bots page: /chat and /chat/<bot> (obj 900865). App.tsx gives all of
 * these ONE page-transition key, so picking another bot updates the page in
 * place instead of unmounting and refetching it.
 */
export function isChatPath(pathname: string): boolean {
  return pathname === '/chat' || pathname.startsWith('/chat/')
}

/**
 * The page-transition key App.tsx hands PageTransition, which REMOUNTS its
 * children whenever the key changes. So the key names a page, not a URL:
 * - every board path (/, /w/<ws>, /o/<id>, …) is 'board', so switching
 *   workspace keeps the board and its WebSocket;
 * - every /settings/* tab is 'settings';
 * - every /chat and /chat/<bot> is 'chat' (obj 900865). A per-URL key here
 *   unmounted the whole Bots page on each bot click — sidebar, bot-list fetch
 *   and fade-in included — which made a switch slow and left a blank pane.
 */
export function pageTransitionKey(pathname: string, isBoardPath: boolean): string {
  if (pathname === '/archive') return 'archive'
  if (isBoardPath) return 'board'
  if (pathname.startsWith('/settings')) return 'settings'
  if (isChatPath(pathname)) return 'chat'
  return pathname
}
