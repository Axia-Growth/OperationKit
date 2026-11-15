import { Bot, User as UserIcon, UserX } from 'lucide-react'
import { cardOwner, type CardOwner, type Objective } from '@operationkit/shared'
import { Badge } from './ui'

/**
 * Owner tag (obj 900869) — who a card belongs to right now: a bot while it
 * works, a person once it needs one (it then sits in Needs You).
 *
 * The server ships `current_owner` on every card (mapObjective). A payload from
 * an older server, or a test fixture, may not carry it, so the same shared
 * function derives it here from the fields the card already has.
 */
export function ownerOf(o: Objective): CardOwner {
  return o.current_owner ?? cardOwner({
    status: o.status,
    session_id: o.session_id,
    owner_bot: o.owner_bot,
    bot_owner: o.bot_owner,
    bot_owner_name: o.bot_owner_name,
    assigned_usernames: o.assigned_usernames,
    created_by_username: o.created_by_username,
  })
}

/** One line a screen reader (and the hover title) reads for the owner. */
export function ownerSentence(owner: CardOwner): string {
  if (owner.kind === 'bot') return `Owner: ${owner.label} (bot) — working on it`
  if (owner.kind === 'unassigned') {
    return owner.needs_human
      ? `Needs a person — nobody is assigned${owner.handed_off_from_bot ? ` (handed off by ${owner.handed_off_from_bot})` : ''}`
      : 'Unassigned'
  }
  const who = `Owner: ${owner.label}`
  if (!owner.needs_human) return who
  return `${who} — needs you${owner.handed_off_from_bot ? ` (handed off by ${owner.handed_off_from_bot})` : ''}`
}

// Needs-you human tone, the same token NeedsSecretFlag uses: the card is
// waiting on a person. Bots read in the working (info) tone.
const HUMAN_NEEDED = 'border-status-human/40 bg-status-human/10 text-status-human'

export function OwnerTag({
  objective,
  owner: given,
  showHandoff = false,
}: {
  objective?: Objective
  owner?: CardOwner
  /** Viewer header: also say which bot handed it over. */
  showHandoff?: boolean
}) {
  const owner = given ?? (objective ? ownerOf(objective) : null)
  if (!owner) return null
  const sentence = ownerSentence(owner)
  const Icon = owner.kind === 'bot' ? Bot : owner.kind === 'human' ? UserIcon : UserX
  const tone = owner.kind === 'bot' ? 'info' : 'neutral'
  const className = owner.needs_human && owner.kind === 'human'
    ? HUMAN_NEEDED
    : owner.kind === 'unassigned' ? 'text-fg-3' : undefined
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1"
      title={sentence}
      data-testid="owner-tag"
      data-owner-kind={owner.kind}
      data-needs-human={owner.needs_human ? '1' : '0'}
    >
      <Badge tone={tone} className={className}>
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="sr-only">{sentence}</span>
        <span aria-hidden="true" className="max-w-[10rem] truncate">{owner.label}</span>
      </Badge>
      {showHandoff && owner.handed_off_from_bot && (
        <span className="truncate text-xs text-fg-3" data-testid="owner-handoff">
          from {owner.handed_off_from_bot}
        </span>
      )}
    </span>
  )
}
