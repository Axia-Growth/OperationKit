import { afterEach, beforeEach } from 'vitest'
import { clearChatCache } from '../components/agent-chat/chat-cache'
import { __resetKbCacheMemory, clearKbCache } from '../lib/kbCache'
import { __resetKbResource } from '../lib/kbResource'

// jsdom stubs UI SDK needs (top-layer popups, animations, layout reads), per
// the ui-sdk skill's testing guide. Assigned, not `??=`: jsdom ships some of
// these without the behaviour that matters.
if (typeof window !== 'undefined') {
  HTMLElement.prototype.showPopover = function () {}
  HTMLElement.prototype.hidePopover = function () {}
  HTMLElement.prototype.togglePopover = function () { return true }
  Element.prototype.getAnimations = () => []
  Element.prototype.scrollIntoView = function () {}
  Element.prototype.checkVisibility = () => true
  if (!document.elementFromPoint) document.elementFromPoint = () => null
  if (!document.elementsFromPoint) document.elementsFromPoint = () => []
  // presentation="auto" popups read media queries; jsdom has no matchMedia.
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
  // jsdom has no CSS.escape; the UI SDK uses it to build id selectors.
  // Polyfill per the CSSOM spec (serialize an identifier).
  const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string; supports?: (...a: string[]) => boolean } }
  g.CSS ??= {}
  // No CSS engine in jsdom: report features as unsupported so the SDK takes its fallbacks.
  g.CSS.supports ??= () => false
  g.CSS.escape ??= (value: string) => {
    const s = String(value)
    let out = ''
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c === 0) out += '�'
      else if ((c >= 0x1 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) || (i === 1 && c >= 0x30 && c <= 0x39 && s.charCodeAt(0) === 0x2d)) out += '\\' + c.toString(16) + ' '
      else if (i === 0 && s.length === 1 && c === 0x2d) out += '\\' + s[i]
      else if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) out += s[i]
      else out += '\\' + s[i]
    }
    return out
  }
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  document.head.append(
    Object.assign(document.createElement('style'), {
      textContent: '[popover] { display: block !important }',
    }),
  )
}

// obj 900865: the Bots page keeps a per-tab cache in module memory. Each test
// starts from an empty one so a response stubbed in one test never paints in
// the next.
beforeEach(() => clearChatCache())

// Context's client cache (obj 900867) is module-level by design (it is what
// makes a return visit instant); tests must not see each other's entries.
afterEach(() => {
  clearKbCache()
  __resetKbCacheMemory()
  __resetKbResource()
})
