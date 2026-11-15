// @vitest-environment jsdom
/**
 * Per-route error boundary (polish F8, obj 900809).
 *
 * A page that throws while rendering must NOT blank the whole app: the boundary
 * sits INSIDE Layout (App.tsx), so the top bar / nav keep rendering and only the
 * page area shows the friendly error card. Navigating (a new resetKey) clears it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Layout } from './Layout'
import { ErrorBoundary } from './ErrorBoundary'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'admin', role: 'admin', workspaces: [] }, logout: vi.fn() }),
}))
vi.mock('../context/nav', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../preview/BoardShell', () => ({ useBoardTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }))
vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ workspaces: [], slugs: [], labelOf: (s: string) => s, shortOf: (s: string) => s, loading: false }),
}))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('./AlertBell', () => ({ AlertBell: () => null }))
vi.mock('../lib/optional-pages', () => ({ HAS_CHAT_PAGE: true }))

function Boom(): never {
  throw new Error('widget exploded')
}

describe('per-route ErrorBoundary inside Layout', () => {
  let container: HTMLElement
  let root: Root
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // React logs caught render errors; keep the test output clean.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
    errSpy.mockRestore()
  })

  function mount(page: React.ReactNode, resetKey: string) {
    flushSync(() => {
      root.render(
        <Layout selectedWorkspaces={[]} onWorkspacesChange={() => {}}>
          <ErrorBoundary scope="route" resetKey={resetKey}>{page}</ErrorBoundary>
        </Layout>,
      )
    })
  }

  const navLinks = () => Array.from(container.querySelectorAll('nav a')).map(a => a.getAttribute('href'))

  it('a thrown child keeps the nav and shows the error card in the page area only', () => {
    mount(<Boom />, '/jobs')
    // Nav still rendered and clickable.
    expect(container.querySelectorAll('nav').length).toBeGreaterThan(0)
    expect(navLinks()).toContain('/')
    // The friendly route-scoped card, not the full-screen app one.
    const card = container.querySelector('[data-testid="route-error"]')
    expect(card).not.toBeNull()
    expect(container.querySelector('[data-testid="app-error"]')).toBeNull()
    expect(card!.textContent).toContain("This page couldn't load")
    // The raw message is tucked into the collapsed details, not the headline.
    const details = card!.querySelector('details')
    expect(details).not.toBeNull()
    expect(details!.open).toBe(false)
    expect(card!.querySelector('[data-testid="error-details"]')!.textContent).toContain('widget exploded')
    expect(card!.querySelector('p')!.textContent).not.toContain('widget exploded')
  })

  it('navigating to another route (new resetKey) clears the error', () => {
    mount(<Boom />, '/jobs')
    expect(container.querySelector('[data-testid="route-error"]')).not.toBeNull()
    mount(<div data-testid="ok-page">fine</div>, '/knowledge')
    expect(container.querySelector('[data-testid="route-error"]')).toBeNull()
    expect(container.querySelector('[data-testid="ok-page"]')).not.toBeNull()
  })

  it('"Try again" re-mounts the page', () => {
    let shouldThrow = true
    function Flaky() {
      if (shouldThrow) throw new Error('first render fails')
      return <div data-testid="recovered">ok</div>
    }
    mount(<Flaky />, '/jobs')
    const retry = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Try again')!
    shouldThrow = false
    flushSync(() => retry.click())
    expect(container.querySelector('[data-testid="recovered"]')).not.toBeNull()
  })

  it('App.tsx wraps the routes in a route-scoped boundary INSIDE Layout', () => {
    const src = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8')
    const layout = src.indexOf('<Layout ')
    const boundary = src.indexOf('<ErrorBoundary scope="route" resetKey={pathname}>')
    const routes = src.indexOf('<Routes>')
    const layoutEnd = src.indexOf('</Layout>')
    expect(layout).toBeGreaterThan(-1)
    expect(boundary).toBeGreaterThan(layout)
    expect(routes).toBeGreaterThan(boundary)
    expect(layoutEnd).toBeGreaterThan(src.indexOf('</ErrorBoundary>', boundary))
  })
})
