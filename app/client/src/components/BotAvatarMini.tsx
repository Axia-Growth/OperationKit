import { COLOUR_CLASSES } from './agent-chat/types'
import { cn } from './ui'
import type { BotAvatarInfo } from '../lib/botAvatars'

/**
 * A bot's avatar at board size (obj 900947): the same glyph + identity colour
 * the Bots page shows, shrunk to sit inside an owner tag or a filter row. The
 * identity colours are the desaturated agent tokens, never a brand colour.
 */
export function BotAvatarMini({ info, className }: { info: BotAvatarInfo; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="bot-avatar-mini"
      data-bot-slug={info.slug}
      className={cn(
        'grid h-[18px] w-[18px] shrink-0 place-items-center overflow-hidden rounded border font-display text-xs font-semibold leading-none tracking-normal',
        COLOUR_CLASSES[info.colour]?.tile ?? COLOUR_CLASSES.grey.tile,
        className,
      )}
    >
      {info.avatar}
    </span>
  )
}
