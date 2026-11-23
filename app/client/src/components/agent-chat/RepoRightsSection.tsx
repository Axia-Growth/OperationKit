import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, Button, Input, cn } from '../ui'
import { DEV_OPS_BOT_SLUG } from './DevOpsSection'
import type { ChatAgentInfo } from './types'

/* GitHub repo rights (obj 901492). Only Operation Kit Dev can have them, and only
   for the repos an admin lists here. Off by default: no repo, no rights. With a
   repo listed, in a chat with an admin the bot can merge a pull request in that
   repo by number (no card needed) and update a branch so CI really runs. Every
   call is audit-logged. Deploys are not part of this. */

export interface RepoRightsResponse {
  repo_rights: {
    slug: string
    eligible: boolean
    operator_tools_on: boolean
    repos: Array<{ repo: string; granted_by: number | null; granted_by_username: string | null; created_at: string }>
    credential_name: string
    credential_stored: boolean
  }
}

function valid(r: unknown): RepoRightsResponse | null {
  const v = r as RepoRightsResponse | null
  return v && typeof v === 'object' && v.repo_rights && Array.isArray(v.repo_rights.repos) ? v : null
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/

export function RepoRightsSection({ agent, isAdmin }: { agent: ChatAgentInfo; isAdmin: boolean }) {
  const eligible = agent.slug.toLowerCase() === DEV_OPS_BOT_SLUG
  const url = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/repo-rights`
  const [info, setInfo] = useState<RepoRightsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!eligible) return
    let live = true
    setInfo(null)
    setError(null)
    api.get<RepoRightsResponse>(url)
      .then(r => { if (live) setInfo(valid(r)) })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not load GitHub repo rights.') })
    return () => { live = false }
  }, [url, eligible])

  if (!eligible) return null

  const save = async (repo: string, enabled: boolean) => {
    setBusy(repo)
    setError(null)
    try {
      const r = valid(await api.put<RepoRightsResponse>(url, { repo, enabled }))
      if (r) setInfo(r)
      if (enabled) setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setBusy(null)
    }
  }

  const id = (k: string) => `bot-repo-rights-${k}-${agent.slug}`
  const rr = info?.repo_rights
  const repos = rr?.repos ?? []
  const on = repos.length > 0
  const name = draft.trim()
  const canAdd = isAdmin && !!info && REPO_RE.test(name) && busy == null

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id('title')} className="font-display text-sm font-semibold text-fg-0">GitHub repo rights</h4>
        <span className={cn('rounded-full px-2 py-0.5 text-xs', on ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2')}>
          {!info ? '…' : on ? `On for ${repos.length} repo${repos.length === 1 ? '' : 's'}` : 'Off'}
        </span>
      </div>
      <p className="text-xs text-fg-2">
        For each repo listed here, in a chat with an admin this bot can merge a pull request by its number, even when no card is
        linked to it (a card is filed as the record), and update a branch so its checks really run. It merges only an open pull
        request that is cleanly mergeable with every check green. Reserved pull requests, pull requests from forks, a failed AI
        review and CodeQL high findings outside test files are always refused. It never deploys. Off until you add a repo.
      </p>
      {error && <Alert tone="alarm">{error}</Alert>}
      {rr && !rr.operator_tools_on && (
        <Alert tone="amber">Operator tools are off for this bot, so these rights do nothing until you turn them on above.</Alert>
      )}
      {repos.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Repos this bot may merge in">
          {repos.map(g => (
            <li key={g.repo} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface-0 px-3 py-2">
              <span className="min-w-0 break-all text-sm text-fg-0">
                {g.repo}
                <span className="ml-2 text-xs text-fg-2">{g.granted_by_username ? `switched on by ${g.granted_by_username}` : 'switched on'}</span>
              </span>
              {isAdmin && (
                <Button size="sm" variant="ghost" loading={busy === g.repo} disabled={busy != null} onClick={() => { void save(g.repo, false) }} aria-label={`Switch off ${g.repo}`}>
                  Switch off
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); if (canAdd) void save(name, true) }}>
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-fg-2" htmlFor={id('repo')}>
            Add a repo (owner/name)
            <Input id={id('repo')} value={draft} onChange={e => setDraft(e.target.value)} placeholder="owner/name" autoComplete="off" spellCheck={false} />
          </label>
          <Button type="submit" size="md" variant="secondary" loading={busy != null && busy === name} disabled={!canAdd}>Switch on</Button>
        </form>
      ) : (
        <p className="px-3 text-xs text-fg-2">Only an admin can change this.</p>
      )}
      {rr && (
        <p id={id('help')} className="px-3 text-xs text-fg-2">
          {rr.credential_stored
            ? `GitHub calls use the secret ${rr.credential_name}.`
            : `GitHub calls use the server's GitHub login or your GitHub connection. To give the bot its own login, store one as ${rr.credential_name} in Settings → Secrets.`}
        </p>
      )}
    </section>
  )
}
