// Admin status for hybrid knowledge search (GET /api/admin/kb-search). Polls
// every 2s while an index job is running and every 30s otherwise. A non-admin
// gets a 403; `forbidden` lets the caller render nothing.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
import { getKbSearchStatus, type KbSearchStatus } from '../lib/kbSearch'

export const KB_POLL_RUNNING_MS = 2000
export const KB_POLL_IDLE_MS = 30000

export function useKbSearchStatus() {
  const [status, setStatus] = useState<KbSearchStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const mounted = useRef(true)

  const reload = useCallback(async () => {
    try {
      const data = await getKbSearchStatus()
      if (!mounted.current) return
      setStatus(data)
      setError(null)
    } catch (err) {
      if (!mounted.current) return
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setForbidden(true)
      else setError(err instanceof Error ? err.message : 'Could not load the knowledge index status.')
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => { mounted.current = false }
  }, [reload])

  const running = status?.job?.status === 'running'
  useEffect(() => {
    if (forbidden) return
    const t = setInterval(() => { void reload() }, running ? KB_POLL_RUNNING_MS : KB_POLL_IDLE_MS)
    return () => clearInterval(t)
  }, [running, forbidden, reload])

  return { status, setStatus, error, forbidden, reload, running }
}
