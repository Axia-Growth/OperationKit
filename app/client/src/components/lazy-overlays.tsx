import { lazy, Suspense, type ComponentProps } from 'react'

/* Interaction-only overlays, loaded on first open (obj 900819). The ⌘K palette
   and the "/" card search pull in the UI SDK command list; neither shows until
   someone presses a key, so they stay out of the first-load bundle. Closed,
   these render nothing and fetch nothing. */

const CommandPaletteImpl = lazy(() => import('./CommandPalette').then(m => ({ default: m.CommandPalette })))
const ObjectiveSearchPanelImpl = lazy(() => import('./ObjectiveSearchPanel').then(m => ({ default: m.ObjectiveSearchPanel })))

type PaletteProps = ComponentProps<typeof import('./CommandPalette').CommandPalette>
type SearchProps = ComponentProps<typeof import('./ObjectiveSearchPanel').ObjectiveSearchPanel>

export function CommandPalette(props: PaletteProps) {
  if (!props.open) return null
  return (
    <Suspense fallback={null}>
      <CommandPaletteImpl {...props} />
    </Suspense>
  )
}

export function ObjectiveSearchPanel(props: SearchProps) {
  if (!props.open) return null
  return (
    <Suspense fallback={null}>
      <ObjectiveSearchPanelImpl {...props} />
    </Suspense>
  )
}
