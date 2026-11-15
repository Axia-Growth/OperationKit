import { Image as ImageIcon, Paperclip as PaperclipIcon, X } from 'lucide-react'

interface AttachmentChipProps {
  name: string
  size: number
  mimetype?: string
  onRemove?: () => void
}

export function AttachmentChip({ name, size, mimetype, onRemove }: AttachmentChipProps) {
  const isImage = mimetype?.startsWith('image/')
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg-1">
      {isImage ? <ImageIcon aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-2" /> : <PaperclipIcon aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-2" />}
      <span className="truncate max-w-[150px]" title={name}>{name}</span>
      <span className="shrink-0 text-fg-2">{formatSize(size)}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded text-fg-2 hover:text-danger"
          aria-label={`Remove ${name}`}
        >
          <X aria-hidden="true" className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
