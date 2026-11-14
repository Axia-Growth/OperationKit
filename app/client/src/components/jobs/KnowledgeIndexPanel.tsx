// Jobs → Knowledge index (semantic search). Admin only: the status route is
// under /api/admin and 403s for anyone else, in which case this renders nothing.
import { Alert, Card, Skeleton } from '../ui'
import { useKbSearchStatus } from '../../hooks/useKbSearchStatus'
import { KbIndexJobCard } from './KbIndexJobCard'

export function KnowledgeIndexPanel() {
  const { status, error, forbidden, reload } = useKbSearchStatus()
  if (forbidden) return null

  return (
    <Card className="my-6 space-y-3" aria-labelledby="kb-index-title">
      <div className="space-y-1">
        <h3 id="kb-index-title" className="font-display text-lg font-semibold tracking-tight text-fg-0">
          Knowledge index (semantic search)
        </h3>
        <p className="text-sm text-fg-2">
          Embeds every knowledge page so search can match by meaning as well as by keyword.
          {status && !status.availability.available && status.availability.reason && (
            <> {status.availability.reason}</>
          )}
        </p>
      </div>
      {error && <Alert tone="alarm">{error}</Alert>}
      {!status ? (
        !error && <Skeleton className="h-24 w-full" />
      ) : (
        <KbIndexJobCard job={status.job} queue={status.queue} onChanged={reload} />
      )}
    </Card>
  )
}
