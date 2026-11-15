import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Minimal render helper for primitive interaction tests (no testing-library in
// this repo). Renders inside act() so UI SDK effects and state settle.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface Rendered {
  container: HTMLElement
  rerender: (ui: ReactNode) => Promise<void>
  unmount: () => Promise<void>
}

const mounted: Rendered[] = []

export async function render(ui: ReactNode): Promise<Rendered> {
  const container = document.createElement('div')
  document.body.append(container)
  let root: Root
  await act(async () => {
    root = createRoot(container)
    root.render(ui)
  })
  const r: Rendered = {
    container,
    rerender: async (next) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
  mounted.push(r)
  return r
}

export async function cleanup() {
  while (mounted.length) await mounted.pop()!.unmount()
  document.body.innerHTML = ''
}

/** Press a key on the focused element (keydown + keyup), as a keyboard would. */
export async function press(key: string, target: Element | null = document.activeElement, init: KeyboardEventInit = {}) {
  if (!target) throw new Error(`press(${key}): nothing focused`)
  await act(async () => {
    const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(down)
    // A browser turns Enter (on keydown) and Space (on keyup) on a button into a click.
    const isButton = target instanceof HTMLButtonElement
    if (isButton && key === 'Enter' && !down.defaultPrevented) (target as HTMLElement).click()
    const up = new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(up)
    if (isButton && key === ' ' && !down.defaultPrevented && !up.defaultPrevented) (target as HTMLElement).click()
  })
}

export async function click(el: Element | null) {
  if (!el) throw new Error('click: no element')
  await act(async () => {
    el.dispatchEvent(new (globalThis.PointerEvent ?? MouseEvent)('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    if (el instanceof HTMLElement) el.focus()
    el.dispatchEvent(new (globalThis.PointerEvent ?? MouseEvent)('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

export const byRole = (root: ParentNode, role: string) => Array.from(root.querySelectorAll<HTMLElement>(`[role="${role}"]`))

/** The [role=option] rows of an OPEN ui/Select, scoped to the trigger's own
    popup (aria-controls) so a list left over from another render never counts. */
export function optionsOf(trigger: Element): HTMLElement[] {
  const listId = trigger.getAttribute('aria-controls')
  const list = (listId && document.getElementById(listId)) || document.body
  return byRole(list, 'option')
}

/** Opens a ui/Select trigger (`button[role="combobox"]`) and clicks the
    option whose trimmed text equals `match` (or matches the RegExp). */
export async function chooseOption(trigger: Element | null, match: string | RegExp) {
  if (!trigger) throw new Error('chooseOption: no trigger')
  await click(trigger)
  const opts = optionsOf(trigger)
  const opt = opts.find((o) => {
    const t = (o.textContent ?? '').trim()
    return typeof match === 'string' ? t === match : match.test(t)
  })
  if (!opt) throw new Error(`chooseOption: no option ${String(match)} in [${opts.map((o) => o.textContent?.trim()).join(' | ')}]`)
  await click(opt)
}

/** Runs `check` with the UI SDK's native form-proxy inputs (an aria-hidden,
    tabindex=-1 `<input>` the SDK renders beside each radio / segment so the
    group takes part in forms) marked `hidden`. checkPattern counts every
    `input[type=radio]` as a radio, aria-hidden or not, so without this it
    reports each option twice. The proxies are already invisible to assistive
    tech and unfocusable; this only makes that true for the checker too. */
export async function withoutFormProxies<T>(root: ParentNode, check: () => Promise<T>): Promise<T> {
  const proxies = Array.from(root.querySelectorAll<HTMLInputElement>('input[aria-hidden="true"][tabindex="-1"]'))
  proxies.forEach((p) => { p.hidden = true })
  try {
    return await check()
  } finally {
    proxies.forEach((p) => { p.hidden = false })
  }
}
