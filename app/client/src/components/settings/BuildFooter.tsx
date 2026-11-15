/**
 * Which build is running (obj 720210): the commit from /api/health, so a
 * support conversation can start from "System → bottom of the page".
 * Polish F5 (obj 900806): it lives on System, not on every Settings tab, and
 * it renders nothing when the commit is unknown — "Build unknown" told nobody
 * anything.
 */
import { useEffect, useState } from 'react'

export function BuildFooter() {
  const [commit, setCommit] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    fetch('/api/health', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((b: { commit?: string | null } | null) => { if (live) setCommit(b?.commit ?? null) })
      .catch(() => { if (live) setCommit(null) })
    return () => { live = false }
  }, [])

  // Still loading, or the server does not know its commit: show nothing.
  if (!commit) return null
  return (
    <footer className="mt-10 border-t border-line-soft pt-4 text-xs text-fg-2" data-testid="build-footer">
      Build <span className="select-all font-mono text-fg-1">{commit}</span>
    </footer>
  )
}
