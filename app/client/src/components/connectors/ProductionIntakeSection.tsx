/**
 * Settings → Integrations → Production issues (obj 901771).
 *
 * Turn a signal from a client's live app into a bug card: a monitor or error
 * tracker posts to a webhook (admins create one per tool, the token is shown
 * once), or anyone in the workspace pastes a report. A bot may open a fix
 * pull request; the AI review runs; a PERSON merges. Nothing here merges or
 * deploys. Server: routes/production-intake.ts.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { Alert, Badge, Button, Card, Checkbox, CopyButton, Field, Input, SectionHeader, Textarea, useConfirm } from '../ui'
import { Select } from '../ui/Select'

interface IntakeSource {
  id: number
  workspace: string
  name: string
  project: string | null
  token_prefix: string
  auto_start: number
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

interface IntakeResult {
  outcome: 'filed' | 'appended' | 'ignored' | 'rate_limited' | 'disabled' | 'failed'
  objective_id: number | null
  reason?: string
}

/** The one-line rule shown on this page; the full text is on every card it files. */
export const HUMAN_MERGE_LINE =
  'A bot may open a fix pull request and the AI review runs on it. A person merges anything that ships to production. Nothing here merges or deploys.'

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string } | null)?.error || err.message || fallback
  return err instanceof Error ? err.message : fallback
}

export function intakeOutcomeText(r: IntakeResult): string {
  const card = r.objective_id ? `card #${r.objective_id}` : 'no card'
  switch (r.outcome) {
    case 'filed': return `Filed ${card}.`
    case 'appended': return `Already open as ${card}; added this report to it.`
    case 'ignored': return 'That reads as a recovery, so no card was filed.'
    case 'rate_limited':
    case 'disabled':
    case 'failed': return r.reason || 'No card was filed.'
  }
}

export function ProductionIntakeSection({ isAdmin, workspaces, defaultWorkspace }: {
  isAdmin: boolean
  workspaces: Array<{ value: string; label: string }>
  defaultWorkspace: string
}) {
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [sources, setSources] = useState<IntakeSource[]>([])
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null)
  const [name, setName] = useState('')
  const [project, setProject] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [report, setReport] = useState('')
  const [busy, setBusy] = useState<'create' | 'report' | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const load = useCallback(async () => {
    if (!isAdmin || !workspace) return
    try {
      const r = await api.get<{ sources: IntakeSource[] }>(`/production-intake/sources?workspace=${encodeURIComponent(workspace)}`)
      setSources(r.sources)
    } catch (err) {
      setNotice({ ok: false, text: errText(err, 'Could not load the production webhooks.') })
    }
  }, [isAdmin, workspace])

  useEffect(() => { void load() }, [load])

  const webhookUrl = `${window.location.origin}/api/production-intake/signal`

  const createSource = async () => {
    setBusy('create'); setNotice(null); setCreated(null)
    try {
      const r = await api.post<{ source: IntakeSource; token: string }>('/production-intake/sources', {
        workspace, name: name.trim(), project: project.trim() || undefined, auto_start: autoStart,
      })
      setCreated({ name: r.source.name, token: r.token })
      setName(''); setProject(''); setAutoStart(false)
      await load()
    } catch (err) {
      setNotice({ ok: false, text: errText(err, 'Could not create the webhook.') })
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (s: IntakeSource) => {
    const ok = await confirm({ title: `Revoke "${s.name}"?`, message: 'The tool posting to it gets a 401 from now on. Cards it already filed stay.', confirmLabel: 'Revoke', danger: true })
    if (!ok) return
    try {
      await api.del(`/production-intake/sources/${s.id}`)
      await load()
    } catch (err) {
      setNotice({ ok: false, text: errText(err, 'Could not revoke the webhook.') })
    }
  }

  const fileReport = async () => {
    setBusy('report'); setNotice(null)
    try {
      const r = await api.post<IntakeResult>('/production-intake/report', { workspace, text: report })
      setNotice({ ok: r.outcome === 'filed' || r.outcome === 'appended', text: intakeOutcomeText(r) })
      if (r.outcome === 'filed' || r.outcome === 'appended') setReport('')
    } catch (err) {
      setNotice({ ok: false, text: errText(err, 'Could not file the report.') })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="production-intake-title" className="space-y-3" data-testid="production-intake-section">
      <SectionHeader
        headingId="production-intake-title"
        className="mb-0"
        title="Production issues"
        description="Turn an alert, error report or log from your live app into a bug card with the evidence attached."
        actions={
          <>
            <label className="sr-only" htmlFor="production-intake-ws">Workspace</label>
            <Select id="production-intake-ws" value={workspace} onChange={v => { setWorkspace(v); setCreated(null) }}>
              {workspaces.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
            </Select>
          </>
        }
      />
      <p className="text-sm text-fg-2">{HUMAN_MERGE_LINE}</p>

      {notice && (
        <div aria-live="polite">
          <Alert tone={notice.ok ? 'verify' : 'alarm'}>{notice.text}</Alert>
        </div>
      )}

      <Card inset className="space-y-3 p-4 sm:p-5">
        <h4 className="text-base font-semibold text-fg-0">Paste a report</h4>
        <Field id="production-intake-report" label="Error, log or what the customer saw" hint="The first line becomes the card title.">
          <Textarea id="production-intake-report" rows={5} value={report} onChange={e => setReport(e.target.value)} />
        </Field>
        <div>
          <Button variant="primary" size="sm" onClick={fileReport} loading={busy === 'report'} disabled={!report.trim() || !workspace}>
            File bug card
          </Button>
        </div>
      </Card>

      {isAdmin && (
        <Card inset className="space-y-3 p-4 sm:p-5">
          <h4 className="text-base font-semibold text-fg-0">Webhooks</h4>
          <p className="text-sm text-fg-2">
            One per monitoring tool (Sentry, UptimeRobot, Grafana, Alertmanager, or anything that can post JSON). Post to{' '}
            <code className="font-mono text-fg-1">{webhookUrl}</code> with the token in an <code className="font-mono">X-Intake-Token</code> header,
            or add <code className="font-mono">?token=…</code> to the URL.
          </p>

          {created && (
            <Alert tone="verify" title={`Token for "${created.name}" — copy it now, it is not shown again`}>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <code className="break-all font-mono text-xs">{created.token}</code>
                <CopyButton value={created.token} label="Copy token" />
                <CopyButton value={`${webhookUrl}?token=${created.token}`} label="Copy URL with token" />
              </div>
            </Alert>
          )}

          {sources.length > 0 && (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {sources.map(s => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-fg-0">{s.name}</span>{' '}
                    <code className="font-mono text-xs text-fg-3">{s.token_prefix}…</code>
                    {s.project && <span className="text-fg-3"> · project {s.project}</span>}
                    {s.auto_start ? <span className="text-fg-3"> · starts a bot on each card</span> : null}
                    <span className="text-fg-3"> · {s.last_used_at ? `last used ${s.last_used_at}` : 'not used yet'}</span>
                  </span>
                  {s.revoked_at ? <Badge tone="neutral">Revoked</Badge> : (
                    <Button variant="danger" size="sm" onClick={() => revoke(s)}>Revoke</Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <Field id="production-intake-name" label="Name" className="min-w-[200px] flex-1">
              <Input id="production-intake-name" value={name} placeholder="Sentry - storefront" onChange={e => setName(e.target.value)} />
            </Field>
            <Field id="production-intake-project" label="Project" optional className="min-w-[160px]">
              <Input id="production-intake-project" value={project} placeholder="storefront" onChange={e => setProject(e.target.value)} />
            </Field>
          </div>
          <div>
            <Checkbox
              id="production-intake-autostart"
              checked={autoStart}
              onChange={e => setAutoStart(e.target.checked)}
              label="Start a bot on each new card"
              description="Off: cards wait in the queue for someone to start them. On or off, a person still merges the fix."
            />
          </div>
          <div>
            <Button variant="primary" size="sm" onClick={createSource} loading={busy === 'create'} disabled={!name.trim() || !workspace}>
              Create webhook
            </Button>
          </div>
        </Card>
      )}
      {confirmDialog}
    </section>
  )
}
