/**
 * App map generator (obj 901493). Node only: used by the CLI
 * (`client/scripts/gen-app-map.ts`) and by the staleness test. Never imported
 * by the app itself.
 *
 * It reads the client SOURCE with the TypeScript parser, so the map follows the
 * code and not somebody's notes:
 *
 *   App.tsx      every <Route>: pages, nested (tab) routes, redirects
 *   Layout.tsx   NAV_GROUPS (the main menu) and ACCOUNT_MENU (the avatar menu)
 *   each page    walked from the route's component down through the components
 *                it renders: <Tabs> sets, `tab === 'x' && …` branches, admin
 *                guards, section headings (<SettingsSection title>, <h2>, <h3>)
 *                and the field labels under them
 *
 * The one thing code cannot say is how a person reaches a page that is not a
 * menu entry (a card, the archive). Those few lines are ROUTE_NOTES below; the
 * staleness test fails when a note names a route that no longer exists, or a
 * new unlinked page has no note.
 */
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import * as routeConsts from '../routes'
import type { AppMap, AppMapAudience, AppMapPage, AppMapPanel, AppMapRedirect, AppMapTab } from '../../../../shared/app-map'

/** Label of the avatar dropdown in click paths. */
export const AVATAR_MENU = 'Avatar menu (top right)'

/**
 * How to reach a page that has no menu entry of its own. `click` is the click
 * path (menu labels must be real ones: the test checks them against the nav).
 */
export const ROUTE_NOTES: Record<string, { click: string[]; title?: string; how: string }> = {
  // A menu page: its click path comes from the menu, the note only adds where its settings are.
  '/chat': { click: [], how: 'Pick a bot in the list. Bot settings (model and tools, workspace access, Full access, approvals, High Agency, card wakes) open with the Settings button in the header of that bot\'s chat.' },
  '/w/:ws': { click: ['Board'], title: 'Board (one workspace)', how: 'Pick one workspace in the workspace switcher at the top of the Board.' },
  '/o/:id': { click: ['Board'], title: 'Card', how: 'Open a card on the Board (or paste its number into search).' },
  '/archive': { click: ['Board'], title: 'Archive', how: 'On the Board, press Archive to see finished and cancelled cards.' },
  '/chat/:slug': { click: ['Bots'], title: 'Bots (one bot)', how: 'Pick a bot in the list on the Bots page. Its settings are behind the Settings button of that bot.' },
  '/knowledge/setup': { click: ['Context'], how: 'On the Context page, press Set up.' },
  '/needs-you': { click: [], title: 'Needs you', how: 'Press the Needs you badge in the top bar.' },
  '/setup': { click: [], title: 'Setup', how: 'First-run checklist. Open /setup directly; admins only.' },
  '/setup/email': { click: [], title: 'Setup (email step)', how: 'The email step of the first-run checklist. Open /setup/email directly; admins only.' },
}

/** Wrappers around a route's real page component. */
const ROUTE_WRAPPERS = new Set(['BoardShell', 'Suspense', 'ErrorBoundary'])
/** Subtrees that are not part of the page itself (they open on a click). */
const OVERLAY_TAG = /(^|[a-z])(Modal|Dialog|Drawer|Wizard|Popover|Tooltip|MenuContent|Overlay|Palette)$/
/** Shared primitives: read by tag name, never walked into. */
const UI_DIR = `${path.sep}components${path.sep}ui${path.sep}`
const FIELD_TAG = /(Field|Input|Select|Switch|Checkbox|Radio|Textarea|Toggle)$/
/**
 * The card viewer opens OVER a page (Board, Workflows, Bots) when a card is
 * clicked. It is described once, on the card page, not on every page that can open it.
 */
const CARD_VIEWER_TAG = /^(SessionViewer|ObjectiveModal|CardDecisionPanel)$/
const CARD_PAGE = '/o/:id'
const MAX_DEPTH = 10
const MAX_DESCRIPTION = 160

export interface GenerateOptions {
  /** `app/client/src` */
  srcDir: string
}

interface NavEntry { href: string; label: string; admin: boolean; menu: 'main' | 'avatar' }
interface TabDef { key: string; label: string; admin: boolean }
interface Ctx { trail: string[]; admin: boolean; depth: number; stack: string[] }
interface PageAcc { path: string; title?: string; admin: boolean; tabs: AppMapTab[]; panels: AppMapPanel[]; scopes: { node: ts.Node; panel: AppMapPanel; level: number }[] }
interface ComponentRef { file: string; name: string; node: ts.Node }

export function generateAppMap(opts: GenerateOptions): AppMap {
  const src = opts.srcDir
  const cache = new Map<string, ts.SourceFile>()
  const undescribed = new Set<string>()

  function parse(file: string): ts.SourceFile {
    let sf = cache.get(file)
    if (!sf) {
      sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      cache.set(file, sf)
    }
    return sf
  }
  const rel = (file: string) => path.relative(src, file).split(path.sep).join('/')

  function resolveModule(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null
    const base = path.resolve(path.dirname(fromFile), spec)
    for (const c of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    }
    return null
  }

  // ── tiny evaluator for route paths: literals, routes.ts constants, templates ──
  function evalExpr(node: ts.Node | undefined, env: Record<string, unknown> = {}): unknown {
    if (!node) return undefined
    if (ts.isJsxExpression(node)) return evalExpr(node.expression, env)
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return evalExpr(node.expression, env)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isIdentifier(node)) return node.text in env ? env[node.text] : (routeConsts as Record<string, unknown>)[node.text]
    if (ts.isPropertyAccessExpression(node)) {
      const o = evalExpr(node.expression, env)
      return o && typeof o === 'object' ? (o as Record<string, unknown>)[node.name.text] : undefined
    }
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text
      for (const span of node.templateSpans) {
        const v = evalExpr(span.expression, env)
        if (typeof v !== 'string') return undefined
        out += v + span.literal.text
      }
      return out
    }
    // `HAS_CHAT_PAGE ? '/chat' : '/'`: the map describes the full build.
    if (ts.isConditionalExpression(node)) return evalExpr(node.whenTrue, env)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = (routeConsts as Record<string, unknown>)[node.expression.text]
      const args = node.arguments.map(a => evalExpr(a, env))
      if (typeof fn === 'function' && args.every(a => a !== undefined)) return (fn as (...a: unknown[]) => unknown)(...args)
    }
    return undefined
  }

  // ── JSX helpers ──
  type Jsx = ts.JsxElement | ts.JsxSelfClosingElement
  const isJsx = (n: ts.Node): n is Jsx => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)
  const opening = (n: Jsx) => (ts.isJsxElement(n) ? n.openingElement : n)
  const tagOf = (n: Jsx) => opening(n).tagName.getText()
  function attr(n: Jsx, name: string): ts.JsxAttribute | undefined {
    return opening(n).attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name)
  }
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  /** Static text of an attribute / element, or null when any part is computed. */
  function staticAttr(n: Jsx, name: string): string | null {
    const a = attr(n, name)
    if (!a?.initializer) return null
    if (ts.isStringLiteral(a.initializer)) return squash(a.initializer.text)
    if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
      const e = a.initializer.expression
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return squash(e.text)
      if (isJsx(e) || ts.isJsxFragment(e)) return staticText(e)
    }
    return null
  }
  /**
   * A heading's own words. Icons and counters beside them (`<span>{n}</span>`,
   * `{!loading && <span>…</span>}`) are dropped; a heading whose WORDS are
   * computed (`{flow.name}`, `Ask {botName}`) is null.
   */
  function staticText(n: ts.Node): string | null {
    if (!ts.isJsxElement(n) && !ts.isJsxFragment(n)) return null
    let out = ''
    for (const c of n.children) {
      if (ts.isJsxText(c)) out += c.text
      else if (ts.isJsxExpression(c)) {
        if (!c.expression) continue // a comment
        if (ts.isStringLiteral(c.expression) || ts.isNoSubstitutionTemplateLiteral(c.expression)) out += c.expression.text
        else if (!containsJsx(c.expression)) return null
      } else if (ts.isJsxElement(c)) {
        const inner = staticText(c)
        if (inner) out += ` ${inner} `
      }
      // self-closing children are icons: no text
    }
    return squash(out) || null
  }
  function containsJsx(n: ts.Node): boolean {
    if (isJsx(n) || ts.isJsxFragment(n)) return true
    return !!ts.forEachChild(n, c => containsJsx(c) || undefined)
  }

  // ── admin guards ──
  /** +1 = true only for an admin, -1 = true only for a non-admin, 0 = says nothing. */
  function adminPolarity(test: ts.Expression): number {
    let e: ts.Expression = test
    let sign = 1
    while (ts.isParenthesizedExpression(e) || (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken)) {
      if (ts.isPrefixUnaryExpression(e)) sign = -sign
      e = ts.isPrefixUnaryExpression(e) ? e.operand : e.expression
    }
    if (ts.isIdentifier(e) && /^(isAdmin|isGlobalAdmin)$/.test(e.text)) return sign
    if (ts.isBinaryExpression(e) && /role$/.test(e.left.getText()) && ts.isStringLiteral(e.right) && e.right.text === 'admin') {
      if (e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return sign
      if (e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return -sign
    }
    return 0
  }
  function conjuncts(e: ts.Expression): ts.Expression[] {
    if (ts.isParenthesizedExpression(e)) return conjuncts(e.expression)
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [...conjuncts(e.left), ...conjuncts(e.right)]
    return [e]
  }

  // ── tab sets: arrays of { key, label } handed to <Tabs items={…}> ──
  const tabSetCache = new Map<string, Map<string, TabDef[]>>()
  function tabArrays(file: string): Map<string, TabDef[]> {
    const hit = tabSetCache.get(file)
    if (hit) return hit
    const sf = parse(file)
    const consts = new Map<string, string>()
    const out = new Map<string, TabDef[]>()
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        if (ts.isStringLiteral(n.initializer)) consts.set(n.name.text, n.initializer.text)
        const defs: TabDef[] = []
        const collect = (m: ts.Node, admin: boolean) => {
          if (ts.isConditionalExpression(m)) {
            const pol = adminPolarity(m.condition)
            collect(m.whenTrue, admin || pol > 0)
            collect(m.whenFalse, admin || pol < 0)
            return
          }
          if (ts.isObjectLiteralExpression(m)) {
            const prop = (k: string) => m.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === k)?.initializer
            const k = prop('key')
            const l = prop('label')
            const key = k && (ts.isStringLiteral(k) ? k.text : ts.isIdentifier(k) ? consts.get(k.text) : undefined)
            if (key && l && ts.isStringLiteral(l)) {
              const dup = defs.find(d => d.key === key)
              if (dup) dup.admin = dup.admin && admin
              else defs.push({ key, label: l.text, admin })
              return
            }
          }
          ts.forEachChild(m, c => collect(c, admin))
        }
        collect(n.initializer, false)
        if (defs.length >= 2) out.set(n.name.text, defs)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    tabSetCache.set(file, out)
    return out
  }
  /**
   * The tab sets a component switches on: its <Tabs items={X}> (listed as the
   * page's tabs) and any <SegmentedControl items={X}> (a second-level choice,
   * listed only when a branch of the page depends on it).
   */
  function tabsOf(ref: ComponentRef): { defs: TabDef[]; primary: boolean }[] {
    const arrays = tabArrays(ref.file)
    const found: { defs: TabDef[]; primary: boolean }[] = []
    const visit = (n: ts.Node) => {
      if (isJsx(n) && (tagOf(n) === 'Tabs' || tagOf(n) === 'SegmentedControl')) {
        const items = attr(n, 'items')?.initializer
        const id = items && ts.isJsxExpression(items) && items.expression && ts.isIdentifier(items.expression) ? items.expression.text : null
        const defs = id ? arrays.get(id) : undefined
        if (defs && !found.some(f => f.defs === defs)) found.push({ defs, primary: tagOf(n) === 'Tabs' })
      }
      ts.forEachChild(n, visit)
    }
    visit(ref.node)
    return found
  }

  // ── component resolution ──
  function unwrapFn(init: ts.Expression | undefined): ts.Node | null {
    if (!init) return null
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init
    // memo(...), forwardRef(...)
    if (ts.isCallExpression(init) && init.arguments.length && !/^lazy$/.test(init.expression.getText().replace(/^React\./, ''))) return unwrapFn(init.arguments[0] as ts.Expression)
    return null
  }
  function findComponent(file: string, name: string, hops = 0): ComponentRef | null {
    if (hops > 6) return null
    const sf = parse(file)
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) return { file, name, node: st }
      if (ts.isFunctionDeclaration(st) && name === 'default' && st.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) return { file, name: st.name?.text ?? 'default', node: st }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue
          const fn = unwrapFn(d.initializer)
          if (fn) return { file, name, node: fn }
          // const X = lazy(() => import('./x').then(m => ({ default: m.X })))
          const text = d.initializer.getText()
          const lazy = /^(?:React\.)?lazy\(/.test(text) ? /import\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\.then\(\s*\w+\s*=>\s*\(\{\s*default:\s*\w+\.(\w+)\s*\}\)\s*\))?/.exec(text) : null
          if (lazy) {
            const target = resolveModule(file, lazy[1])
            return target ? findComponent(target, lazy[2] ?? 'default', hops + 1) : null
          }
        }
      }
      if (ts.isExportAssignment(st) && name === 'default' && ts.isIdentifier(st.expression)) return findComponent(file, st.expression.text, hops + 1)
    }
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
        const clause = st.importClause
        let imported: string | null = null
        if (clause.name?.text === name) imported = 'default'
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          const el = clause.namedBindings.elements.find(e => e.name.text === name)
          if (el) imported = (el.propertyName ?? el.name).text
        }
        if (!imported) continue
        const target = resolveModule(file, st.moduleSpecifier.text)
        if (!target || target.includes(UI_DIR)) return null
        return findComponent(target, imported, hops + 1)
      }
      // export { X } from './X'  /  export * from './X'
      if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const target = resolveModule(file, st.moduleSpecifier.text)
        if (!target) continue
        if (!st.exportClause) { const r = findComponent(target, name, hops + 1); if (r) return r; continue }
        if (ts.isNamedExports(st.exportClause)) {
          const el = st.exportClause.elements.find(e => e.name.text === name)
          if (el) return findComponent(target, (el.propertyName ?? el.name).text, hops + 1)
        }
      }
    }
    return null
  }

  // ── walking one page ──
  function walkComponent(ref: ComponentRef, ctxIn: Ctx, acc: PageAcc): void {
    const id = `${ref.file}#${ref.name}`
    if (ctxIn.depth > MAX_DEPTH || ctxIn.stack.includes(id)) return
    let ctx: Ctx = { ...ctxIn, depth: ctxIn.depth + 1, stack: [...ctxIn.stack, id] }
    const tabs = tabsOf(ref)
    const sfText = parse(ref.file).text

    // `if (!isAdmin) return …` at the top of the component = an admin-only component.
    const body = (ref.node as ts.FunctionLikeDeclaration).body
    if (body && ts.isBlock(body)) {
      for (const st of body.statements) {
        if (ts.isIfStatement(st) && adminPolarity(st.expression) < 0 && /\breturn\b/.test(st.thenStatement.getText())) {
          ctx = { ...ctx, admin: true }
          if (ctx.trail.length === 0 && ctx.depth === 1) acc.admin = true
        }
      }
    }

    const noteTab = (def: TabDef, c: Ctx, variable: string | null): Ctx => {
      const audience: AppMapAudience = c.admin || def.admin ? 'admin' : 'everyone'
      const exists = acc.tabs.find(t => t.label === def.label && t.trail.join('>') === c.trail.join('>'))
      if (!exists) {
        const tab: AppMapTab = { label: def.label, trail: c.trail, audience }
        if (variable && new RegExp(`\\.get\\(\\s*['"]${variable}['"]\\s*\\)`).test(sfText)) tab.url = `?${variable}=${def.key}`
        acc.tabs.push(tab)
      } else if (!exists.url && variable && new RegExp(`\\.get\\(\\s*['"]${variable}['"]\\s*\\)`).test(sfText)) exists.url = `?${variable}=${def.key}`
      return { ...c, trail: [...c.trail, def.label], admin: c.admin || def.admin }
    }
    for (const set of tabs) if (set.primary) for (const def of set.defs) noteTab(def, ctx, null)

    /** The context inside a branch taken when `test` is `truthy`. */
    const branch = (test: ts.Expression, truthy: boolean, c: Ctx): Ctx => {
      let out = c
      const parts = truthy ? conjuncts(test) : [test]
      for (const p of parts) {
        const pol = adminPolarity(p)
        if ((truthy && pol > 0) || (!truthy && pol < 0)) out = { ...out, admin: true }
        if (!tabs.length) continue
        let e: ts.Expression = p
        while (ts.isParenthesizedExpression(e)) e = e.expression
        if (!ts.isBinaryExpression(e) || !ts.isStringLiteral(e.right) || !ts.isIdentifier(e.left)) continue
        const eq = e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        const ne = e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
        if (!eq && !ne) continue
        const lit = e.right.text
        const set = tabs.find(t => t.defs.some(d => d.key === lit))
        if (!set) continue
        const named = set.defs.find(d => d.key === lit)!
        const isThisTab = eq === truthy
        const target = isThisTab ? named : set.defs.length === 2 ? set.defs.find(t => t !== named)! : null
        if (target) out = noteTab(target, out, e.left.text)
      }
      return out
    }

    /** A heading owns the labels inside its enclosing block (section, card, form) or, failing that, its component. */
    const scopeOf = (heading: ts.Node): ts.Node => {
      let outer: ts.Node = heading
      for (let p: ts.Node | undefined = heading.parent; p && p !== ref.node.parent; p = p.parent) {
        if (isJsx(p)) {
          outer = p
          if (/^(section|article|fieldset|form|details|li|Card|CardBody)$/.test(tagOf(p))) return p
        }
      }
      return outer
    }
    const addPanel = (name: string, c: Ctx, scope: ts.Node, level: number, description?: string | null) => {
      if (!name) return
      // A smaller heading inside a bigger one's block sits under it (Bot settings > High Agency).
      const parent = [...acc.scopes].reverse().find(sc => sc.level < level)
      const under = parent && parent.panel.trail.join('>') === c.trail.join('>') ? [...(parent.panel.under ?? []), parent.panel.name] : []
      const audience: AppMapAudience = c.admin ? 'admin' : 'everyone'
      let panel = acc.panels.find(p => p.name === name && p.trail.join('>') === c.trail.join('>') && (p.under ?? []).join('>') === under.join('>'))
      if (!panel) {
        panel = { name, trail: c.trail, ...(under.length ? { under } : {}), audience }
        if (description) panel.description = description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : description
        acc.panels.push(panel)
      }
      acc.scopes.push({ node: scope, panel, level })
    }
    const addSetting = (raw: string | null) => {
      const owner = acc.scopes[acc.scopes.length - 1]?.panel
      const label = raw ? raw.replace(/\s*[:*]$/, '') : ''
      if (!label || label.length > 80 || !owner) return
      const list = (owner.settings ??= [])
      if (!list.includes(label)) list.push(label)
    }
    const levelOf = (n: Jsx, fallback: number): number => {
      const m = /\d/.exec(attr(n, 'level')?.initializer?.getText() ?? '')
      return m ? Number(m[0]) : fallback
    }
    /** A <label>'s own words: its direct text, else its first child's. */
    const labelText = (n: Jsx): string | null => {
      if (!ts.isJsxElement(n)) return null
      const direct = squash(n.children.filter(ts.isJsxText).map(c => c.text).join(' '))
      if (direct) return direct
      const first = n.children.find(ts.isJsxElement)
      return first ? staticText(first) : null
    }

    const visit = (n: ts.Node, c: Ctx): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        visit(n.left, c)
        visit(n.right, branch(n.left, true, c))
        return
      }
      if (ts.isConditionalExpression(n)) {
        visit(n.condition, c)
        visit(n.whenTrue, branch(n.condition, true, c))
        visit(n.whenFalse, branch(n.condition, false, c))
        return
      }
      if (isJsx(n)) {
        const tag = tagOf(n)
        if (OVERLAY_TAG.test(tag) || staticAttr(n, 'role') === 'dialog') return
        if (CARD_VIEWER_TAG.test(tag) && acc.path !== CARD_PAGE) return
        if (tag === 'PageHeader') {
          const t = staticAttr(n, 'title')
          if (t && !acc.title && c.trail.length === 0) acc.title = t
        } else if (tag === 'SettingsSection') {
          const t = staticAttr(n, 'title')
          if (t) addPanel(t, c, n, levelOf(n, 2), staticAttr(n, 'description'))
          else undescribed.add(`${rel(ref.file)}: a section whose title is computed (${squash(attr(n, 'title')?.getText() ?? '').slice(0, 80)})`)
        } else if (tag === 'CardHeader' || tag === 'SectionHeader') {
          const t = staticAttr(n, 'title')
          if (t) addPanel(t, c, scopeOf(n), tag === 'CardHeader' ? 3 : levelOf(n, 2), staticAttr(n, 'description'))
          else if (attr(n, 'title')) undescribed.add(`${rel(ref.file)}: a section whose title is computed (${squash(attr(n, 'title')!.getText()).slice(0, 80)})`)
        } else if (tag === 'h2' || tag === 'h3' || tag === 'h4') {
          const t = staticText(n)
          if (t) addPanel(t, c, scopeOf(n), Number(tag.slice(1)))
          else undescribed.add(`${rel(ref.file)}: a <${tag}> heading whose text is computed (${squash(n.getText().replace(/^<[^>]*>/, '').replace(/<\/h\d>$/, '')).slice(0, 60)})`)
        } else if (tag === 'label' || tag === 'legend') {
          addSetting(labelText(n))
        } else if (FIELD_TAG.test(tag)) {
          addSetting(staticAttr(n, 'label'))
        } else if (/^[A-Z]/.test(tag) && !tag.includes('.')) {
          const child = findComponent(ref.file, tag)
          if (child) walkComponent(child, c, acc)
        }
      }
      ts.forEachChild(n, ch => visit(ch, c))
      while (acc.scopes.length && acc.scopes[acc.scopes.length - 1].node === n) acc.scopes.pop()
    }
    const depthBefore = acc.scopes.length
    visit(ref.node, ctx)
    acc.scopes.length = Math.min(acc.scopes.length, depthBefore)
  }

  // ── navigation: the main menu and the avatar menu ──
  const layoutFile = path.join(src, 'components', 'Layout.tsx')
  const nav: NavEntry[] = []
  {
    const collect = (n: ts.Node, menu: NavEntry['menu']) => {
      if (ts.isObjectLiteralExpression(n)) {
        const prop = (k: string) => n.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === k)?.initializer
        const href = evalExpr(prop('href'))
        const label = evalExpr(prop('label'))
        if (typeof href === 'string' && typeof label === 'string') {
          nav.push({ href, label, menu, admin: evalExpr(prop('gate')) === 'admin' || evalExpr(prop('section')) === 'admin' })
          return
        }
      }
      ts.forEachChild(n, c => collect(c, menu))
    }
    for (const st of parse(layoutFile).statements) {
      if (!ts.isVariableStatement(st)) continue
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === 'NAV_GROUPS' && d.initializer) collect(d.initializer, 'main')
        if (ts.isIdentifier(d.name) && d.name.text === 'ACCOUNT_MENU' && d.initializer) collect(d.initializer, 'avatar')
      }
    }
  }
  const clickOf = (e: NavEntry) => (e.menu === 'avatar' ? [AVATAR_MENU, e.label] : [e.label])

  // ── routes ──
  const appFile = path.join(src, 'App.tsx')
  const pages: AppMapPage[] = []
  const firstPageOf = new Map<string, string>()
  const redirects: AppMapRedirect[] = []
  const join = (parent: string, p: string) => (p.startsWith('/') || !parent ? p : `${parent.replace(/\/$/, '')}/${p}`)

  function pageComponent(el: ts.Node | undefined): Jsx | null {
    let cur: ts.Node | undefined = el && ts.isJsxExpression(el) ? el.expression : el
    while (cur && isJsx(cur) && ROUTE_WRAPPERS.has(tagOf(cur))) {
      cur = ts.isJsxElement(cur) ? cur.children.find(isJsx) : undefined
    }
    return cur && isJsx(cur) ? cur : null
  }

  function handleRoute(route: Jsx, parent: { path: string; ref: ComponentRef | null; click: string[]; admin: boolean } | null, env: Record<string, unknown>) {
    const rawPath = evalExpr(attr(route, 'path')?.initializer, env)
    const isIndex = !!attr(route, 'index')
    const comp = pageComponent(attr(route, 'element')?.initializer)
    if (typeof rawPath !== 'string' && !isIndex) {
      undescribed.add(`App.tsx: a route whose path is computed (${squash(route.getText()).slice(0, 80)})`)
      return
    }
    const full = isIndex ? parent!.path : join(parent?.path ?? '', rawPath as string)
    if (full === '*') return // the not-found page
    if (!comp) { undescribed.add(`App.tsx: route ${full} has no element`); return }
    const tag = tagOf(comp)

    if (tag === 'Navigate' || /Redirect$/.test(tag)) {
      let to = tag === 'Navigate' ? evalExpr(attr(comp, 'to')?.initializer, env) : undefined
      if (typeof to === 'string' && !to.startsWith('/')) to = join(parent?.path ?? '', to)
      if (typeof to === 'string') redirects.push({ from: full, to })
      else undescribed.add(`App.tsx: ${full} redirects to a computed address (${tag})`)
      return
    }

    const ref = findComponent(appFile, tag)
    const children = ts.isJsxElement(route) ? route.children.filter(isJsx).filter(c => tagOf(c) === 'Route') : []
    const navHit = nav.find(e => e.href === full)
    const note = ROUTE_NOTES[full]

    if (children.length) {
      // A layout route: its children are the tabs of this page (Settings).
      const click = navHit ? clickOf(navHit) : note?.click ?? []
      for (const child of children) handleRoute(child, { path: full, ref, click, admin: !!navHit?.admin }, env)
      return
    }

    const acc: PageAcc = { path: full, admin: false, tabs: [], panels: [], scopes: [] }
    if (ref) walkComponent(ref, { trail: [], admin: false, depth: 0, stack: [] }, acc)
    else undescribed.add(`App.tsx: could not find the component for ${full} (${tag})`)

    let click: string[]
    let title: string | undefined
    let admin = acc.admin
    if (parent) {
      const tab = parent.ref ? [...tabArrays(parent.ref.file).values()].flat().find(t => t.key === rawPath) : undefined
      if (!tab) undescribed.add(`App.tsx: ${full} has no tab on its parent page`)
      click = [...parent.click, tab?.label ?? String(rawPath)]
      title = tab?.label
      admin = admin || parent.admin || !!tab?.admin
    } else if (navHit) {
      click = clickOf(navHit)
      title = navHit.label
      admin = admin || navHit.admin
    } else {
      click = note?.click ?? []
      // The page's own header names it; a note's title is for pages that have none.
      title = acc.title ?? note?.title
      // A page under an admin-only menu entry is reached through it.
      const via = nav.find(e => e.menu === 'main' && click[0] === e.label)
      admin = admin || !!via?.admin
    }
    const page: AppMapPage = {
      path: full,
      title: title ?? acc.title ?? tag,
      click_path: click,
      audience: admin ? 'admin' : 'everyone',
      tabs: acc.tabs,
      panels: acc.panels.map(p => (admin ? { ...p, audience: 'admin' as const } : p)),
    }
    if (admin) page.tabs = page.tabs.map(t => ({ ...t, audience: 'admin' as const }))
    if (!parent && note) page.how = note.how
    // Two URLs of one page (/chat and /chat/:slug): describe it once.
    const compId = ref ? `${ref.file}#${ref.name}` : null
    const twin = compId ? firstPageOf.get(compId) : undefined
    if (twin && (page.tabs.length || page.panels.length)) {
      page.same_as = twin
      page.tabs = []
      page.panels = []
    } else if (compId && !twin) firstPageOf.set(compId, full)
    pages.push(page)
  }

  {
    const visit = (n: ts.Node, env: Record<string, unknown>): void => {
      // {LEGACY_REDIRECTS.map(r => <Route … />)}
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'map' && n.arguments.length === 1) {
        const list = evalExpr(n.expression.expression, env)
        const fn = n.arguments[0]
        if (Array.isArray(list) && ts.isArrowFunction(fn) && fn.parameters.length >= 1 && ts.isIdentifier(fn.parameters[0].name)) {
          for (const item of list) visit(fn.body, { ...env, [fn.parameters[0].name.text]: item })
          return
        }
      }
      if (isJsx(n) && tagOf(n) === 'Route') { handleRoute(n, null, env); return }
      ts.forEachChild(n, c => visit(c, env))
    }
    visit(parse(appFile), {})
  }

  return { pages, redirects, undescribed: [...undescribed].sort() }
}

/** The committed file's exact text for a map (JSON: it is data, read by the server at run time). */
export function renderAppMapFile(map: AppMap): string {
  return `${JSON.stringify(map, null, 2)}\n`
}
