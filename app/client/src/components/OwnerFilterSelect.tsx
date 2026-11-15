import { Bot, User as UserIcon } from 'lucide-react'
import { UNASSIGNED_TOKEN, type BotRosterEntry } from '../lib/assigneeFilter'
import { FilterDropdown, DropdownOption } from './FilterDropdown'

interface OwnerFilterSelectProps {
  /** Usernames that own something on this board (plus the current user). */
  options: string[]
  /** Bots that own something on this board (obj 900869). */
  bots?: BotRosterEntry[]
  /** Selected tokens: usernames, `bot:<id>` and/or UNASSIGNED_TOKEN. */
  selected: Set<string>
  everyoneSelected: boolean
  currentUser?: string
  onToggle: (token: string) => void
  onEveryone: () => void
}

/**
 * The board's owner filter as one "Owner ▾" dropdown (obj 900666) — replaces
 * the full-width chip row from obj 700857. Still multi-select: each row
 * toggles, and "Everyone" flips between all owners and the default
 * (Unassigned + me), exactly as the chip row did.
 *
 * obj 900869: owners are people AND bots. The panel lists Everyone, then the
 * people (Unassigned + each person), then the bots that own cards on this
 * board. A bot row matches every card that bot is on — the ones it is working
 * and the ones it handed to a person in Needs You.
 */
export function OwnerFilterSelect({
  options, bots = [], selected, everyoneSelected, currentUser, onToggle, onEveryone,
}: OwnerFilterSelectProps) {
  const botName = new Map(bots.map(b => [b.token, b.name]))
  const name = (token: string) =>
    token === UNASSIGNED_TOKEN ? 'Unassigned' : token === currentUser ? `${token} (me)` : botName.get(token) ?? token
  const short = (t: string) =>
    t === currentUser ? 'Me' : t === UNASSIGNED_TOKEN ? 'Unassigned' : botName.get(t) ?? t
  const allTokens = [UNASSIGNED_TOKEN, ...options, ...bots.map(b => b.token)]
  const picked = allTokens.filter(t => selected.has(t))
  const pickedBots = picked.filter(t => botName.has(t)).length
  const value = everyoneSelected
    ? 'Everyone'
    : picked.length === 0
      ? 'Nobody'
      : picked.length <= 2
        ? picked.map(short).join(' + ')
        : pickedBots === picked.length
          ? `${picked.length} bots`
          : pickedBots > 0
            ? `${picked.length - pickedBots} people + ${pickedBots} bot${pickedBots === 1 ? '' : 's'}`
            : `${picked.length} people`

  return (
    <FilterDropdown
      testId="owner-filter"
      label="Owner"
      value={value}
      ariaLabel={`Owner filter: ${value}`}
      icon={<UserIcon className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />}
      active={!everyoneSelected}
      panelClassName="w-60"
    >
      {() => (
        <div className="max-h-80 overflow-y-auto" role="group" aria-label="Filter board by owner">
          <DropdownOption multi selected={everyoneSelected} onClick={onEveryone} data-owner="*">
            Everyone
          </DropdownOption>
          <div className="my-1 border-t border-line-soft" />
          <div className="px-2 pb-0.5 pt-1 text-xs font-medium uppercase tracking-eyebrow text-fg-3" aria-hidden="true">
            People
          </div>
          {[UNASSIGNED_TOKEN, ...options].map(token => (
            <DropdownOption
              key={token}
              multi
              selected={selected.has(token)}
              onClick={() => onToggle(token)}
              data-owner={token}
            >
              {name(token)}
            </DropdownOption>
          ))}
          {bots.length > 0 && (
            <>
              <div className="my-1 border-t border-line-soft" />
              <div className="px-2 pb-0.5 pt-1 text-xs font-medium uppercase tracking-eyebrow text-fg-3" aria-hidden="true">
                Bots
              </div>
              {bots.map(b => (
                <DropdownOption
                  key={b.token}
                  multi
                  selected={selected.has(b.token)}
                  onClick={() => onToggle(b.token)}
                  data-owner={b.token}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Bot className="h-3.5 w-3.5 text-fg-3" aria-hidden="true" />
                    {b.name}
                  </span>
                </DropdownOption>
              ))}
            </>
          )}
        </div>
      )}
    </FilterDropdown>
  )
}
