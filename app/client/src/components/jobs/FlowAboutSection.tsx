import { useEffect, useId, useState } from 'react'
import { Pencil } from 'lucide-react'
import type { FlowSummary } from '../../../../shared/flow/api'
import { FLOW_NOTES_MAX_CHARS } from '../../../../shared/flow/details'
import { updateFlowDetails } from '../../hooks/useFlows'
import { Alert, Button } from '../ui'
import { toast } from '../ui/Toaster'
import { FLOW_FIELD, FLOW_LABEL, FlowToolsInput, FlowToolsList } from './FlowToolsInput'

/**
 * "About this workflow" in Jobs → Workflows (obj 900868): the goal it was built
 * from, plus the owner's Notes and the Tools it should use. Notes and Tools are
 * editable here and are NOT part of a version — saving them never needs a new
 * self-test or a re-publish.
 */
export function FlowAboutSection({
  flow,
  goal,
  onSaved,
}: {
  flow: Pick<FlowSummary, 'id' | 'name' | 'notes' | 'tools'>
  /** The goal statement (shown version's definition, else the builder's goal). */
  goal: string | null
  onSaved?: (flow: FlowSummary) => void
}) {
  const ids = useId()
  // What the server last told us; the list refresh catches up on its own poll.
  const [saved, setSaved] = useState({ notes: flow.notes ?? null, tools: flow.tools ?? [] })
  useEffect(() => { setSaved({ notes: flow.notes ?? null, tools: flow.tools ?? [] }) }, [flow.notes, flow.tools])
  const [editing, setEditing] = useState(false)
  const [notes, setNotes] = useState('')
  const [tools, setTools] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEdit = () => {
    setNotes(saved.notes ?? '')
    setTools(saved.tools)
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    const r = await updateFlowDetails(flow.id, { notes, tools })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setSaved({ notes: r.flow.notes, tools: r.flow.tools })
    setEditing(false)
    toast.success(`Saved notes and tools: ${flow.name}`)
    onSaved?.(r.flow)
  }

  return (
    <section className="space-y-3 rounded-md border border-line bg-surface-0 p-3" aria-labelledby={`${ids}-h`} data-testid="flow-about">
      <div className="flex items-center justify-between gap-2">
        <h4 id={`${ids}-h`} className="text-xs font-semibold uppercase tracking-eyebrow text-fg-3">About this workflow</h4>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={startEdit} leftIcon={<Pencil className="h-3.5 w-3.5" />} data-testid="flow-about-edit">
            Edit notes and tools
          </Button>
        )}
      </div>

      {goal && (
        <div>
          <div className={FLOW_LABEL}>Goal</div>
          <p className="text-sm leading-snug text-fg-1">{goal}</p>
        </div>
      )}

      {editing ? (
        <form
          className="space-y-3"
          onSubmit={e => { e.preventDefault(); void save() }}
          data-testid="flow-about-form"
        >
          <div>
            <label className={FLOW_LABEL} htmlFor={`${ids}-notes`}>Notes <span className="text-fg-3">(optional)</span></label>
            <textarea
              id={`${ids}-notes`}
              className={`${FLOW_FIELD} min-h-[88px]`}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              maxLength={FLOW_NOTES_MAX_CHARS}
              placeholder="Anything the builder and your team should know: what to skip, who to tell, when it matters."
              data-autofocus
            />
          </div>
          <div>
            <label className={FLOW_LABEL} htmlFor={`${ids}-tools`}>Tools <span className="text-fg-3">(optional)</span></label>
            <FlowToolsInput id={`${ids}-tools`} value={tools} onChange={setTools} describedBy={`${ids}-tools-help`} />
            <p id={`${ids}-tools-help`} className="mt-1 text-xs text-fg-3">The tools or integrations this workflow should use. Press Enter after each one.</p>
          </div>
          {error && <Alert tone="alarm" title="Could not save">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" size="sm" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className={FLOW_LABEL}>Notes</div>
            {saved.notes
              ? <p className="whitespace-pre-wrap text-sm leading-snug text-fg-1" data-testid="flow-about-notes">{saved.notes}</p>
              : <p className="text-sm text-fg-3">No notes yet.</p>}
          </div>
          <div>
            <div className={FLOW_LABEL}>Tools</div>
            {saved.tools.length
              ? <FlowToolsList tools={saved.tools} />
              : <p className="text-sm text-fg-3">No tools listed.</p>}
          </div>
        </div>
      )}
    </section>
  )
}
