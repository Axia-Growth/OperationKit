/**
 * Keyboard-shortcut labels per platform (obj 900807). The palette opens on
 * ⌘K on a Mac and Ctrl+K everywhere else (Layout listens for both), so the
 * hint must say which one THIS machine uses — "⌘K" on Windows reads as a bug.
 */

interface NavigatorWithUAData extends Navigator {
  userAgentData?: { platform?: string }
}

/** True on macOS / iOS / iPadOS. Server-side and unknown platforms → false. */
export function isApplePlatform(nav: NavigatorWithUAData | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export function commandPaletteShortcut(nav?: NavigatorWithUAData): string {
  return isApplePlatform(nav ?? (typeof navigator === 'undefined' ? undefined : navigator)) ? '⌘K' : 'Ctrl K'
}
