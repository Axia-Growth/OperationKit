import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent } from 'react'
import { FileText, Image as ImageIcon, Info, Paperclip, X } from 'lucide-react'
import type { Objective, SessionMessage } from '@operationkit/shared'
import { api } from '../lib/api'
import { formatBytes, friendlyError } from '../lib/format'
import { Modal } from './ui/Modal'
import { IconButton } from './ui/Button'
import { useConfirm } from './ui/ConfirmDialog'
import { filesFromClipboard, useFileDrop } from '../hooks/useFileDrop'
import { GroupedMessages } from './SessionMessages'
import { FileEditorOverlay } from './FileEditorOverlay'

interface PlanningPanelProps {
  objective: Objective
  onClose: () => void
  onApproved: (updated: Objective) => void
}

interface UploadedFile {
  originalName: string
  path: string
  size: number
  mimetype: string
}

/**
 * Q&A panel for the planning stage. Spawns a planner sub-session, polls it for
 * output, and lets the user iterate until they approve the plan. On approval
 * the objective transitions to queue with `approved_plan` populated.
 */
export function PlanningPanel({ objective: initialObjective, onClose, onApproved }: PlanningPanelProps) {
  const [objective, setObjective] = useState(initialObjective)
  useEffect(() => setObjective(initialObjective), [initialObjective])

  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [editingDocPath, setEditingDocPath] = useState<string | null>(null)
  const [attachedFiles, setAttachedFiles] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const messageCountRef = useRef(0)
  const fetchingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const { confirm, confirmDialog } = useConfirm()

  // Reset incremental state when objective changes
  useEffect(() => {
    setMessages([])
    messageCountRef.current = 0
    setAttachedFiles([])
  }, [initialObjective.id])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [message])

  // If the objective has no planning_session_id yet, offer a Start button.
  const sessionStarted = !!objective.planning_session_id

  const fetchMessages = useCallback(async () => {
    if (!sessionStarted || fetchingRef.current) return
    fetchingRef.current = true
    try {
      const after = messageCountRef.current
      const path = after > 0
        ? `/objectives/${objective.id}/planning/messages?after=${after}`
        : `/objectives/${objective.id}/planning/messages`
      const data = await api.get<{ messages: SessionMessage[]; total?: number; status?: string }>(path)
      // Race guard: if handleSend's optimistic-add bumped messageCountRef
      // while we were awaiting, applying this payload would duplicate the
      // followup the optimistic block already appended. Drop it; next tick
      // fetches cleanly from the new offset.
      if (messageCountRef.current !== after) return
      const newMessages = data.messages || []
      const total = data.total ?? newMessages.length
      if (after > 0 && newMessages.length > 0) {
        setMessages(prev => [...prev, ...newMessages])
      } else if (after === 0) {
        setMessages(newMessages)
      }
      messageCountRef.current = total
    } catch {}
    fetchingRef.current = false
  }, [objective.id, sessionStarted])

  useEffect(() => {
    if (!sessionStarted) return
    fetchMessages()
    const interval = setInterval(fetchMessages, 2500)
    return () => clearInterval(interval)
  }, [fetchMessages, sessionStarted])

  // Auto-scroll on new messages
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length])

  // Clickable doc-path handler (event delegation) — mirrors SessionViewer so
  // markdown file links in planner messages open the editor overlay.
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    function handleDocClick(e: MouseEvent) {
      const link = (e.target as HTMLElement).closest('[data-doc-path]') as HTMLElement | null
      if (!link) return
      e.preventDefault()
      const docPath = link.getAttribute('data-doc-path')
      if (docPath) setEditingDocPath(docPath)
    }
    container.addEventListener('click', handleDocClick)
    return () => container.removeEventListener('click', handleDocClick)
  }, [sessionStarted])

  async function handleStart() {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      const data = await api.post<{ session_id: string }>(`/objectives/${objective.id}/planning/start`, {})
      setObjective(prev => ({ ...prev, planning_session_id: data.session_id }))
    } catch (e) {
      setError(`Could not start the planner. ${friendlyError(e).message}`)
    }
    setStarting(false)
  }

  async function handleUpload(fileList: FileList) {
    if (fileList.length === 0) return
    setUploading(true)
    const formData = new FormData()
    for (const file of Array.from(fileList)) {
      formData.append('files', file)
    }
    try {
      // Raw fetch required for multipart/form-data uploads — api client sets JSON content-type
      const res = await fetch(`/api/objectives/${objective.id}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      if (res.ok) {
        const data = await res.json()
        setAttachedFiles(prev => [...prev, ...data.files])
      } else {
        setError('The upload did not work. Try again.')
      }
    } catch {
      setError('The upload did not work. Check your connection and try again.')
    }
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeFile(index: number) {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index))
  }


  const { isDragging, dropProps } = useFileDrop(handleUpload, !uploading && !sending)

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (uploading || sending) return
    const files = filesFromClipboard(e)
    if (!files) return
    e.preventDefault()
    void handleUpload(files)
  }

  async function handleSend() {
    if ((!message.trim() && attachedFiles.length === 0) || sending) return
    const text = message.trim() || '(see attached files)'
    setSending(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { message: text }
      if (attachedFiles.length > 0) {
        body.filePaths = attachedFiles.map(f => f.path)
      }
      await api.post(`/objectives/${objective.id}/planning/message`, body)
      setMessage('')
      setAttachedFiles([])
      const optimistic: SessionMessage = { type: 'followup', text, timestamp: new Date().toISOString() }
      setMessages(prev => [...prev, optimistic])
      messageCountRef.current += 1
      setTimeout(() => fetchMessages(), 500)
    } catch (e) {
      setError(`Could not send your message. ${friendlyError(e).message}`)
    }
    setSending(false)
  }

  async function handleApprove() {
    if (approving) return
    setApproving(true)
    setError(null)
    try {
      const updated = await api.post<Objective>(`/objectives/${objective.id}/planning/approve`, {})
      onApproved(updated)
    } catch (e) {
      setError(`Could not approve the plan. ${friendlyError(e).message} The planner's latest reply may not contain a plan yet.`)
    }
    setApproving(false)
  }

  async function handleCancel() {
    const ok = await confirm({
      title: 'Cancel planning?',
      message: 'The conversation is preserved; you can resume by re-opening planning.',
      confirmLabel: 'Cancel planning',
      cancelLabel: 'Keep planning',
    })
    if (!ok) return
    try {
      await api.post(`/objectives/${objective.id}/planning/cancel`, {})
      onClose()
    } catch (e) {
      setError(`Could not cancel planning. ${friendlyError(e).message}`)
    }
  }

  return (
    // Full-screen dialog on ui/Modal (UI SDK Dialog): page behind inert, focus
    // trapped, Escape closes, focus returns to the card that opened it. The
    // backdrop is covered edge-to-edge, so a press outside cannot happen.
    <Modal
      open
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="flex flex-col inset-0 m-0 h-full max-h-none w-full max-w-none rounded-none border-0 overflow-x-hidden overflow-y-hidden bg-surface shadow-none"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3 bg-surface-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="rounded bg-status-planning/20 text-status-planning border border-status-planning/30 px-1.5 py-0.5 text-xs font-semibold"
              title={objective.planning_session_id ? `Planner session: ${objective.planning_session_id}` : undefined}
            >PLANNING</span>
            <h3 id={titleId} className="text-base font-medium text-fg-0 truncate">{objective.title}</h3>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-3">
          {sessionStarted && (
            <>
              <button
                onClick={handleApprove}
                disabled={approving}
                className="rounded-lg bg-success hover:bg-success/90 px-3 py-1.5 text-xs font-medium text-surface-1 disabled:opacity-50"
              >
                {approving ? 'Approving…' : 'Approve plan'}
              </button>
              <button
                onClick={handleCancel}
                className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-fg-2 border border-line hover:text-fg-0 hover:border-line-strong"
              >
                Cancel planning
              </button>
            </>
          )}
          <IconButton label="Close" onClick={onClose}>
            <X aria-hidden="true" className="h-5 w-5" />
          </IconButton>
        </div>
      </div>

      {!sessionStarted && (
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="max-w-md text-center space-y-4">
            <p className="text-base text-fg-2">
              This is a project card, so it starts in the planning stage. A read-only planner will ask you clarifying questions, then write a plan for you to approve. Approving the plan starts the bot — you do not click Start again.
            </p>
            <button
              onClick={handleStart}
              disabled={starting}
              className="rounded-md bg-status-planning/90 hover:bg-status-planning px-4 py-2 text-base font-medium text-surface-0 disabled:opacity-50 transition-colors duration-fast ease-out"
            >
              {starting ? 'Starting planner…' : 'Start planning'}
            </button>
            <div>
              <button
                onClick={async () => {
                  try {
                    await api.patch(`/objectives/${objective.id}/status`, { status: 'queue' })
                    onClose()
                  } catch (e) {
                    setError(`Could not skip planning. ${friendlyError(e).message}`)
                  }
                }}
                className="text-xs text-fg-2 hover:text-fg-1 underline"
              >
                Skip planning, send straight to queue
              </button>
            </div>
            {error && (
              <div className="rounded bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
            )}
          </div>
        </div>
      )}

      {sessionStarted && (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto px-3 py-4 space-y-2">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-3 mt-16">
                  <div className="flex items-center gap-1.5">
                    <span className="cc-think-dot text-status-planning" />
                    <span className="cc-think-dot text-status-planning" />
                    <span className="cc-think-dot text-status-planning" />
                  </div>
                  <div className="text-base text-fg-2">Planner is loading context…</div>
                </div>
              )}
              <GroupedMessages messages={messages} />
            </div>
          </div>

          <div className="border-t border-line bg-surface-1">
            <div className="max-w-4xl mx-auto px-3 pt-2 pb-3">
              <div className="mb-2 rounded bg-surface px-3 py-1.5 text-xs text-fg-2 border border-line/60 flex items-center gap-2">
                <Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />
                <span>Planner is read-only. Click <span className="text-success font-medium">Approve plan</span> to lock the plan and start the bot.</span>
              </div>
              {error && (
                <div className="mb-2 rounded bg-danger/10 px-3 py-1.5 text-xs text-danger flex items-center justify-between">
                  <span>{error}</span>
                  <button onClick={() => setError(null)} aria-label="Dismiss error" className="ml-2 text-danger/60 hover:text-danger"><X aria-hidden="true" className="h-3.5 w-3.5" /></button>
                </div>
              )}
              {/* Attached files chips */}
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {attachedFiles.map((f, i) => {
                    const isImage = f.mimetype.startsWith('image/')
                    return (
                      <span key={i} className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 border border-line px-2 py-1 text-xs text-fg-1">
                        {isImage ? <ImageIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-3" /> : <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-3" />}
                        <span className="truncate max-w-[150px]">{f.originalName}</span>
                        <span className="text-fg-3">{formatBytes(f.size)}</span>
                        <button onClick={() => removeFile(i)} aria-label="Remove file" className="text-fg-2 hover:text-danger ml-0.5"><X aria-hidden="true" className="h-3 w-3" /></button>
                      </span>
                    )
                  })}
                </div>
              )}
              <div
                {...dropProps}
                className={`flex items-end gap-2 rounded-lg border bg-surface px-2 py-1.5 transition-colors ${isDragging ? 'border-accent border-dashed bg-accent/5' : 'border-line focus-within:border-accent'}`}
              >
                {/* Hidden file input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={e => e.target.files && handleUpload(e.target.files)}
                />
                {/* Attach button */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || sending}
                  className="mb-1 shrink-0 rounded p-1 text-fg-2 hover:text-accent disabled:opacity-40 transition-colors"
                  title="Attach files"
                >
                  <Paperclip className={`h-4 w-4 ${uploading ? 'animate-pulse' : ''}`} />
                </button>
                <textarea
                  ref={textareaRef}
                  data-autofocus
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  onPaste={handlePaste}
                  placeholder={isDragging ? 'Drop files to attach…' : "Answer the planner's questions, or say 'approve' to lock the plan..."}
                  rows={1}
                  className="flex-1 resize-none bg-transparent py-1.5 text-lg sm:text-base text-fg-0 placeholder-fg-3 focus:outline-none font-mono"
                />
                <button
                  onClick={handleSend}
                  disabled={(!message.trim() && attachedFiles.length === 0) || sending}
                  className="mb-1 shrink-0 rounded-md bg-accent px-3 py-1 text-base font-medium text-accent-fg disabled:opacity-40"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {editingDocPath && (
        <FileEditorOverlay filePath={editingDocPath} onClose={() => setEditingDocPath(null)} />
      )}
      {confirmDialog}
    </Modal>
  )
}
