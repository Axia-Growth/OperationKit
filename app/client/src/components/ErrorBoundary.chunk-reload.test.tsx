// @vitest-environment jsdom
/**
 * Stale-chunk auto-reload (obj 901013): a lazy route import that fails with
 * "Failed to fetch dynamically imported module" (the old chunk hash is gone
 * right after a deploy) triggers ONE automatic full reload, guarded by
 * sessionStorage so it can't loop if the chunk is genuinely broken.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ErrorBoundary } from './ErrorBoundary'

function ThrowChunkError(): never {
  throw new Error('TypeError: Failed to fetch dynamically imported module: https://x/assets/JobsBoard-DiBVbAZO.js')
}
function ThrowOrdinaryError(): never {
  throw new Error('widget exploded')
}

describe('ErrorBoundary auto-reload on stale chunk', () => {
  let container: HTMLElement
  let root: Root
  let errSpy: ReturnType<typeof vi.spyOn>
  let reloadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    sessionStorage.clear()
    reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
    errSpy.mockRestore()
    sessionStorage.clear()
  })

  it('reloads automatically (once) on a chunk-load error, without showing the error card', () => {
    flushSync(() => {
      root.render(<ErrorBoundary scope="route"><ThrowChunkError /></ErrorBoundary>)
    })
    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="route-error"]')).toBeNull()
  })

  it('does not reload a second time — falls back to the error card (anti-loop)', () => {
    // Simulate the guard already tripped by an earlier reload this session.
    sessionStorage.setItem('cc-chunk-reload-attempted', '1')
    flushSync(() => {
      root.render(<ErrorBoundary scope="route"><ThrowChunkError /></ErrorBoundary>)
    })
    expect(reloadSpy).not.toHaveBeenCalled()
    const card = container.querySelector('[data-testid="route-error"]')
    expect(card).not.toBeNull()
    const buttons = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
    expect(buttons).toEqual(['Reload'])
  })

  it('an ordinary (non-chunk) render error never triggers a reload', () => {
    flushSync(() => {
      root.render(<ErrorBoundary scope="route"><ThrowOrdinaryError /></ErrorBoundary>)
    })
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="route-error"]')).not.toBeNull()
  })
})
