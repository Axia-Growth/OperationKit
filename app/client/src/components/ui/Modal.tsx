import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Dialog, DialogBackdrop, DialogContent } from '@ui-sdk/react/dialog'
import { cn } from './cn'

/* ─────────────────────────────────────────────────────────
   Modal — the ONE overlay wrapper for the platform, on the UI SDK dialog
   behavior (obj 900819). The SDK puts the panel in the browser's top layer,
   makes the page behind it inert (screen readers and Tab can no longer reach
   it), traps focus, closes on Escape and outside press, and returns focus
   to where it was. Motion keeps the shipped vocabulary: `center` pops in
   (`cc-pop-in`), `sheet` slides up on a phone (`cc-sheet-in`) and in from
   the right on desktop (`cc-drawer-in`), all reduced-motion guarded.

   Presentation only — colours and spacing come from tokens; confirm
   semantics live in ConfirmDialog.
   ───────────────────────────────────────────────────────── */

type Variant = 'center' | 'sheet'
/* Shared overlay widths (polish F4, #900805). Every centered overlay picks one
   of these instead of its own max-w: sm = small forms, md = default dialogs,
   lg = the card editor, the card search and the command palette. */
export type ModalSize = 'sm' | 'md' | 'lg'
export const MODAL_WIDTH: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-xl',
}
/* `top` pins a launcher (palette, search) near the top so its height can grow
   with results without the panel jumping around the vertical centre. */
const TOP_PLACEMENT = 'top-[12vh] bottom-auto mt-0'

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  children,
  variant = 'center',
  labelledBy,
  describedBy,
  className,
  panelClassName,
  closeOnBackdrop = true,
  size = 'md',
  placement = 'center',
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  variant?: Variant
  labelledBy?: string
  describedBy?: string
  /** Extra classes on the backdrop. */
  className?: string
  /** Extra classes on the panel (sizing, etc.). */
  panelClassName?: string
  closeOnBackdrop?: boolean
  /** Width of a `center` panel, from the shared scale. */
  size?: ModalSize
  /** `top` = a launcher anchored near the top of the viewport. */
  placement?: 'center' | 'top'
}) {
  // Parents pass inline closures, so onClose changes identity on every render
  // (the board re-renders every ~3s for live sessions). Read it through a ref
  // so nothing re-subscribes or moves focus on those renders (obj 700071).
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // Most callers unmount the Modal to close it rather than flipping `open`.
  // The SDK returns focus on a close it sees; an unmount it never sees, so put
  // focus back on the element that had it before the dialog opened.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  if (open && restoreRef.current === null && typeof document !== 'undefined') {
    const active = document.activeElement
    restoreRef.current = active instanceof HTMLElement && active !== document.body ? active : null
  }
  if (!open) restoreRef.current = null
  useEffect(() => {
    return () => {
      const back = restoreRef.current
      if (!back) return
      queueMicrotask(() => {
        const now = document.activeElement
        if ((!now || now === document.body) && back.isConnected) back.focus()
      })
    }
  }, [])

  const isSheet = variant === 'sheet'

  return createPortal(
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCloseRef.current()
      }}
      closeOnOutsidePress={closeOnBackdrop}
    >
      <DialogBackdrop className={cn('cc-backdrop-in fixed inset-0 z-50 bg-[var(--scrim)]', className)} />
      <DialogContent
        ref={contentRef}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        initialFocus={() => {
          const panel = contentRef.current
          if (!panel) return null
          return panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel
        }}
        className={cn(
          'fixed z-50 m-0 overflow-y-auto border border-line bg-surface-1 p-0 text-fg-0 shadow-float outline-none',
          isSheet
            ? 'cc-sheet-in sm:cc-drawer-in inset-x-0 bottom-0 top-auto max-h-[88vh] w-full max-w-none rounded-t-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:h-full sm:max-h-none sm:w-[440px] sm:rounded-none sm:rounded-l-2xl sm:border-y-0 sm:border-r-0'
            : cn(
                'cc-pop-in inset-0 m-auto h-fit max-h-[88vh] w-[calc(100%-2rem)] rounded-xl',
                MODAL_WIDTH[size],
                placement === 'top' && TOP_PLACEMENT,
              ),
          panelClassName,
        )}
      >
        {children}
      </DialogContent>
    </Dialog>,
    document.body,
  )
}
