import { useCallback, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@ui-sdk/react/alert-dialog'
import { Button } from './Button'

/* ─────────────────────────────────────────────────────────
   ConfirmDialog + useConfirm — the in-app, themed replacement for
   native window.confirm() (audit OK-28). The native OS dialog blocks
   the thread and looks nothing like Mission Control; this renders the
   same question on the UI SDK alert dialog (role=alertdialog, focus trap,
   Escape = Cancel, focus returns to the trigger).

   Drop-in usage (turns the imperative `if (confirm(...))` into await):

     const { confirm, confirmDialog } = useConfirm()
     ...
     if (await confirm({ title: 'Delete objective?', message: '…', danger: true }))
       doDelete()
     ...
     return (<>{ ...page... }{confirmDialog}</>)
   ───────────────────────────────────────────────────────── */

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface State extends ConfirmOptions {
  open: boolean
}

export function useConfirm() {
  const [state, setState] = useState<State>({ open: false, title: '' })
  const resolver = useRef<((v: boolean) => void) | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => {
    setState({ ...opts, open: true })
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const settle = useCallback((v: boolean) => {
    resolver.current?.(v)
    resolver.current = null
    setState((s) => ({ ...s, open: false }))
  }, [])

  const confirmDialog = (
    <ConfirmDialog
      {...state}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  )

  return { confirm, confirmDialog }
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: State & { onConfirm: () => void; onCancel: () => void }) {
  // Alert dialog (obj 900819): role=alertdialog, always modal, focus starts on
  // Cancel, an outside press never answers it; Escape counts as Cancel.
  return createPortal(
    <AlertDialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return
        if (details.returnValue === 'confirm') onConfirm()
        else onCancel()
      }}
    >
      <AlertDialogBackdrop className="cc-backdrop-in fixed inset-0 z-50 bg-[var(--scrim)]" />
      <AlertDialogContent className="cc-pop-in fixed inset-0 z-50 m-auto h-fit w-[calc(100%-2rem)] max-w-sm rounded-xl border border-line bg-surface-1 p-5 text-fg-0 shadow-float outline-none">
        <AlertDialogTitle className="font-display text-lg font-semibold tracking-tight text-fg-0">{title}</AlertDialogTitle>
        {message && <AlertDialogDescription className="mt-2 text-sm leading-relaxed text-fg-2">{message}</AlertDialogDescription>}
        <div className="mt-5 flex justify-end gap-2">
          <AlertDialogClose value="cancel" render={<Button variant="ghost" size="sm" />}>
            {cancelLabel}
          </AlertDialogClose>
          <AlertDialogClose value="confirm" render={<Button variant={danger ? 'danger' : 'primary'} size="sm" />}>
            {confirmLabel}
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>,
    document.body,
  )
}
