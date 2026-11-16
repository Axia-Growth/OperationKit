import { DecisionBriefing, useDecision } from './DecisionBriefing'

/** A decision rendered inside the bot chat (obj 901059): loads it by id. */
export function ChatDecision({ id, botName }: { id: number; botName?: string }) {
  const { decision, setDecision, error } = useDecision(id)
  if (error) return <p role="alert" className="text-sm text-danger">Could not load decision #{id}: {error}</p>
  if (!decision) return <p className="text-sm text-fg-3">Loading the decision…</p>
  return <DecisionBriefing decision={decision} onChange={setDecision} botName={botName} compact />
}
