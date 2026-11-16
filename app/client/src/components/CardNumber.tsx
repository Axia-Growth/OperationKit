import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Check } from 'lucide-react'
import { copyText, COPY_FEEDBACK_MS } from './ui/CopyButton'
import { cn } from './ui/cn'
import { formatCardNumber } from '../../../shared/card-number'

/**
 * A card's number, `#901075` (obj 901080). Bots, messages and PRs name cards
 * by number, so every tile, the card header and chat card references show it.
 * Subtle mono text; a click copies `#901075` and briefly shows "Copied".
 * The click never reaches the tile / link around it.
 */
export function CardNumber({ id, className }: { id: number; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const label = formatCardNumber(id)

  async function copy(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const ok = await copyText(label)
    setState(ok ? 'copied' : 'failed')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), COPY_FEEDBACK_MS)
  }

  return (
    <button
      type="button"
      onClick={e => void copy(e)}
      title={`Card ${label}. Click to copy.`}
      aria-label={state === 'copied' ? `Copied card number ${label}` : `Card number ${label}. Copy`}
      data-testid="card-number"
      data-copy-state={state}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-sm font-mono tabular-nums text-fg-3 transition-colors duration-fast hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        className,
      )}
    >
      {state === 'copied' && <Check aria-hidden="true" className="h-3 w-3 text-status-done" />}
      <span>{label}</span>
      <span aria-live="polite" className="sr-only">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}</span>
    </button>
  )
}
