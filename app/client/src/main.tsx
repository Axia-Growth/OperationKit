import { StrictMode } from 'react'
import { LucideProvider } from 'lucide-react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { loadBranding } from './hooks/useBranding'
import { initTheme } from './lib/theme'

// Theme (obj 900543): ONE store (lib/theme.ts) painted on <html data-theme>
// before first paint — the explicit toggle choice, else the OS preference.
initTheme()

// Install branding (name, accent tokens, favicon) — loadBranding() publishes
// to the tab title, CSS tokens and favicon as soon as /api/branding answers.
// index.html is served with the install's own name + favicon already injected
// (server routes/branding.ts renderBrandedIndex), so there is no default-brand
// flash before this resolves.
void loadBranding()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* One icon stroke app-wide (polish F1); icons no longer set their own. */}
    <LucideProvider strokeWidth={1.75}>
      <App />
    </LucideProvider>
  </StrictMode>
)
