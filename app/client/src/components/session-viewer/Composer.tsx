/**
 * Follow-up composer — extracted from SessionViewer.tsx (behavior frozen).
 */
import { useMemo, useState, type ClipboardEvent, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { FileText, Image as ImageIcon, KeyRound, Paperclip, X } from 'lucide-react'
import { Badge, Button, IconButton, RowButton } from '../ui'
import { filesFromClipboard, useFileDrop } from '../../hooks/useFileDrop'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { detectSecrets, redactValue, type SecretCandidate } from '../../lib/secretDetect'
import { SecretForm } from './ChatSecretRequest'
import { formatFileSize, type UploadedFile } from './types'

/**
 * obj 719065 → 900670: the composer's only secret affordance is the paste
 * guard (a key typed/pasted into the message is offered to the store instead).
 * The "+ Add secret" button and its modal are gone: agents ask for a secret and
 * the masked form appears in the chat (ChatSecretRequest.tsx). Omitted → no
 * paste prompt.
 */
export interface ComposerSecrets {
  objectiveId: number
  workspace: string
  /** Names the card is currently waiting on (for naming a bare pasted token). */
  pendingNames: string[]
}

export function Composer({
  attachedFiles,
  removeFile,
  sendError,
  setSendError,
  fileInputRef,
  handleUpload,
  uploading,
  message,
  setMessage,
  messageRef,
  handleSendMessage,
  inputDisabled,
  isActive,
  handleStop,
  interrupting,
  sending,
  secrets,
}: {
  attachedFiles: UploadedFile[]
  removeFile: (index: number) => void
  sendError: string | null
  setSendError: (v: string | null) => void
  fileInputRef: RefObject<HTMLInputElement | null>
  handleUpload: (fileList: FileList) => void
  uploading: boolean
  message: string
  setMessage: Dispatch<SetStateAction<string>>
  messageRef: RefObject<HTMLTextAreaElement | null>
  handleSendMessage: () => void
  inputDisabled: boolean
  isActive: boolean
  handleStop: () => void
  interrupting: boolean
  sending: boolean
  secrets?: ComposerSecrets
}) {
  const canAttach = !inputDisabled && !uploading
  // At phone width the attach / secret / Stop / Send controls leave the textarea
  // ~140px, so the long placeholder wrapped onto three lines (QA obj 900621).
  const narrow = useMediaQuery('(max-width: 639px)')
  const { isDragging, dropProps } = useFileDrop(handleUpload, canAttach)
  const [secretForm, setSecretForm] = useState<SecretCandidate | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const pendingKey = secrets?.pendingNames.join(',') ?? ''
  const candidates = useMemo(
    () => (secrets ? detectSecrets(message, pendingKey ? pendingKey.split(',') : []).filter(c => !dismissed.has(c.value)) : []),
    [message, pendingKey, dismissed, secrets],
  )
  const candidate = candidates[0]

  function onSecretSaved(name: string) {
    const value = secretForm?.value
    if (value) setMessage(m => redactValue(m, value, name))
    setSecretForm(null)
    setSavedNote(`${name} saved. The value is hidden for good; the session was told the name.`)
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return
    const files = filesFromClipboard(e)
    if (!files) return
    e.preventDefault()
    handleUpload(files)
  }

  return (
    <div className="border-t border-line bg-surface-2">
      <div className="mx-auto max-w-4xl px-3 py-3">
        {/* Attached files chips */}
        {attachedFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedFiles.map((f, i) => {
              const isImage = f.mimetype.startsWith('image/')
              return (
                <Badge key={i} tone="neutral" className="gap-1.5 py-1">
                  {isImage ? <ImageIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-3" /> : <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-3" />}
                  <span className="max-w-[150px] truncate">{f.originalName}</span>
                  <span className="font-mono text-fg-3">{formatFileSize(f.size)}</span>
                  <RowButton onClick={() => removeFile(i)} aria-label="Remove file" className="ml-0.5 rounded-sm text-fg-3 hover:text-flag-blocked"><X className="h-3 w-3" /></RowButton>
                </Badge>
              )
            })}
          </div>
        )}
        {/* obj 719065 — a pasted key: offer to save it instead of sending it */}
        {candidate && !secretForm && (
          <div role="alert" className="cc-pop-in mb-2 flex flex-col gap-2 rounded-md border border-status-human/30 bg-status-human/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-sm text-fg-1">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-human" aria-hidden />
              <span>
                This looks like a key{candidate.suggestedName ? <> (<span className="font-mono text-fg-0">{candidate.suggestedName}</span>)</> : ''}. Save it as a secret instead of sending it as chat text?
              </span>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" onClick={() => setDismissed(d => new Set(d).add(candidate.value))}>Keep as text</Button>
              <Button size="sm" variant="primary" className="min-h-[44px] sm:min-h-0" onClick={() => setSecretForm(candidate)}>Save as secret</Button>
            </div>
          </div>
        )}
        {/* obj 900670 — same masked form the agent's request uses, inline. */}
        {secrets && secretForm && (
          <div className="cc-pop-in mb-2 space-y-2 rounded-md border border-status-human/30 bg-status-human/5 px-3 py-2.5">
            <div className="flex items-center gap-2 text-sm text-fg-1">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-status-human" aria-hidden />
              <span>Save as a secret — your message keeps a [REDACTED] marker in its place.</span>
            </div>
            <SecretForm
              objectiveId={secrets.objectiveId}
              workspace={secrets.workspace}
              initialName={secretForm.suggestedName ?? ''}
              initialValue={secretForm.value}
              mode="add"
              idPrefix={`composer-secret-${secrets.objectiveId}`}
              onSaved={onSecretSaved}
              onCancel={() => setSecretForm(null)}
            />
          </div>
        )}
        {savedNote && (
          <div role="status" className="mb-2 flex items-center justify-between rounded-md bg-success/10 px-3 py-1.5 text-xs text-success">
            <span>{savedNote}</span>
            <IconButton size="sm" label="Dismiss" onClick={() => setSavedNote(null)} className="-my-1 ml-2 text-success/70 hover:bg-success/10 hover:text-success"><X className="h-3.5 w-3.5" /></IconButton>
          </div>
        )}
        {sendError && (
          <div className="mb-2 flex items-center justify-between rounded-md bg-flag-blocked/10 px-3 py-1.5 text-xs text-flag-blocked">
            <span>{sendError}</span>
            <IconButton size="sm" label="Dismiss error" onClick={() => setSendError(null)} className="-my-1 ml-2 text-flag-blocked/60 hover:bg-flag-blocked/10 hover:text-flag-blocked"><X className="h-3.5 w-3.5" /></IconButton>
          </div>
        )}
        <div
          {...dropProps}
          className={`flex items-end gap-2 rounded-lg border bg-surface-0 px-2 py-1.5 transition-colors ${
            isDragging
              ? 'border-dashed border-accent bg-accent/5'
              : 'border-line focus-within:border-accent'
          }`}
        >
          {/* raw-control: hidden file input, opened by the Attach IconButton. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => e.target.files && handleUpload(e.target.files)}
          />
          {/* Attach button */}
          <IconButton
            label="Attach files"
            onClick={() => fileInputRef.current?.click()}
            disabled={inputDisabled || uploading}
            className="shrink-0 text-fg-3 hover:text-accent"
          >
            <Paperclip className={`h-4 w-4 ${uploading ? 'animate-pulse' : ''}`} />
          </IconButton>
          {/* raw-control: the borderless autosize composer field inside its own frame. */}
          <textarea
            ref={messageRef}
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSendMessage()
              }
            }}
            onPaste={handlePaste}
            placeholder={
              isDragging
                ? 'Drop files to attach…'
                : narrow
                  ? 'Message…'
                  : isActive
                    ? 'Send follow-up message…'
                    : 'Send follow-up to start new session…'
            }
            disabled={inputDisabled}
            rows={1}
            className="min-w-0 flex-1 resize-none bg-transparent py-1.5 font-sans text-lg text-fg-0 placeholder-fg-3 focus:outline-none disabled:opacity-50 sm:text-base"
          />
          <div className="flex shrink-0 items-center gap-1.5">
            {isActive && (
              <Button
                size="sm"
                variant="danger"
                onClick={handleStop}
                disabled={interrupting}
                title="Stop this card. The bot stops and the card moves to review."
              >
                {interrupting ? 'Stopping...' : 'Stop'}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              onClick={handleSendMessage}
              disabled={(!message.trim() && attachedFiles.length === 0) || sending}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
