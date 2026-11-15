import { ArrowRight, X } from 'lucide-react'
import type { DesignPin } from './designReview'
import { Button, IconButton, Textarea } from '../components/ui'

export function DesignPins({
  pins,
  onNote,
  onRemove,
  onSend,
  sending,
}: {
  pins: DesignPin[]
  onNote: (id: string, note: string) => void
  onRemove: (id: string) => void
  onSend: () => void
  sending: boolean
}) {
  return (
    <div className="cc-design-pins">
      <div className="cc-design-pins-head">
        <span>{pins.length === 0 ? 'No pins yet' : `${pins.length} queued`}</span>
        <Button
          size="xs"
          variant="primary"
          disabled={pins.length === 0}
          loading={sending}
          onClick={onSend}
        >
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
      <ul>
        {pins.map(p => (
          <li key={p.id}>
            <div className="cc-design-pin-meta">
              <span className="cc-design-pin-kind">{p.kind === 'text' ? 'Text' : 'Comment'}</span>
              <code>{p.selector || p.tag}</code>
              <IconButton size="sm" label="Remove pin" onClick={() => onRemove(p.id)} className="text-fg-3">
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </div>
            {p.kind === 'text' ? (
              <p className="cc-design-pin-text">
                {p.before} <ArrowRight aria-label="becomes" className="inline h-3.5 w-3.5 align-[-2px]" /> {p.after}
              </p>
            ) : (
              <Textarea
                value={p.note}
                onChange={e => onNote(p.id, e.target.value)}
                placeholder="What should change?"
                aria-label="Pin note"
                rows={2}
                className="resize-y bg-surface-1 px-2 py-1.5 text-xs"
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
