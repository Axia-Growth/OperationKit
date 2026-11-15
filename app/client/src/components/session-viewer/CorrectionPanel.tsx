/**
 * Flag-mistake correction surface — extracted from SessionViewer.tsx
 * (behavior frozen).
 */
import { Button, Textarea } from '../ui'

export function CorrectionPanel({
  correctionText,
  setCorrectionText,
  correctionError,
  setCorrectionError,
  setShowCorrection,
  submitCorrection,
  submittingCorrection,
}: {
  correctionText: string
  setCorrectionText: (v: string) => void
  correctionError: string | null
  setCorrectionError: (v: string | null) => void
  setShowCorrection: (v: boolean) => void
  submitCorrection: () => void
  submittingCorrection: boolean
}) {
  return (
    <div className="border-b border-line bg-status-review/5">
      <div className="px-4 py-3 sm:px-5 space-y-2">
        <label className="block text-xs font-medium text-fg-2">
          What did this run get wrong? The bot will see this first on its next run of this card.
        </label>
        <Textarea
          value={correctionText}
          onChange={e => setCorrectionText(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. Edited the live checkout instead of an isolated worktree — always branch first."
          aria-label="What did this session get wrong?"
          className="resize-y bg-surface-1 text-lg sm:text-sm"
        />
        {correctionError && <div className="text-xs text-flag-blocked">{correctionError}</div>}
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setShowCorrection(false); setCorrectionError(null) }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={submitCorrection}
            disabled={!correctionText.trim() || submittingCorrection}
          >
            {submittingCorrection ? 'Submitting…' : 'Submit correction'}
          </Button>
        </div>
      </div>
    </div>
  )
}
