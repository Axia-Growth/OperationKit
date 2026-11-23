/* How tall the chat box may be while the phone keyboard is open (obj 901376).

   The conversation keeps at least half of the visible area above the keyboard.
   The box grows with its text up to its line cap, but once the message list
   would drop under half, the box stops growing and scrolls inside instead. It
   never goes below one line. */

/** One line of text plus padding and border: the box's `min-h-[44px]`. */
export const COMPOSER_MIN_PX = 44

/**
 * @param wanted   the height the box asked for (content height, already capped by lines)
 * @param listPx   the message list's height measured WITH the box at `wanted`
 * @param visible  the visible height above the keyboard
 */
export function fitComposerHeight(wanted: number, listPx: number, visible: number, min: number = COMPOSER_MIN_PX): number {
  const short = Math.ceil(visible / 2) - listPx
  if (short <= 0) return wanted
  return Math.max(Math.min(min, wanted), wanted - short)
}
