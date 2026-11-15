import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from './ui/Button'

interface ErrorBoundaryProps {
  children: ReactNode
  /**
   * `app` (default) — the last-resort boundary around the whole tree: fills the
   *   screen, offers Reload.
   * `route` — the per-route boundary inside Layout (polish F8): fills only the
   *   page area so the top bar and nav keep working, offers Try again (re-mount
   *   the page) as well as Reload.
   */
  scope?: 'app' | 'route'
  /** When this value changes the boundary clears its error — App passes the
   *  pathname, so navigating away from a crashed page recovers on its own. */
  resetKey?: unknown
}

interface ErrorBoundaryState {
  error: Error | null
  componentStack: string | null
  resetKey: unknown
}

/**
 * ErrorBoundary — friendly crash surface. Plain-language copy up front; the raw
 * message and component stack sit in a collapsed "Technical details" disclosure
 * for whoever has to report it, instead of being the headline.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null, componentStack: null, resetKey: props.resetKey }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { resetKey: props.resetKey, error: null, componentStack: null }
    }
    return null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.scope ?? 'app'}] Uncaught render error:`, error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? null })
  }

  private reset = () => this.setState({ error: null, componentStack: null })

  render() {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    const isRoute = this.props.scope === 'route'
    const details = [error.name && error.message ? `${error.name}: ${error.message}` : String(error), componentStack?.trim()]
      .filter(Boolean)
      .join('\n\n')

    return (
      <div
        role="alert"
        data-testid={isRoute ? 'route-error' : 'app-error'}
        className={isRoute
          ? 'flex h-full min-h-0 flex-1 items-center justify-center overflow-y-auto p-6'
          : 'flex h-full items-center justify-center bg-surface p-6'}
      >
        <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-lg border border-line bg-surface-3 text-fg-2">
            <TriangleAlert className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <p className="font-display text-lg font-semibold tracking-tight text-fg-0">
              {isRoute ? "This page couldn't load" : 'Something went wrong'}
            </p>
            <p className="mx-auto max-w-[44ch] text-sm leading-relaxed text-fg-2">
              {isRoute
                ? 'Something on this page broke. The rest of the app still works: try again, or pick another page.'
                : 'The app hit an unexpected problem. Reloading usually fixes it.'}
            </p>
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            {isRoute && <Button variant="primary" onClick={this.reset}>Try again</Button>}
            <Button variant={isRoute ? 'secondary' : 'primary'} onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
          <details className="mt-2 w-full text-left">
            <summary className="cursor-pointer select-none text-center text-xs text-fg-3 hover:text-fg-1">
              Technical details
            </summary>
            <pre
              data-testid="error-details"
              className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-1 p-3 font-mono text-xs text-fg-2"
            >
              {details}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}
