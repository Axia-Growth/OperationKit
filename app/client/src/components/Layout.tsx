import { useState, useEffect, useMemo, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useBoardTheme } from '../preview/BoardShell'
import { useBranding } from '../hooks/useBranding'
import { BrandLogo } from './BrandLogo'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from '../context/nav'
import { useWorkspaces, invalidateWorkspacesCache } from '../hooks/useWorkspaces'
import { api } from '../lib/api'
import { OrgSwitcher } from './OrgSwitcher'
import type { Workspace } from '@operationkit/shared'
import { CommandPalette } from './lazy-overlays'
import { AlertBell } from './AlertBell'
import { NeedsYouBadge } from './decisions/NeedsYouBadge'
import { NavIcon, type NavIconName } from './nav-icons'
import { IconButton } from './ui/Button'
import { commandPaletteShortcut } from '../lib/platform'
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from './ui/Menu'
import { HAS_CHAT_PAGE } from '../lib/optional-pages'
import { useOnScreenKeyboard } from '../hooks/useOnScreenKeyboard'
import { prefetchContext } from '../lib/kbContextData'
import { SYSTEM_ROUTE, LEGACY_SYSTEM_ROUTES, AGENTS_ROUTE, JOBS_ROUTE, NEEDS_YOU_ROUTE, agentsTabRoute } from '../lib/routes'

interface LayoutProps {
  children: ReactNode
  /** Selected workspace slugs. An empty array means "All Workspaces". */
  selectedWorkspaces: Workspace[]
  onWorkspacesChange: (ws: Workspace[]) => void
  /**
   * Page-scroll mode (obj 900680): the DOCUMENT scrolls instead of <main>.
   * The shell grows with its content, both top bars stick to the top, and
   * <main> no longer clips. Routes opt in through usesPageScroll() in
   * lib/routes.ts. Off = the fixed-height shell the board needs.
   */
  pageScroll?: boolean
}

/* ─────────────────────────────────────────────────────────────────────────
   Navigation IA (Sprint 4a, obj 900495)
   ----------------------------------------------------------------------------
   Two places, one model each:

     • NAV_GROUPS — the primary bar: Bots (when the chat page is in the build),
       Board, Context (the knowledge base), Workflows (formerly Jobs; obj 900675). The desktop top bar and the 390px bottom
       bar render the same ≤4 items. There is no "More" group any more.
     • ACCOUNT_MENU — the avatar dropdown, the same menu on desktop and mobile:
       one flat list — Settings for everyone, then System and Agents for global
       admins, then Log out. obj 900686 dropped Archive (the board's own Archive
       button already gets you there) and the "Admin" sub-heading, which made a
       two-item menu read as a form. The old → new table is
       docs/navigation/sprint-4a-navigation.md.

   The unfinished surfaces (Contacts, Strategies, Development, Notes, Status,
   Feed) were removed in obj 900543; their old URLs redirect to the board
   (REMOVED_ROUTES in lib/routes.ts).
   ───────────────────────────────────────────────────────────────────────── */

type NavGate = 'admin' | 'chat'

interface NavItem {
  href: string
  label: string
  /** Shorter label for the 390px bottom bar, where the tabs share the width. */
  shortLabel?: string
  icon: NavIconName
  aliases: string[]
  gate?: NavGate
}

interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'primary',
    label: 'Work',
    items: [
      // Talking to a bot is how most people use the product, so it leads. Gated on the page being in
      // the build. The href stays /chat (obj 900327): the label was renamed, the URL is a bookmark.
      { href: '/chat',      label: 'Bots',           icon: 'chat',  aliases: [],        gate: 'chat' },
      { href: '/',          label: 'Board',          icon: 'board', aliases: [] },
      // obj 900675: labels renamed (Knowledge base → Context, Jobs → Workflows). The URLs stay
      // /knowledge and /jobs — they are bookmarks and deep-link targets.
      { href: '/knowledge', label: 'Context',        icon: 'docs',  aliases: ['/docs'] },
      // Worst case (admin) is Bots, Board, Context, Workflows = 4 tabs at 390px.
      { href: JOBS_ROUTE,   label: 'Workflows',      icon: 'jobs',  aliases: [],        gate: 'admin' },
    ],
  },
]

/** One row of the avatar dropdown. */
export interface AccountMenuItem {
  href: string
  label: string
  icon: NavIconName
  /** Other paths that should light this row up (old URLs that redirect here). */
  aliases: string[]
  /** 'admin' rows are shown to global admins only. */
  section: 'account' | 'admin'
}

export const ACCOUNT_MENU: AccountMenuItem[] = [
  { href: '/settings',   label: 'Settings', icon: 'config',    aliases: [],                          section: 'account' },
  { href: SYSTEM_ROUTE,  label: 'System',   icon: 'dashboard', aliases: [...LEGACY_SYSTEM_ROUTES],    section: 'admin' },
  { href: AGENTS_ROUTE,  label: 'Bot setup', icon: 'system',    aliases: ['/agent-templates'],         section: 'admin' },
]


interface PaletteEntry {
  label: string
  keywords?: string[]
  onSelect: () => void
}

/** Extra words a palette row answers to — old names and close synonyms. */
const PALETTE_KEYWORDS: Record<string, string[]> = {
  '/chat': ['chat', 'assistant'],
  '/': ['cards', 'kanban', 'home'],
  '/knowledge': ['knowledge base', 'docs', 'notes', 'wiki'],
  [JOBS_ROUTE]: ['jobs', 'routines', 'runs'],
  '/settings': ['preferences', 'models', 'api', 'mcp', 'branding'],
  [SYSTEM_ROUTE]: ['health', 'status'],
  [AGENTS_ROUTE]: ['agents', 'bots & skills', 'skills', 'registry'],
}

/** One row per label: the first one wins (the gated nav order). */
export function dedupePaletteItems<T extends { label: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter(i => {
    const k = i.label.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Pages that read the org selection, and so show the top-bar org switcher
 * (obj 900666): the board family plus Knowledge, Jobs and Agents.
 */
export function isOrgScopedPath(path: string): boolean {
  return path === '/' || path === '/archive'
    || /^\/w\/[\w-]+\/?$/.test(path)
    || /^\/o\/\d+\/?$/.test(path)
    || path === '/knowledge' || path.startsWith('/knowledge/')
    || path === JOBS_ROUTE || path === AGENTS_ROUTE
}

/**
 * Context (obj 900867): reaching for its link starts loading the page and its
 * data, so the click lands on a page that is already on its way.
 */
const CONTEXT_PREFETCH = { onPointerEnter: prefetchContext, onFocus: prefetchContext, onTouchStart: prefetchContext }
function prefetchProps(href: string) {
  return href === '/knowledge' ? CONTEXT_PREFETCH : undefined
}

/** Visible height (keyboard open) under which the phone top bar also steps aside (obj 901376). */
const TIGHT_VISIBLE_PX = 520

export function Layout({ children, selectedWorkspaces, onWorkspacesChange, pageScroll = false }: LayoutProps) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { workspaces: orgRecords, loading: orgsLoading, refresh: refreshOrgs, shortOf } = useWorkspaces()
  const currentPath = window.location.pathname
  // obj 901376: the phone keyboard covers the bottom of the layout viewport
  // without resizing it. While it is up the shell shrinks to the visible
  // height (fixed-height pages only; a page-scroll route scrolls the document
  // as before) and the bottom tab bar steps aside.
  const keyboard = useOnScreenKeyboard()
  const shellHeight = pageScroll ? null : keyboard.height
  const tightForTyping = shellHeight !== null && shellHeight < TIGHT_VISIBLE_PX
  useEffect(() => {
    if (shellHeight === null) return
    // iOS Safari also pans the page up to reveal the focused field. The shell
    // already fits the visible area, so that pan only pushes the top bar off
    // screen: put the page back at the top whenever it happens.
    const vv = window.visualViewport
    const pin = () => { if (window.scrollY !== 0 || (vv && vv.offsetTop !== 0)) window.scrollTo(0, 0) }
    pin()
    vv?.addEventListener('scroll', pin)
    window.addEventListener('scroll', pin)
    return () => {
      vv?.removeEventListener('scroll', pin)
      window.removeEventListener('scroll', pin)
    }
  }, [shellHeight])

  // Intercept plain left-clicks on nav anchors → in-app navigation (no reload).
  // Modified clicks (cmd/ctrl/shift/alt) and non-primary buttons fall through to
  // the real <a href> so middle/cmd-click still opens a new tab and URLs stay
  // shareable. Closes any open menus on a successful in-app nav.
  const onNavClick = (href: string) => (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented) return
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(href)
    setUserMenu(null)
  }
  const isAdmin = user?.role === 'admin'
  const { theme, toggleTheme } = useBoardTheme()
  const brandName = useBranding().name
  // The org switcher sits in the top bar next to "Jump to" and scopes the
  // whole app (obj 900666). It shows on every page that reads the selection:
  // the board family (/, /w/<org>, /o/<id>, /archive) plus Knowledge, Jobs
  // and Agents, which take the single selected org from App.tsx. Settings and
  // admin pages do not read it, so a control there would do nothing.
  const showWorkspace = isOrgScopedPath(currentPath)

  const canSeeSettings = useMemo(() => {
    if (isAdmin) return true
    return user?.workspaces?.some(w => w.role === 'admin') ?? false
  }, [isAdmin, user?.workspaces])

  // Apply permission gating once, against the single nav model.
  const gatePass = (item: NavItem) => {
    if (item.gate === 'admin') return isAdmin
    if (item.gate === 'chat') return HAS_CHAT_PAGE
    return true
  }

  const navItems = useMemo(
    () => NAV_GROUPS.flatMap(g => g.items.filter(gatePass)),
    [isAdmin]
  )

  // Avatar dropdown rows the caller may see: account rows for everyone, the
  // Admin section for global admins only (same gate the items had under "More").
  const accountRows = useMemo(() => ACCOUNT_MENU.filter(i => i.section === 'account'), [])
  const adminRows = useMemo(() => (isAdmin ? ACCOUNT_MENU.filter(i => i.section === 'admin') : []), [isAdmin])

  const isActive = (item: NavItem) => {
    if (item.href === '/') return currentPath === '/' || /^\/w\//.test(currentPath) || /^\/o\//.test(currentPath)
    return currentPath === item.href || item.aliases.includes(currentPath)
  }
  const isMenuActive = (item: AccountMenuItem) =>
    currentPath === item.href || currentPath.startsWith(item.href + '/') || item.aliases.includes(currentPath)
  const menuActive = [...accountRows, ...adminRows].some(isMenuActive)

  // Organizations this caller may switch between. Admins see every org; a
  // member only the ones they belong to.
  const orgChoices = useMemo(() => {
    const memberSlugs = new Set((user?.workspaces ?? []).map(w => w.workspace))
    return (orgRecords ?? [])
      .filter(w => isAdmin || memberSlugs.has(w.slug))
      .map(w => ({ slug: w.slug, label: w.name || w.slug, short: shortOf(w.slug) }))
    // shortOf reads orgRecords, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgRecords, isAdmin, user?.workspaces])
  // A member of exactly one org has nothing to switch to. Admins always get the
  // switcher — it is also where they create an organization (obj 900197 was
  // the bug where it vanished for an admin with a single org).
  const hideWorkspaceSelector = !isAdmin && orgChoices.length <= 1
  const createOrg = async (name: string, slug: string) => {
    await api.post('/admin/workspaces', { slug, name })
    // The roster is cached process-wide; drop it so the new org appears.
    invalidateWorkspacesCache()
    await refreshOrgs()
  }
  const orgSwitcherProps = {
    organizations: orgChoices,
    selected: selectedWorkspaces as string[],
    onChange: (next: string[]) => onWorkspacesChange(next as Workspace[]),
    canCreate: isAdmin,
    onCreate: createOrg,
    loading: orgsLoading,
  }

  // Which avatar menu is open. Desktop and mobile each have their own trigger.
  const [userMenu, setUserMenu] = useState<'desktop' | 'mobile' | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteShortcut = useMemo(() => commandPaletteShortcut(), [])

  // ⌘K / Ctrl+K — desktop only via media-query gate; we still listen everywhere
  // but the palette UI is hidden under <sm anyway.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // ⌘K palette lists the full gated nav set: primary bar, avatar menu, then a
  // few deep links. Plain names only (obj 900807): no URL paths on screen, and
  // each page once — the old list showed /settings paths and two Settings rows.
  // Old names (Knowledge, Jobs…) still match through keywords.
  const paletteItems = useMemo(() => {
    const items: PaletteEntry[] = [...navItems, ...accountRows, ...adminRows].map(n => ({
      label: n.label,
      keywords: PALETTE_KEYWORDS[n.href],
      onSelect: () => { navigate(n.href) },
    }))
    items.push({ label: 'Integrations', keywords: ['connectors', 'github', 'google'], onSelect: () => { navigate('/settings/integrations') } })
    if (canSeeSettings) {
      items.push({ label: 'Secrets', keywords: ['keys', 'credentials'], onSelect: () => { navigate('/settings/secrets') } })
    }
    if (isAdmin) {
      items.push(
        { label: 'Workspace settings', keywords: ['users', 'members'], onSelect: () => { navigate('/settings/workspaces') } },
        { label: 'Bot templates', keywords: ['starter', 'import'], onSelect: () => { navigate(agentsTabRoute('templates')) } },
      )
    }
    return dedupePaletteItems(items)
  }, [navItems, accountRows, adminRows, canSeeSettings, isAdmin, navigate])

  // The avatar dropdown, identical on desktop and mobile, on the UI SDK menu
  // behavior (obj 900819): arrows, typeahead, Escape, focus back to the avatar.
  // Rows stay real links, so Cmd/middle-click still opens a new tab.
  const renderAccountMenu = (username: string) => (
    <MenuContent aria-label="Account" side="bottom" align="end" className="w-60">
      <MenuGroup>
        <MenuGroupLabel className="mb-1 border-b border-line-soft px-2.5 pb-2">
          <span className="block text-base font-medium text-fg-0">{username}</span>
          {/* No role pill (obj 900807): it was a lowercase "admin" in the review
              colour, which read as a status. The admin rows below already say it. */}
        </MenuGroupLabel>
        {[...accountRows, ...adminRows].map(item => {
          const active = isMenuActive(item)
          return (
            <MenuItem
              key={item.href}
              value={item.href}
              label={item.label}
              current={active}
              icon={<NavIcon name={item.icon} variant={active ? 'solid' : 'outline'} className="h-4 w-4" />}
              onSelect={() => navigate(item.href)}
              render={<a href={item.href} onClick={e => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) e.preventDefault() }} />}
            >
              {item.label}
            </MenuItem>
          )
        })}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem value="logout" label="Log out" onSelect={() => logout()}>
        Log out
      </MenuItem>
    </MenuContent>
  )

  return (
    // overflow-x-hidden: platform-wide guarantee that no route can introduce a
    // horizontal scrollbar at 390px (the W8 mobile-clean shell constraint).
    // In page-scroll mode it is overflow-x-clip instead: same guarantee, but
    // clip does not make this div a scroll container, so the document scrolls
    // and the sticky top bars stick to the viewport.
    <div
      data-scroll-mode={pageScroll ? 'page' : 'container'}
      data-keyboard={keyboard.open ? 'open' : undefined}
      className={pageScroll
        ? 'flex min-h-full flex-col overflow-x-clip bg-surface-0'
        : 'flex h-full flex-col overflow-x-hidden bg-surface-0'}
      // obj 901376: with the phone keyboard up, the fixed-height shell is as
      // tall as the VISIBLE viewport, so a page's composer sits on the keyboard.
      style={shellHeight !== null ? { height: shellHeight } : undefined}
    >
      {/* ── Desktop top bar ──
          Stable chrome (obj 900807): a 1fr | auto | 1fr grid, so "Jump to
          page" sits in the exact middle of the bar on every page. The org
          switcher lives in the RIGHT cluster: when it hides (Bots, Settings,
          System) only that cluster changes, never the search. Below xl the nav
          drops to icons (label kept for screen readers + tooltip) so the left
          column never spills into the middle one. */}
      <header
        data-testid="desktop-top-bar"
        className={`${pageScroll ? 'sticky top-0 z-30 ' : ''}hidden grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-line bg-surface-0 px-5 py-2 sm:grid`}
      >
        {/* Left: brand + primary nav */}
        <nav aria-label="Primary" className="flex min-w-0 items-center gap-0.5 justify-self-start">
          <a href="/" aria-label={`${brandName} home`} onClick={onNavClick('/')} className="mr-3 flex min-w-0 items-center rounded-md">
            <span className="lg:hidden"><BrandLogo theme={theme} size="sm" showName={false} allowWordmark={false} /></span>
            <span className="hidden lg:flex"><BrandLogo theme={theme} size="sm" /></span>
          </a>
          {navItems.map(item => {
            const active = isActive(item)
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={onNavClick(item.href)}
                {...prefetchProps(item.href)}
                aria-current={active ? 'page' : undefined}
                title={item.label}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/60 ${
                  active ? 'bg-surface-selected text-fg-0' : 'text-fg-2 hover:bg-surface-3 hover:text-fg-0'
                }`}
              >
                <NavIcon name={item.icon} variant={active ? 'solid' : 'outline'} className={`h-3.5 w-3.5 ${active ? 'text-accent' : ''}`} />
                <span className="sr-only xl:not-sr-only">{item.label}</span>
              </a>
            )
          })}
        </nav>

        {/* Center: ⌘K / Ctrl K "Jump to page". It goes to PAGES; finding a
            CARD is the board's "Search cards" (/). Both labels say which is
            which. Nothing else shares this column, so it never moves. */}
        <div data-testid="top-bar-center" className="flex items-center justify-center">
          <button
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-fg-2 outline-none transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label="Jump to a page (command palette)"
            title={`Jump to a page or setting (${paletteShortcut}). To find a card, use Search cards on the board (/).`}
          >
            <NavIcon name="search" className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Jump to page…</span>
            <kbd data-testid="palette-shortcut" className="font-sans text-xs text-fg-3">{paletteShortcut}</kbd>
          </button>
        </div>

        {/* Right: the org switcher (pages that read it), notifications, theme,
            avatar menu (Settings, then System / Agents for admins). */}
        <div className="flex min-w-0 items-center justify-end gap-1 justify-self-end">
          {showWorkspace && !hideWorkspaceSelector && (
            <div data-testid="top-bar-workspace" className="mr-1 min-w-0">
              <OrgSwitcher {...orgSwitcherProps} align="right" triggerClassName="text-xs max-w-[10rem] lg:max-w-[16rem]" />
            </div>
          )}
          {user && (
            <>
            <NeedsYouBadge active={currentPath === NEEDS_YOU_ROUTE} onClick={onNavClick(NEEDS_YOU_ROUTE)} />
            <AlertBell />
            <IconButton
              label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              onClick={toggleTheme}
              className="text-fg-2"
            >
              {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </IconButton>
          <Menu open={userMenu === 'desktop'} onOpenChange={o => setUserMenu(o ? 'desktop' : null)}>
            <MenuTrigger
              aria-label="Account menu"
              className={`inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-base outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/60 ${
                menuActive || userMenu === 'desktop' ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:bg-surface-3 hover:text-fg-0'
              }`}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface-3 text-xs font-semibold text-fg-1">
                {user.username[0].toUpperCase()}
              </span>
              <span className="hidden lg:inline">{user.username}</span>
              <NavIcon name="chevron" className="h-3 w-3 text-fg-3" />
            </MenuTrigger>
            {renderAccountMenu(user.username)}
          </Menu>
            </>
          )}
        </div>
      </header>

      {/* ── Mobile top bar (minimal) ── */}
      {/* obj 901376: on a short screen the keyboard leaves ~330px (iPhone, Safari
          bars showing). The page being typed in needs all of it, so this bar
          steps aside until the keyboard closes. */}
      <header className={`${pageScroll ? 'sticky top-0 z-30 ' : ''}${tightForTyping ? 'hidden' : 'flex'} items-center justify-between border-b border-line bg-surface-0 px-3 py-0.5 sm:hidden`}
        style={{ paddingTop: 'calc(0.125rem + env(safe-area-inset-top))' }}
      >
        <a href="/" aria-label={`${brandName} home`} onClick={onNavClick('/')} className="flex min-w-0 items-center rounded-md">
          <BrandLogo theme={theme} size="sm" showName={false} allowWordmark={false} />
        </a>

        {showWorkspace && !hideWorkspaceSelector && (
          <OrgSwitcher {...orgSwitcherProps} triggerClassName="text-xs py-1 max-w-[11rem]" />
        )}

        {user && (
          <div className="flex items-center">
            <NeedsYouBadge active={currentPath === NEEDS_YOU_ROUTE} onClick={onNavClick(NEEDS_YOU_ROUTE)} />
            <AlertBell />
            {/* 44px tap target on the phone bar (obj 900807); IconButton is 44px below sm. */}
            <IconButton
              size="sm"
              label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              onClick={toggleTheme}
              className="text-fg-2"
            >
              {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </IconButton>
          <Menu open={userMenu === 'mobile'} onOpenChange={o => setUserMenu(o ? 'mobile' : null)}>
            <MenuTrigger
              aria-label="Account menu"
              // 44px tap target (obj 900807); the visible circle stays 28px.
              className="group flex h-11 w-11 items-center justify-center rounded-full outline-none"
            >
              <span className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold text-fg-1 ${
                menuActive || userMenu === 'mobile' ? 'border-line-strong bg-surface-4' : 'border-line bg-surface-3'
              }`}>
                {user.username[0].toUpperCase()}
              </span>
            </MenuTrigger>
            {renderAccountMenu(user.username)}
          </Menu>
          </div>
        )}
      </header>

      {/* ── Main content ── */}
      <main className={`flex-1 ${pageScroll ? '' : 'overflow-hidden '}${keyboard.open ? '' : 'pb-[calc(3.5rem+env(safe-area-inset-bottom))] '}sm:pb-0`}>{children}</main>

      {/* ── Mobile bottom tab bar (≤4 tabs; the rest lives in the avatar menu) ── */}
      <nav
        aria-label="Primary"
        // obj 901376: gone while the phone keyboard is up — it was drawn half
        // behind the keyboard and took room from the page; back when it closes.
        className={`fixed bottom-0 left-0 right-0 z-40 border-t border-line bg-surface-1 sm:hidden${keyboard.open ? ' hidden' : ''}`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-stretch">
          {navItems.map(item => {
            const active = isActive(item)
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={onNavClick(item.href)}
                {...prefetchProps(item.href)}
                aria-current={active ? 'page' : undefined}
                aria-label={item.shortLabel ? item.label : undefined}
                className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors duration-fast ease-out ${
                  active ? 'text-fg-0' : 'text-fg-2'
                }`}
                style={{ minHeight: 44 }}
              >
                <NavIcon name={item.icon} variant={active ? 'solid' : 'outline'} className={`h-5 w-5 ${active ? 'text-accent' : ''}`} />
                <span className="text-xs font-medium">{item.shortLabel ?? item.label}</span>
              </a>
            )
          })}
        </div>
      </nav>

      {/* ⌘K palette — desktop only via the CSS gate; on mobile it never appears
          because the only entry point is the keyboard shortcut. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
        onOpenCard={id => navigate(`/o/${id}`)}
      />
    </div>
  )
}
