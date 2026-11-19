import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, cn } from '../ui'
import { Switch } from '../ui/Switch'
import type { ChatAgentInfo } from './types'

/* Operator tools (obj 901424). Only Operation Kit Dev has them: merge its own PRs once
   CI is green, the standard update.sh deploy with automatic rollback, closing cards the
   owner merged by hand, and Cloudflare Access / DNS changes. ON by default for Dev;
   this one switch turns all of them off. Every call is audit-logged. */

export const DEV_OPS_BOT_SLUG = 'operation-kit-dev'

export interface DevOpsResponse {
  dev_ops: { slug: string; eligible: boolean; enabled: boolean; is_default: boolean; updated_at: string | null }
  recent: Array<{ id: number; at: string; action: string; target: string | null; outcome: string; code: string | null }>
}

function valid(r: unknown): DevOpsResponse | null {
  const v = r as DevOpsResponse | null
  return v && typeof v === 'object' && v.dev_ops && typeof v.dev_ops.enabled === 'boolean'
    ? { ...v, recent: Array.isArray(v.recent) ? v.recent : [] }
    : null
}

export function DevOpsSection({ agent, isAdmin }: { agent: ChatAgentInfo; isAdmin: boolean }) {
  const eligible = agent.slug.toLowerCase() === DEV_OPS_BOT_SLUG
  const url = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/dev-ops`
  const [info, setInfo] = useState<DevOpsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!eligible) return
    let live = true
    setInfo(null)
    setError(null)
    api.get<DevOpsResponse>(url)
      .then(r => { if (live) setInfo(valid(r)) })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not load operator tools.') })
    return () => { live = false }
  }, [url, eligible])

  if (!eligible) return null

  const save = async (enabled: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = valid(await api.put<DevOpsResponse>(url, { enabled }))
      if (r) setInfo(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const id = (k: string) => `bot-dev-ops-${k}-${agent.slug}`
  const on = info?.dev_ops.enabled ?? true
  const last = info?.recent[0]

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id('title')} className="font-display text-sm font-semibold text-fg-0">Operator tools</h4>
        <span className={cn('rounded-full px-2 py-0.5 text-xs', on ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2')}>
          {!info ? '…' : on ? 'On' : 'Off'}
        </span>
      </div>
      <p className="text-xs text-fg-2">
        In a chat with an admin, this bot can merge its own pull requests once CI is green (it updates a branch that is behind
        first), deploy the latest main with the standard update (backup, verify, health check, automatic rollback), close cards
        you merged by hand, and change Cloudflare Access and DNS. Reserved pull requests, protected Access addresses and domain
        allows are always refused. Every call is logged. On by default.
      </p>
      {error && <Alert tone="alarm">{error}</Alert>}
      <div className="flex items-start gap-2 rounded-md border border-line bg-surface-0 px-3 py-1">
        <Switch
          checked={on}
          onChange={v => { void save(v) }}
          disabled={!isAdmin || !info}
          busy={busy}
          aria-describedby={id('help')}
          label={<span className="font-medium text-fg-0">Let this bot merge, deploy, close cards and change Cloudflare</span>}
        />
      </div>
      <p id={id('help')} className="-mt-2 px-3 text-xs text-fg-2">
        {!isAdmin ? 'Only an admin can change this.' : on ? 'Off removes all of these tools from the bot.' : 'The bot has none of these tools.'}
        {last ? ` Last: ${last.action}${last.target ? ` ${last.target}` : ''}, ${last.outcome}${last.code ? ` (${last.code})` : ''}.` : ''}
      </p>
    </section>
  )
}
