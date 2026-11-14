import { FileText, Paperclip, Pencil } from 'lucide-react'
import { relativeTime } from '../lib/time'
import type { TouchedFile } from '../lib/touchedFiles'

export function FileRail({
  files,
  onOpen,
}: {
  files: TouchedFile[]
  onOpen?: (file: TouchedFile) => void
}) {
  return (
    <aside className="hidden h-full w-[280px] shrink-0 flex-col border-l border-line bg-surface-1 lg:flex">
      <div className="border-b border-line px-3 py-2.5">
        <div className="text-xs font-medium uppercase tracking-eyebrow text-fg-2">Files</div>
        <div className="mt-0.5 text-xs text-fg-3">Most recently touched first</div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {files.length === 0 && (
          <li className="px-2 py-6 text-center text-xs text-fg-3">
            No files recorded for this session yet.
          </li>
        )}
        {files.map(f => (
          <li key={`${f.kind}:${f.path}`}>
            <button
              type="button"
              onClick={() => onOpen?.(f)}
              className="mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-3"
            >
              {f.kind === 'attachment'
                ? <Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-3" />
                : f.kind === 'created'
                  ? <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-done" />
                  : <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-working" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg-0">{f.name}</span>
                <span className="mt-0.5 block truncate font-mono text-xs text-fg-3">{f.path}</span>
                {f.lastTouchedAt && (
                  <span className="mt-0.5 block text-xs text-fg-3">{relativeTime(f.lastTouchedAt)}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
