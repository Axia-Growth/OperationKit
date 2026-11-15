// The latest knowledge-index (embedding) job: kind, status, progress, counts,
// times, last error and the file being read. Owns the Re-index / Stop actions
// (POST /api/admin/kb-search/backfill | cancel) and calls `onChanged` after
// either so the parent re-fetches status. Shared by Jobs → Knowledge index and
// Settings → Knowledge search.
import { useState } from 'react'
import { RefreshCw, Square } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { cancelKbJob, formatJobTime, startKbBackfill, type KbIndexJob, type KbJobStatus } from '../../lib/kbSearch'
import { Alert, Badge, Button, ProgressBar } from '../ui'

const STATUS_META: Record<KbJobStatus, { label: string; tone: 'info' | 'verify' | 'alarm' | 'neutral' | 'amber' }> = {
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'verify' },
  failed: { label: 'Failed', tone: 'alarm' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
  interrupted: { label: 'Interrupted', tone: 'amber' },
}

const KIND_LABEL: Record<KbIndexJob['kind'], string> = { backfill: 'Backfill', reembed: 'Re-embed' }

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const reason = (err.body as { reason?: string } | null)?.reason
    return reason ? `Not started: ${reason}` : err.message || fallback
  }
  return err instanceof Error ? err.message || fallback : fallback
}

export function KbIndexJobCard({
  job,
  queue = 0,
  onChanged,
}: {
  job: KbIndexJob | null
  queue?: number
  onChanged: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState<'reindex' | 'stop' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = job?.status === 'running'

  const act = async (which: 'reindex' | 'stop') => {
    setBusy(which)
    setError(null)
    try {
      if (which === 'reindex') {
        const res = await startKbBackfill()
        if (res && res.started === false) setError(`Not started: ${res.reason ?? 'unknown reason'}`)
      } else {
        await cancelKbJob()
      }
      await onChanged()
    } catch (err) {
      setError(errText(err, which === 'reindex' ? 'Could not start re-indexing.' : 'Could not stop the job.'))
    } finally {
      setBusy(null)
    }
  }

  const total = Number(job?.total) || 0
  const processed = Number(job?.processed) || 0
  const pct = total > 0 ? Math.round((processed / total) * 100) : running ? 0 : 100
  const meta = job ? STATUS_META[job.status] ?? { label: job.status, tone: 'neutral' as const } : null

  return (
    <div className="space-y-3" data-testid="kb-index-job">
      {!job ? (
        <p className="text-sm text-fg-2">No index job has run yet.</p>
      ) : (
        <div className="space-y-2.5 rounded-md border border-line bg-surface-1 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg-0">{KIND_LABEL[job.kind] ?? job.kind}</span>
            {meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
            {job.trigger && <span className="text-xs text-fg-3">{job.trigger}</span>}
            <span className="ml-auto font-mono text-xs text-fg-3">
              {processed}/{total} · {pct}%
            </span>
          </div>
          <ProgressBar
            pct={pct}
            label="Index progress"
            tone={job.status === 'failed' ? 'alarm' : job.status === 'interrupted' || job.status === 'cancelled' ? 'amber' : 'accent'}
          />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
            {([
              ['Embedded', job.embedded],
              ['Skipped', job.skipped],
              ['Failed', job.failed],
              ['Removed', job.removed],
              ['Chunks', job.chunks],
            ] as const).map(([label, n]) => (
              <div key={label} className="flex items-baseline gap-1.5">
                <dt className="text-fg-3">{label}</dt>
                <dd className="font-mono text-fg-1">{Number(n) || 0}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-fg-3">
            Started {formatJobTime(job.started_at)}
            {job.finished_at && <> · finished {formatJobTime(job.finished_at)}</>}
            {job.model_id && <> · <span className="font-mono">{job.model_id}</span></>}
          </p>
          {running && job.current_path && (
            <p className="truncate font-mono text-xs text-fg-2" title={job.current_path}>
              Reading {job.current_path}
            </p>
          )}
          {job.error && <Alert tone="alarm">{job.error}</Alert>}
        </div>
      )}

      {queue > 0 && <p className="text-xs text-fg-3">{queue} changed {queue === 1 ? 'page is' : 'pages are'} waiting to be indexed.</p>}
      {error && <Alert tone="alarm">{error}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void act('reindex')}
          disabled={running || busy !== null}
          loading={busy === 'reindex'}
          leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          Re-index now
        </Button>
        {running && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => void act('stop')}
            disabled={busy !== null}
            loading={busy === 'stop'}
            leftIcon={<Square className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Stop
          </Button>
        )}
      </div>
    </div>
  )
}
