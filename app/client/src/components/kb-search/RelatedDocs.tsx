// "Related by similarity" footer for an open knowledge page. Fetches in the
// background and renders nothing until there is at least one related page, so
// it never holds up the editor (and stays out of the way when semantic search
// is off or the page has not been embedded yet).
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { docTitle, formatPct, relatedDocs, type KbRelatedItem } from '../../lib/kbSearch'

export function RelatedDocs({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const [items, setItems] = useState<KbRelatedItem[]>([])
  const [open, setOpen] = useState(true)

  useEffect(() => {
    let cancelled = false
    setItems([])
    relatedDocs(path, 8)
      .then(data => { if (!cancelled) setItems(Array.isArray(data.related) ? data.related : []) })
      .catch(() => { if (!cancelled) setItems([]) })
    return () => { cancelled = true }
  }, [path])

  if (items.length === 0) return null

  return (
    <section className="shrink-0 border-t border-line bg-surface-1" aria-labelledby="kb-related-title">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex min-h-[36px] w-full items-center gap-1.5 px-3 text-left transition hover:bg-surface-3"
      >
        {open
          ? <ChevronDown className="h-3 w-3 shrink-0 text-fg-3" aria-hidden="true" />
          : <ChevronRight className="h-3 w-3 shrink-0 text-fg-3" aria-hidden="true" />}
        <span id="kb-related-title" className="text-xs font-medium text-fg-1">Related by similarity</span>
        <span className="font-mono text-xs text-fg-3">{items.length}</span>
      </button>
      {open && (
        <ul className="max-h-48 overflow-y-auto pb-1">
          {items.map((item, i) => (
            <li key={`${item.path}:${i}`}>
              <button
                type="button"
                onClick={() => onOpen(item.path)}
                title={item.snippet || undefined}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-surface-3"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-xs">
                  <span className="text-fg-0">{docTitle(item.path)}</span>
                  {item.heading && <span className="text-fg-3"> · {item.heading}</span>}
                </span>
                <span className="shrink-0 font-mono text-xs text-fg-3">{formatPct(item.similarity)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
