// ── app_routes: where things are in the app, for chat bots (obj 901493) ──
//
// A bot cannot see the web app, so a click path it gives ("Settings → Platform
// → Queue auto-start") used to come from old notes and went stale when a page
// moved. This tool answers from the APP MAP, which is generated from the
// client's real router, navigation and page components
// (shared/app-map.generated.json; a CI test fails when it is out of date).
//
// Why a tool and not a block in the system prompt: the whole map is about
// 5,500 tokens as JSON (about 1,500 even as a bare outline), and a prompt block
// is paid on EVERY turn of every bot that has it. The tool costs its description
// and one prompt line (about 200 tokens) per turn, and 100 to 300 tokens only on
// the turns that actually need a click path.
//
// Read-only and static: page names, paths, headings and field labels from the
// client source. No secrets, no user data, no database.
import fs from 'fs'
import { fileURLToPath } from 'url'
import type { AppMap, AppMapAudience, AppMapPage } from '../../../../shared/app-map.js'

let cached: AppMap | null = null
/** The shipped map, read once. The file is generated data, so it is JSON and not a module. */
export function loadAppMap(): AppMap {
  cached ??= JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../../shared/app-map.generated.json', import.meta.url)), 'utf8')) as AppMap
  return cached
}

/** The agent-file / bot-page name of the tool, and its one function. */
export const APP_ROUTES_TOOL = 'app_routes'
/** The bot that always has it: the one people ask "where do I set this up?". */
export const APP_ROUTES_DEFAULT_BOTS: readonly string[] = ['operation-kit-dev']

export const APP_ROUTES_DESCRIPTION =
  'Where a page, tab or setting is in this app RIGHT NOW: the exact click path (for example "Workflows > Runs > Queue auto-start"), its address, and whether only admins see it. '
  + 'Call it BEFORE you tell anyone where to click or which page to open, and repeat the path it returns word for word; never give a click path from memory or from an old note. '
  + 'Pass `query` (a page, panel or setting name, or an old path you are unsure of). With no query it lists every page.'

export const APP_ROUTES_PROMPT_LINE =
  '- Before you tell the person where to click, look the page or setting up with app_routes and give the path it returns. Pages move; a path from memory or from an old note may no longer exist. If app_routes does not list it, say you cannot find it instead of guessing.'

export interface AppRouteMatch {
  /** What to click, in order. */
  path: string
  kind: 'page' | 'tab' | 'panel' | 'moved'
  /** The page's own name, when the path alone does not say it (a card, the archive). */
  page?: string
  /** Address to open (relative to the site). */
  url?: string
  who?: 'admins only' | 'everyone signed in'
  about?: string
  /** Field labels under this heading. */
  fields?: string[]
  /** For a page with no menu entry: how to get there. */
  how?: string
}

export interface AppRoutesResult {
  query: string | null
  matches: AppRouteMatch[]
  note?: string
}

const MAX_MATCHES = 8
const who = (a: AppMapAudience): AppRouteMatch['who'] => (a === 'admin' ? 'admins only' : 'everyone signed in')
const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1)
/** Words of a question that name nothing. */
const STOP = new Set(['where', 'do', 'does', 'is', 'are', 'the', 'an', 'to', 'in', 'on', 'of', 'for', 'how', 'my', 'can', 'find', 'what', 'page', 'add', 'change', 'it', 'and', 'or'])

interface Entry { match: AppRouteMatch; name: string; context: string; extra: string }

function clickPath(page: AppMapPage, trail: string[] = [], leaf?: string): string {
  const parts = [...page.click_path, ...trail, ...(leaf ? [leaf] : [])]
  return parts.length ? parts.join(' > ') : page.title
}

function pageMatch(page: AppMapPage): AppRouteMatch {
  const path = clickPath(page)
  return {
    path,
    kind: 'page',
    ...(path.split(' > ').pop() !== page.title ? { page: page.title } : {}),
    url: page.path,
    who: who(page.audience),
    ...(page.how ? { how: page.how } : {}),
  }
}

function pageByPath(map: AppMap, url: string): AppMapPage | undefined {
  const bare = url.split(/[?#]/)[0]
  return map.pages.find(p => p.path === bare)
}

function entries(map: AppMap): Entry[] {
  const out: Entry[] = []
  for (const page of map.pages) {
    out.push({ match: pageMatch(page), name: `${page.title} ${page.path}`, context: page.click_path.join(' '), extra: page.how ?? '' })
    for (const tab of page.tabs) {
      out.push({
        match: { path: clickPath(page, tab.trail, tab.label), kind: 'tab', url: `${page.path}${tab.url ?? ''}`, who: who(tab.audience) },
        name: tab.label,
        context: [...page.click_path, ...tab.trail, page.title].join(' '),
        extra: '',
      })
    }
    for (const panel of page.panels) {
      const tab = page.tabs.find(t => t.label === panel.trail[panel.trail.length - 1] && t.url)
      out.push({
        match: {
          path: clickPath(page, [...panel.trail, ...(panel.under ?? [])], panel.name),
          kind: 'panel',
          url: `${page.path}${tab?.url ?? ''}`,
          who: who(panel.audience),
          ...(panel.description ? { about: panel.description } : {}),
          ...(panel.settings?.length ? { fields: panel.settings } : {}),
          ...(page.how && page.click_path.length ? { how: page.how } : {}),
        },
        name: panel.name,
        context: [...page.click_path, ...panel.trail, ...(panel.under ?? []), page.title].join(' '),
        extra: `${(panel.settings ?? []).join(' ')} ${panel.description ?? ''}`,
      })
    }
  }
  for (const r of map.redirects) {
    const target = pageByPath(map, r.to)
    out.push({
      match: {
        path: target ? clickPath(target) : r.to,
        kind: 'moved',
        url: r.to,
        about: `The old address ${r.from} no longer has a page of its own. It now opens ${r.to}${target ? ` (${clickPath(target)})` : ''}.`,
        ...(target ? { who: who(target.audience) } : {}),
      },
      name: r.from,
      context: '',
      extra: r.to,
    })
  }
  return out
}

function score(e: Entry, q: string[], phrase: string): number {
  const name = tokens(e.name)
  const context = tokens(e.context)
  const extra = tokens(e.extra)
  let total = 0
  let inName = 0
  for (const t of q) {
    const hit = (list: string[]) => list.some(w => w === t || (t.length > 3 && w.startsWith(t)))
    if (hit(name)) { total += 4; inName++ } else if (hit(extra)) total += 2
    else if (hit(context)) total += 1
    else total -= 1
  }
  // A match must name the thing itself (or one of its fields), not only the page it is on.
  if (inName === 0 && !q.some(t => extra.includes(t))) return 0
  if (phrase && e.name.toLowerCase().includes(phrase)) total += 4
  if (inName === q.length) total += 2
  return total
}

/** Search the app map. Exported for tests; the tool calls it with the shipped map. */
export function searchAppMap(queryRaw: unknown, map: AppMap = loadAppMap()): AppRoutesResult {
  const query = typeof queryRaw === 'string' ? queryRaw.trim().slice(0, 200) : ''
  if (!query) {
    return {
      query: null,
      matches: map.pages.filter(p => !p.same_as).map(pageMatch),
      note: 'Every page of the app. Call app_routes again with a query (a panel or setting name) for the tabs, panels and fields on one.',
    }
  }
  const all = [...new Set(tokens(query))]
  const q = all.some(t => !STOP.has(t)) ? all.filter(t => !STOP.has(t)) : all
  const phrase = query.toLowerCase().replace(/\s+/g, ' ')
  const ranked = entries(map)
    .map(e => ({ e, s: score(e, q, phrase) }))
    // At least a field-level hit per word asked for: half a match is a guess.
    .filter(x => x.s >= 2 * q.length)
    .sort((a, b) => b.s - a.s)
  // Only what is about as good as the best match: a near miss beside the answer reads as a second answer.
  const matches = ranked.filter(x => x.s >= ranked[0].s * 0.6).slice(0, MAX_MATCHES).map(x => x.e.match)
  if (matches.length === 0) {
    return {
      query,
      matches: [],
      note: `Nothing in the app is called "${query}". Do not guess a path: say you cannot find it, or call app_routes with no query to see every page.`,
    }
  }
  const moved = matches.some(m => m.kind === 'moved')
  return {
    query,
    matches,
    note: `${moved ? 'A "moved" match is an OLD address: send the person to the path it now opens, never to the old one. ' : ''}Give the path exactly as written, each step separated by " > ".`,
  }
}

/** One-line summary for the chat's tool line. */
export function appRoutesSummary(r: AppRoutesResult): string {
  if (!r.query) return `Looked up the app's pages (${r.matches.length})`
  return r.matches.length ? `Looked up "${r.query}" in the app (${r.matches[0].path})` : `Looked up "${r.query}" in the app (not found)`
}
