import { isTouchPrimary } from '../hooks/useOnScreenKeyboard'

/* What Enter does in a chat composer (obj 901376) — one rule for every chat
   box, so they cannot drift apart.

   Desktop (a hardware keyboard): Enter sends, Shift+Enter is a new line.
   Phone / tablet (primary pointer is a finger): Return is a new line and the
   only way to send is the Send button. Decided by input type, not width: a
   narrow desktop window still sends on Enter. */

export interface EnterKeyLike {
  key: string
  shiftKey: boolean
  /** True while an IME is composing (Enter then confirms the candidate). */
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean }
}

export function enterSends(e: EnterKeyLike, touch: boolean = isTouchPrimary()): boolean {
  if (e.key !== 'Enter' || e.shiftKey || touch) return false
  return !(e.isComposing || e.nativeEvent?.isComposing)
}

/** The label on the phone keyboard's Return key: a new line on touch, Send elsewhere. */
export function composerEnterKeyHint(touch: boolean = isTouchPrimary()): 'enter' | 'send' {
  return touch ? 'enter' : 'send'
}
