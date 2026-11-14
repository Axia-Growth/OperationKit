import {
  createToaster,
  Toast as SdkToast,
  ToastClose,
  ToastDescription,
  ToastRegion,
  ToastTitle,
  type ToastRegionProps,
} from '@ui-sdk/react/toast'
import { cn } from './cn'

/* Toaster — transient feedback ("Started", "Blocked: …") on the UI SDK toast
   (obj 900819). Every toast is announced once through the SDK's shared live
   regions (polite; `toast.error` is assertive) without stealing focus; F6
   reaches the stack, Escape dismisses the focused toast, timers pause on
   hover / focus / a hidden page.

     import { toast } from './ui/Toaster'
     toast.success('Nightly digest started')
     toast.error('Nightly digest blocked', { description: 'queue depth guard' })

   `toast` is ONE app-wide queue; `<Toaster />` (its visible stack) is mounted
   once in App.tsx. A toast fired with no Toaster mounted (a unit test) is still
   queued and announced, just not drawn. For an inline, persistent message use
   ui/Alert instead. */
export const toast = createToaster()

/** Dot colour per SDK toast type (data-type on the toast). */
const DOT =
  'bg-status-working group-data-[type=success]:bg-signal-verify group-data-[type=warning]:bg-signal-amber group-data-[type=error]:bg-signal-alarm group-data-[type=loading]:bg-fg-3'

export function Toaster({
  toaster = toast,
  label = 'Status messages',
}: {
  /** The queue to draw. Tests pass their own from `createToaster()`. */
  toaster?: ToastRegionProps['toaster']
  /** Landmark name, while the stack has toasts. */
  label?: string
}) {
  return (
    <ToastRegion
      toaster={toaster}
      side="bottom"
      align="end"
      maxVisible={4}
      aria-label={label}
      className="fixed inset-auto bottom-4 right-4 m-0 w-[320px] max-w-[calc(100vw-2rem)] overflow-visible border-0 bg-transparent p-0 [&>ol]:flex [&>ol]:flex-col [&>ol]:gap-2"
    >
      {() => (
        <SdkToast className="group pointer-events-auto flex gap-2.5 rounded-lg border border-line bg-surface-3 p-3 shadow-float data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 transition-opacity duration-fast ease-out">
          <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', DOT)} aria-hidden="true" />
          <div className="min-w-0 flex-1 text-sm leading-relaxed">
            <ToastTitle className="break-words font-medium text-fg-0" />
            <ToastDescription className="break-words text-fg-2" />
          </div>
          <ToastClose
            aria-label="Dismiss"
            className="-mr-1 -mt-1 h-6 w-6 shrink-0 rounded text-fg-3 transition-colors duration-fast hover:bg-surface-4 hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            ×
          </ToastClose>
        </SdkToast>
      )}
    </ToastRegion>
  )
}
