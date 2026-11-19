import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, cn } from '../ui'
import { Switch } from '../ui/Switch'
import type { ChatAgentInfo } from './types'

/* Card wakes (obj 901328, widened by obj 901394). When a card this bot owns
   finishes or needs it, the server runs one turn of the bot in its pinned
   "Card wakes" thread and posts its short answer in the person's main chat. The
   turn has the tools and permissions of a normal chat turn, plus the bot's
   own-card tools. ON by default, nothing to set up: this switch is only for
   turning a bot's card wakes off (its cards then go to the webhook path). */

export interface CardWakesResponse {
  card_wakes: {
    slug: string
    enabled: boolean
    is_default: boolean
    updated_at: string | null
    install_enabled: boolean
    thread_title: string
    /** obj 901394: install-wide limits (settings rows). Absent on an older server. */
    limits?: { debounce_seconds: number; max_per_hour: number; window_minutes: number; tools: 'chat' | 'own_cards'; posts_to_chat: boolean }
  }
  recent: Array<{
    id: number
    objective_id: number
    workspace: string
    need_kind: string
    status: string
    skip_reason: string | null
    last_error: string | null
    created_at: string
  }>
}

/** A response with the shape this section reads, else null (never throw on a bad body). */
function valid(r: unknown): CardWakesResponse | null {
  const v = r as CardWakesResponse | null
  return v && typeof v === 'object' && v.card_wakes && typeof v.card_wakes.enabled === 'boolean'
    ? { ...v, recent: Array.isArray(v.recent) ? v.recent : [] }
    : null
}

export function CardWakesSection({ agent, isAdmin }: { agent: ChatAgentInfo; isAdmin: boolean }) {
  const url = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/card-wakes`
  const [info, setInfo] = useState<CardWakesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setInfo(null)
    setError(null)
    api.get<CardWakesResponse>(url)
      .then(r => { if (live) setInfo(valid(r)) })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not load card wakes.') })
    return () => { live = false }
  }, [url])

  const save = async (enabled: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = valid(await api.put<CardWakesResponse>(url, { enabled }))
      if (r) setInfo(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const id = (k: string) => `bot-card-wakes-${k}-${agent.slug}`
  const on = info?.card_wakes.enabled ?? true
  const installOff = info ? !info.card_wakes.install_enabled : false
  const last = info?.recent[0]
  const limits = info?.card_wakes.limits

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id('title')} className="font-display text-sm font-semibold text-fg-0">Card wakes</h4>
        <span className={cn('rounded-full px-2 py-0.5 text-xs', on && !installOff ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2')}>
          {!info ? '…' : installOff ? 'Off for this install' : on ? 'On' : 'Off'}
        </span>
      </div>
      <p className="text-xs text-fg-2">
        When a card this bot owns finishes or needs it (waiting in review, passed or failed review, blocked, stalled, needs a secret, a
        decision asked or answered, signed off, pull request merged), the bot gets one turn in its pinned
        &ldquo;{info?.card_wakes.thread_title ?? 'Card wakes'}&rdquo; thread to close the card out
        {limits?.posts_to_chat === false ? '.' : ', and its short answer is posted in your chat with it.'}{' '}
        {limits?.tools === 'own_cards'
          ? 'In that turn it can only list, read, start, hold, close and message its own cards.'
          : 'The turn can do what the bot can do in a normal chat with you, no more. A wake is never an approval.'}{' '}
        A change the bot made itself does not wake it. On by default.
      </p>
      {limits && (
        <p className="text-xs text-fg-2" data-testid="card-wake-limits">
          Changes within {limits.debounce_seconds} seconds are answered in one turn. At most {limits.max_per_hour} wake turns an hour for
          this bot, and one per card every {limits.window_minutes} minutes. Over the limit, the bot says so in chat.
        </p>
      )}
      {error && <Alert tone="alarm">{error}</Alert>}
      <div className="flex items-start gap-2 rounded-md border border-line bg-surface-0 px-3 py-1">
        <Switch
          checked={on}
          onChange={v => { void save(v) }}
          disabled={!isAdmin || !info}
          busy={busy}
          aria-describedby={id('help')}
          label={<span className="font-medium text-fg-0">Wake this bot for its cards</span>}
        />
      </div>
      <p id={id('help')} className="-mt-2 px-3 text-xs text-fg-2">
        {!isAdmin
          ? 'Only an admin can turn card wakes off.'
          : on
            ? 'Off sends this bot’s card alerts to the webhook path instead, as for an outside bot.'
            : 'This bot is not woken for its cards; their alerts go to the webhook path.'}
        {last ? ` Last: card #${last.objective_id}, ${last.status}${last.skip_reason ? ` (${last.skip_reason.split(':')[0]})` : ''}.` : ''}
      </p>
    </section>
  )
}
