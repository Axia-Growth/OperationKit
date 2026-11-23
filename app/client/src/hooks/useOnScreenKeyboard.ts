import { useSyncExternalStore } from 'react'

/* On-screen keyboard state for phones (obj 901376).

   iOS Safari and Android Chrome do NOT shrink the layout viewport when the
   keyboard opens: `100%` / `100vh` layouts keep their full height and the
   bottom of the page (composer, bottom nav) ends up behind the keyboard. Only
   `window.visualViewport` reports the area that is really visible. This store
   watches it, plus text-field focus, and answers three questions:

   - `touch`:  is the primary pointer a finger (a phone or tablet)? Decided by
               input type (`pointer: coarse`), never by screen width, so a
               narrow desktop window is still a desktop.
   - `open`:   is the on-screen keyboard up (or about to be)? Always false on a
               non-touch device.
   - `height`: the visible height in CSS px while the keyboard covers part of
               the layout viewport, else null ("use the normal 100% height").
*/

export interface OnScreenKeyboard {
  touch: boolean
  open: boolean
  height: number | null
}

const CLOSED: OnScreenKeyboard = { touch: false, open: false, height: null }

/** The visual viewport must lose at least this much before it counts as a keyboard (not a URL bar). */
export const KEYBOARD_MIN_PX = 120
/** Chrome comes back this long after the keyboard goes, so a tap on Send lands before the layout moves. */
export const KEYBOARD_CLOSE_DELAY_MS = 150

export const TOUCH_QUERY = '(pointer: coarse)'

/** True when the primary pointer is a finger. jsdom and old browsers (no matchMedia) are desktops. */
export function isTouchPrimary(win: Window | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  return !!win && typeof win.matchMedia === 'function' && win.matchMedia(TOUCH_QUERY).matches
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''])

/** Does focusing this element bring up the on-screen keyboard? */
export function summonsKeyboard(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase()) && !el.readOnly && !el.disabled
  return el instanceof HTMLElement && el.isContentEditable === true
}

export interface KeyboardFacts {
  touch: boolean
  /** A text field has focus. */
  focused: boolean
  /** The keyboard was seen open and then closed while this same field kept focus (Android back button). */
  dismissed: boolean
  /** Layout viewport height (`window.innerHeight`). */
  layoutHeight: number
  /** Visible height (`visualViewport.height`), or null when the API is missing. */
  visibleHeight: number | null
}

/** The one rule, kept pure so it can be tested without a browser. */
export function deriveKeyboard(f: KeyboardFacts): OnScreenKeyboard {
  if (!f.touch) return CLOSED
  const covered = f.visibleHeight !== null && f.layoutHeight - f.visibleHeight >= KEYBOARD_MIN_PX
  return {
    touch: true,
    open: covered || (f.focused && !f.dismissed),
    height: covered ? Math.round(f.visibleHeight as number) : null,
  }
}

let state: OnScreenKeyboard = CLOSED
const listeners = new Set<() => void>()
let detach: (() => void) | null = null

function attach() {
  if (typeof window === 'undefined') return
  const vv = window.visualViewport ?? null
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(TOUCH_QUERY) : null
  let dismissed = false
  let sawCovered = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  const publish = (next: OnScreenKeyboard) => {
    if (next.touch === state.touch && next.open === state.open && next.height === state.height) return
    state = next
    listeners.forEach(l => l())
  }

  const read = () => {
    const focused = summonsKeyboard(document.activeElement)
    // A pinch-zoom also shrinks the visual viewport; scale puts it back in layout px.
    const visibleHeight = vv ? vv.height * (vv.scale || 1) : null
    const covered = visibleHeight !== null && window.innerHeight - visibleHeight >= KEYBOARD_MIN_PX
    if (!focused) { dismissed = false; sawCovered = false }
    else if (covered) { sawCovered = true; dismissed = false }
    else if (sawCovered) dismissed = true
    const next = deriveKeyboard({ touch: !!mq?.matches, focused, dismissed, layoutHeight: window.innerHeight, visibleHeight })
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    // Opening is immediate; closing waits a beat. Tapping Send can blur the
    // box, and chrome that springs back mid-tap moves the button from under
    // the finger.
    if (state.open && !next.open) closeTimer = setTimeout(() => { closeTimer = null; publish(next) }, KEYBOARD_CLOSE_DELAY_MS)
    else publish(next)
  }

  const onFocusIn = () => { dismissed = false; sawCovered = false; read() }
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', read)
  window.addEventListener('resize', read)
  vv?.addEventListener('resize', read)
  vv?.addEventListener('scroll', read)
  mq?.addEventListener?.('change', read)
  read()
  detach = () => {
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('focusout', read)
    window.removeEventListener('resize', read)
    vv?.removeEventListener('resize', read)
    vv?.removeEventListener('scroll', read)
    mq?.removeEventListener?.('change', read)
    if (closeTimer) clearTimeout(closeTimer)
    state = CLOSED
  }
}

function subscribe(l: () => void) {
  if (listeners.size === 0) attach()
  listeners.add(l)
  return () => {
    listeners.delete(l)
    if (listeners.size === 0) { detach?.(); detach = null }
  }
}

export function useOnScreenKeyboard(): OnScreenKeyboard {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED)
}
