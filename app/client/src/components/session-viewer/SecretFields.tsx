/**
 * obj 719065 — the two inputs every in-chat secret form shares: a scope picker
 * (Workspace = the card's workspace, Everywhere, Workspace + me) and
 * a masked value field. Labels come from the Settings → Secrets vocabulary so
 * the chat and the settings page say the same thing.
 */
import type { SecretRequestScope } from '@operationkit/shared'
import { SECRET_REQUEST_SCOPES } from '@operationkit/shared'
import { SCOPE_HINTS, SCOPE_LABELS } from '../secrets/scope'
import { RadioGroup } from '../ui/RadioGroup'

const SHORT_LABEL: Record<SecretRequestScope, string> = {
  workspace: SCOPE_LABELS.workspace,
  global: SCOPE_LABELS.global,
  workspace_user: 'Workspace + me',
}

export function SecretScopePicker({ id, value, onChange, workspace, disabled }: {
  id: string
  value: SecretRequestScope
  onChange: (v: SecretRequestScope) => void
  workspace: string
  disabled?: boolean
}) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend id={`${id}-legend`} className="mb-1 text-xs font-medium uppercase tracking-eyebrow text-fg-2">Save to</legend>
      {/* UI SDK radio (obj 900819): arrow keys move and check; the disabled
          fieldset disables the whole group. */}
      <RadioGroup
        variant="segment"
        labelledBy={`${id}-legend`}
        describedBy={`${id}-hint`}
        value={value}
        onChange={onChange}
        className="grid-cols-3"
        options={SECRET_REQUEST_SCOPES.map(s => ({ value: s, label: SHORT_LABEL[s] }))}
      />
      <p id={`${id}-hint`} className="text-xs leading-snug text-fg-2">
        {value === 'workspace' ? (
          <>Only the <span className="font-medium text-fg-1">{workspace}</span> workspace. {SCOPE_HINTS.workspace}</>
        ) : value === 'workspace_user' ? (
          <>Only you, only inside <span className="font-medium text-fg-1">{workspace}</span>.</>
        ) : (
          SCOPE_HINTS.global
        )}
      </p>
    </fieldset>
  )
}

export function MaskedSecretInput({ id, value, onChange, autoFocus, disabled }: {
  id: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  disabled?: boolean
}) {
  return (
    <input
      id={id}
      type="password"
      autoComplete="off"
      spellCheck={false}
      autoFocus={autoFocus}
      disabled={disabled}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="Paste the value"
      className="min-h-[44px] w-full rounded-md border border-line bg-surface-1 px-3 py-2 font-mono text-lg text-fg-0 placeholder:text-fg-3 transition-colors duration-base hover:border-line-strong focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:min-h-[36px] sm:text-sm"
    />
  )
}

/** One line of reassurance under every secret form. */
export function SecretPrivacyNote() {
  return (
    <p className="text-xs leading-snug text-fg-2">
      Goes straight to the encrypted secrets store. It never enters this chat, the transcript, logs or the model — the session is only told the name.
    </p>
  )
}
