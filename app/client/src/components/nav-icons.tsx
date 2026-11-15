import type { LucideIcon, LucideProps } from 'lucide-react'
import {
  Activity,
  Archive,
  Brain,
  ChevronDown,
  FileText,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  MessagesSquare,
  MoreHorizontal,
  PenLine,
  Repeat,
  Rss,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Users,
} from 'lucide-react'

/* ─────────────────────────────────────────────────────────────────────────
   Nav-bar icons — lucide-react, the app's ONE icon family (polish F9, #900810)
   ----------------------------------------------------------------------------
   This file used to hold copied Heroicons v2 path data (W19), which made the
   nav the only place in the app drawn from a second icon set. It now maps each
   nav slot to a lucide icon so the whole UI shares one family and one stroke
   (the `LucideProvider strokeWidth={1.75}` default in main.tsx, from F1).

   The names are kept so Layout / CommandPalette / ObjectiveSearchPanel call
   sites stay the same. The active item used to flip outline→solid; lucide has
   no solid set, so `variant="solid"` draws the same glyph at a heavier stroke.
   Add a nav icon by adding a name here — never by pasting SVG path data.
   ───────────────────────────────────────────────────────────────────────── */

const ICONS = {
  // Bots — the key stays 'chat': it names the glyph, not the nav label (obj 900327).
  chat: MessagesSquare,
  strategy: ShieldCheck,
  dev: SquareTerminal,
  board: LayoutGrid,
  assistant: Brain,
  jobs: ListChecks,
  loops: Repeat,
  content: PenLine,
  contacts: Users,
  docs: FileText,
  status: Activity,
  dashboard: LayoutDashboard,
  feed: Rss,
  config: Settings,
  system: Sparkles,
  more: MoreHorizontal,
  // Chrome glyphs (controls, not destinations).
  chevron: ChevronDown,
  search: Search,
  archive: Archive,
} satisfies Record<string, LucideIcon>

export type NavIconName = keyof typeof ICONS

interface NavIconProps extends Omit<LucideProps, 'name' | 'ref'> {
  name: NavIconName
  /** 'solid' marks the active item: same glyph, heavier stroke. */
  variant?: 'outline' | 'solid'
}

export function NavIcon({ name, variant = 'outline', strokeWidth, ...rest }: NavIconProps) {
  const Icon = ICONS[name]
  return <Icon aria-hidden="true" strokeWidth={strokeWidth ?? (variant === 'solid' ? 2.25 : undefined)} {...rest} />
}
