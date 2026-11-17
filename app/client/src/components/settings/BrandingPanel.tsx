import { useEffect, useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { Card, CardHeader, CardBody } from '../ui/Card'
import { Button } from '../ui/Button'
import { CopyButton } from '../ui/CopyButton'
import { Alert, Checkbox, Field, Input, SettingsSection, useConfirm } from '../ui'
import type { Branding, BrandTokens } from '../../hooks/useBranding'
import { invalidateBranding, brandTokenVars } from '../../hooks/useBranding'
import { deriveAccent } from '@operationkit/shared'
import { BrandLogo } from '../BrandLogo'
import { useAuth } from '../../context/AuthContext'

/** Copy-paste prompt for "have your coding agent set this up" (goal #5, docs/branding.md). */
export function brandingAgentPrompt(websiteUrl: string): string {
  const url = websiteUrl.trim() || '<your company website URL>'
  return `Here is my company website: ${url}. Read the brand colors and logo from it and configure this install's branding (name, colors, logo files) via the env/config file per docs/branding.md.`
}

/* obj 900750: the accent is the ONE brand lever. Its hover / pressed /
   text-on-accent shades are derived from it automatically (shared/brand-color)
   unless an admin pins one; the semantic status colours are not brand colours
   and live under "Advanced". */
type DerivedKey = 'accentHover' | 'accentPress' | 'accentFg'
const DERIVED_FIELDS: Array<{ key: DerivedKey; label: string; from: 'hover' | 'press' | 'fg' }> = [
  { key: 'accentHover', label: 'Hover', from: 'hover' },
  { key: 'accentPress', label: 'Pressed', from: 'press' },
  { key: 'accentFg', label: 'Text on accent', from: 'fg' },
]
const SEMANTIC_FIELDS: Array<{ key: keyof BrandTokens; label: string }> = [
  { key: 'verify', label: 'Success (light)' },
  { key: 'verifyOnDark', label: 'Success (dark)' },
  { key: 'caution', label: 'Danger (light)' },
  { key: 'cautionOnDark', label: 'Danger (dark)' },
]
const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v)

/**
 * Save payload (obj 900750). Sends only what the admin actually decided, so a
 * Save never freezes the shipped defaults into config/branding.json:
 * - derived shades: a pinned shade is sent as its value; an "Auto" one as ''
 *   (cleared → derived server-side from the accent);
 * - the accent and the semantic status colours: sent only when they differ
 *   from what the server returned on load (`saved`). Omitted keys leave the
 *   file untouched (the server merges).
 * Env-locked fields are never sent.
 */
export function brandingSavePayload(
  t: BrandTokens,
  saved: BrandTokens | null,
  pinned: ReadonlySet<string>,
  locked: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  const changed = (k: keyof BrandTokens) => !saved || t[k].trim().toLowerCase() !== saved[k].trim().toLowerCase()
  if (!locked.has('accent') && changed('accent')) out.accent = t.accent
  for (const f of DERIVED_FIELDS) {
    if (locked.has(f.key)) continue
    out[f.key] = pinned.has(f.key) ? t[f.key] : ''
  }
  for (const f of SEMANTIC_FIELDS) {
    if (!locked.has(f.key) && changed(f.key)) out[f.key] = t[f.key]
  }
  return out
}

const LOGO_SLOTS: Array<{ slot: 'wordmark' | 'wordmark-dark' | 'icon' | 'favicon'; label: string; help: string }> = [
  { slot: 'wordmark', label: 'Wordmark (light bg)', help: 'Full logo with product name, shown on light surfaces.' },
  { slot: 'wordmark-dark', label: 'Wordmark (dark bg)', help: 'Optional — falls back to the light-bg wordmark if unset.' },
  { slot: 'icon', label: 'Icon', help: 'Square mark used for the sign-in page and collapsed nav; also generates app icons.' },
  { slot: 'favicon', label: 'Favicon', help: 'Browser tab icon (.ico, .svg or .png). Falls back to the icon above if unset.' },
]

function HexInput({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; label: string }) {
  const auto = useId()
  const id = `hex${auto.replace(/:/g, '')}`
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-fg-1">
      <label htmlFor={id} className="w-36 shrink-0">{label}</label>
      <input
        type="color"
        aria-label={`${label} picker`}
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-line bg-surface-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Input
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="w-28 px-2 font-mono"
      />
    </div>
  )
}

/**
 * Settings > Branding panel (obj 900494). Admin-only. Sets the install's brand
 * name, accent/status palette and logos (wordmark/icon/favicon), with a live
 * preview and the copy-paste "set this up for me" agent prompt. Standalone and
 * exported so the settings-reorg card (Sprint 4b) can mount it — this
 * component does not touch settings navigation itself.
 */
export function BrandingPanel() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [branding, setBranding] = useState<Branding | null>(null)
  const [name, setName] = useState('')
  const [tokens, setTokens] = useState<BrandTokens | null>(null)
  // Derived shades the admin pinned by hand; the rest follow the accent.
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [poweredBy, setPoweredBy] = useState(false)
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  useEffect(() => {
    let cancelled = false
    fetch('/api/branding', { credentials: 'include' })
      .then(r => r.json())
      .then((b: Branding) => {
        if (cancelled) return
        setBranding(b)
        setName(b.name)
        setTokens(b.tokens)
        setPinned(new Set(b.explicit_token_fields ?? []))
        setPoweredBy(!!b.powered_by)
      })
      .catch(err => !cancelled && setError(err instanceof Error ? err.message : 'Could not load branding'))
    return () => { cancelled = true }
  }, [])

  if (!isAdmin) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-fg-2">Only an admin can view or change branding.</p>
        </CardBody>
      </Card>
    )
  }

  const locked = new Set(branding?.env_locked_fields ?? [])

  function setToken(key: keyof BrandTokens, value: string) {
    setTokens(t => (t ? { ...t, [key]: value } : t))
  }

  /** Changing the accent re-derives every shade that isn't pinned, so the
   * preview shows exactly what Save will produce. */
  function setAccent(value: string) {
    setTokens(t => {
      if (!t) return t
      const next = { ...t, accent: value }
      if (isHex(value)) {
        const d = deriveAccent(value)
        for (const f of DERIVED_FIELDS) if (!pinned.has(f.key)) next[f.key] = d[f.from]
      }
      return next
    })
  }

  function togglePinned(key: DerivedKey, pin: boolean) {
    setPinned(p => {
      const n = new Set(p)
      if (pin) n.add(key)
      else n.delete(key)
      return n
    })
    if (!pin && tokens && isHex(tokens.accent)) {
      const f = DERIVED_FIELDS.find(x => x.key === key)!
      setToken(key, deriveAccent(tokens.accent)[f.from])
    }
  }

  function payloadTokens(t: BrandTokens): Record<string, string> {
    return brandingSavePayload(t, branding?.tokens ?? null, pinned, locked)
  }

  async function save() {
    if (!tokens) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = await fetch('/api/branding', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tokens: payloadTokens(tokens), powered_by: poweredBy }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Save failed')
      const b: Branding = await res.json()
      setBranding(b)
      setTokens(b.tokens)
      setPinned(new Set(b.explicit_token_fields ?? []))
      void invalidateBranding(b) // live-apply name, logo, tokens and favicon everywhere — no reload
      setNotice('Saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/branding/reset', { method: 'POST', credentials: 'include' })
      if (!res.ok) throw new Error('Reset failed')
      const b: Branding = await res.json()
      setBranding(b)
      setName(b.name)
      setTokens(b.tokens)
      setPinned(new Set(b.explicit_token_fields ?? []))
      setPoweredBy(!!b.powered_by)
      void invalidateBranding(b)
      setNotice('Reset to the default brand.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setSaving(false)
    }
  }

  async function uploadLogo(slot: string, file: File) {
    setUploading(slot)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/branding/upload/${slot}`, { method: 'POST', credentials: 'include', body: form })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Upload failed')
      const b: Branding = await res.json()
      setBranding(b)
      void invalidateBranding(b) // header, sign-in, favicon pick the new file up immediately
      setNotice(`${slot} updated.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(null)
    }
  }

  async function clearLogo(slot: string) {
    setUploading(slot)
    try {
      const res = await fetch(`/api/branding/upload/${slot}`, { method: 'DELETE', credentials: 'include' })
      if (res.ok) {
        const b: Branding = await res.json()
        setBranding(b)
        void invalidateBranding(b)
      }
    } finally {
      setUploading(null)
    }
  }

  // Destructive actions ask first (polish F5): Reset wipes the name and every
  // colour; Clear removes an uploaded logo file.
  async function confirmReset() {
    const ok = await confirm({
      title: 'Reset branding to the default?',
      message: 'The product name, every color and the “Powered by” setting go back to the defaults. Uploaded logos are kept. This cannot be undone.',
      confirmLabel: 'Reset branding',
      danger: true,
    })
    if (ok) await reset()
  }

  async function confirmClearLogo(slot: string, label: string) {
    const ok = await confirm({
      title: `Clear the ${label.toLowerCase()}?`,
      message: 'The uploaded file is removed and the default is shown instead.',
      confirmLabel: 'Clear',
      danger: true,
    })
    if (ok) await clearLogo(slot)
  }

  const assetUrl: Record<string, string | null> = {
    wordmark: branding?.wordmark_url ?? null,
    'wordmark-dark': branding?.wordmark_dark_url ?? null,
    icon: branding?.icon_url ?? null,
    favicon: branding?.favicon_url ?? null,
  }

  return (
    <div className="flex flex-col gap-4">
      {confirmDialog}
      {error && <Alert tone="alarm" title={error} />}
      {notice && !error && <Alert tone="verify" title={notice} />}

      <Card>
        <CardHeader
          title="Brand"
          actions={<Button size="sm" variant="primary" onClick={save} loading={saving}>Save</Button>}
        />
        <CardBody className="flex flex-col gap-4">
          <Field
            label="Product name"
            id="branding-name"
            hint={locked.has('name') ? 'Set via the OK_BRAND_NAME env var.' : undefined}
            className="max-w-sm"
          >
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={locked.has('name')}
              maxLength={60}
            />
          </Field>

          <Checkbox
            checked={poweredBy}
            onChange={e => setPoweredBy(e.target.checked)}
            disabled={locked.has('powered_by')}
            label="Show a small “Powered by” credit for the underlying platform on the sign-in page"
            description="Off by default — leave it off for a fully white-labeled install."
          />

          {tokens && (
            <div className="flex flex-col gap-3 border-t border-line-soft pt-4">
              <div>
                <div className="flex items-center gap-2">
                  <HexInput label="Accent color" value={tokens.accent} onChange={setAccent} disabled={locked.has('accent')} />
                  {locked.has('accent') && <span className="text-xs text-fg-3">env-locked</span>}
                </div>
                <p className="mt-1.5 text-xs text-fg-3 sm:pl-[9.5rem]">
                  Your one brand color — primary buttons, links, focus rings and the selected-item marker.
                  Pages, cards, navigation and text stay neutral in light and dark mode.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {DERIVED_FIELDS.map(f => {
                  const auto = !pinned.has(f.key) && !locked.has(f.key)
                  return (
                    <div key={f.key} className="flex flex-wrap items-center gap-2">
                      <HexInput
                        label={f.label}
                        value={tokens[f.key]}
                        onChange={v => { if (auto) togglePinned(f.key, true); setToken(f.key, v) }}
                        disabled={locked.has(f.key)}
                      />
                      {locked.has(f.key) ? (
                        <span className="text-xs text-fg-3">env-locked</span>
                      ) : (
                        <Checkbox
                          checked={auto}
                          onChange={e => togglePinned(f.key, !e.target.checked)}
                          aria-label={`${f.label}: auto from accent`}
                          label={<span className="text-xs text-fg-2">Auto (from accent)</span>}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
              <details className="group rounded-md border border-line-soft bg-surface-0 px-3 py-2">
                <summary className="cursor-pointer select-none rounded py-1.5 text-sm font-medium text-fg-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  Advanced — status colors
                  <span className="ml-2 font-normal text-fg-3">semantic, not brand; most installs never change these</span>
                </summary>
                <div className="mt-3 flex flex-col gap-2 pb-1">
                  {SEMANTIC_FIELDS.map(f => (
                    <div key={f.key} className="flex items-center gap-2">
                      <HexInput label={f.label} value={tokens[f.key]} onChange={v => setToken(f.key, v)} disabled={locked.has(f.key)} />
                      {locked.has(f.key) && <span className="text-xs text-fg-3">env-locked</span>}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </CardBody>
      </Card>

      {tokens && branding && <LivePreview tokens={tokens} name={name} branding={branding} />}

      <Card>
        <CardHeader title="Logos & favicon" eyebrow="SVG, PNG or ICO · 2MB max" />
        <CardBody className="flex flex-col gap-4">
          {LOGO_SLOTS.map(({ slot, label, help }) => (
            <div key={slot} className="flex flex-wrap items-center gap-3">
              <div
                className="flex h-12 w-24 shrink-0 items-center justify-center rounded-md border border-line"
                style={{ background: slot === 'wordmark-dark' ? '#0d1117' : '#ffffff' }}
              >
                {assetUrl[slot]
                  ? <img src={assetUrl[slot]!} alt="" className="max-h-10 max-w-20 object-contain" />
                  // The tile is a fixed light/dark preview background, so its hint
                  // text is fixed too (fg-3 vanished on white in dark mode).
                  : <span className="text-xs" style={{ color: slot === 'wordmark-dark' ? '#8b949e' : '#6b7280' }}>not set</span>}
              </div>
              {/* Below sm the label + description take their own full-width line above
                  the preview and buttons; side by side they shrank to ~40px on a phone
                  and read one word per line (card #901204). */}
              <div className="order-first w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
                <div className="text-sm text-fg-0">{label}</div>
                <div className="text-xs text-fg-3">{help}</div>
              </div>
              <label className="shrink-0">
                <input
                  type="file"
                  accept=".svg,.png,.ico,image/svg+xml,image/png,image/x-icon"
                  aria-label={`Upload ${label}`}
                  className="peer sr-only"
                  disabled={uploading === slot}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) void uploadLogo(slot, file)
                    e.target.value = ''
                  }}
                />
                <span className="inline-flex h-8 cursor-pointer items-center rounded-md border border-line bg-surface-2 px-3 text-sm font-medium text-fg-0 transition-colors duration-fast hover:border-line-strong hover:bg-surface-3 peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
                  {uploading === slot ? 'Uploading…' : 'Upload'}
                </span>
              </label>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void confirmClearLogo(slot, label)}
                disabled={uploading === slot}
              >
                Clear
              </Button>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Set this up with your coding agent" eyebrow="Copy-paste prompt" />
        <CardBody className="flex flex-col gap-3">
          <Field label="Company website" id="branding-website" className="max-w-sm">
            <Input
              type="url"
              placeholder="https://acme.com"
              value={websiteUrl}
              onChange={e => setWebsiteUrl(e.target.value)}
            />
          </Field>
          <div className="flex items-start gap-2">
            <pre className="flex-1 whitespace-pre-wrap rounded-md border border-line bg-surface-1 p-3 font-mono text-xs text-fg-1">
              {brandingAgentPrompt(websiteUrl)}
            </pre>
            <CopyButton size="sm" value={brandingAgentPrompt(websiteUrl)} />
          </div>
          <p className="text-xs text-fg-3">
            Paste this into Claude Code (or any coding agent) pointed at this repo. Full reference: docs/branding.md.
            Using a custom domain? See docs/custom-domain.md.
          </p>
        </CardBody>
      </Card>

      {/* Danger zone — kept away from Save (polish F5). */}
      <SettingsSection
        title="Reset branding"
        danger
        description="Puts the product name, every color and the “Powered by” setting back to the defaults. Uploaded logos are kept."
        actions={<Button size="sm" variant="danger" onClick={() => void confirmReset()} disabled={saving}>Reset to default</Button>}
      />
    </div>
  )
}

/* Status pills in the live preview. They read the semantic tokens the
   .brand-scope wrapper re-declares from the DRAFT colours (not the signal-*
   tokens ui/Badge uses), so the preview shows what Save will produce. */
const PREVIEW_STATUS_PILLS = [
  { label: 'Done', tone: 'border-success/30 bg-success/10 text-success' },
  { label: 'In review', tone: 'border-warning/30 bg-warning/10 text-warning' },
  { label: 'Blocked', tone: 'border-danger/30 bg-danger/10 text-danger' },
  { label: 'Working', tone: 'border-info/30 bg-info/10 text-info' },
] as const

/** Scoped live preview — applies the DRAFT tokens only to this subtree via
 * inline CSS custom properties, so editing doesn't repaint the whole app
 * until Save. */
function LivePreview({ tokens, name, branding }: { tokens: BrandTokens; name: string; branding: Branding }) {
  // Same variables applyBrandTokens sets on <html>, scoped to this subtree.
  // `.brand-scope` (index.css) re-declares the tokens DERIVED from them
  // (--accent-text, --accent-line, --accent-tint, --focus-ring, the status
  // colours) on the wrapper itself: a custom property resolves where it is
  // declared, so the :root versions would keep showing the SAVED accent.
  const safe = isHex(tokens.accent) ? tokens : { ...tokens, accent: branding.tokens.accent }
  const style = brandTokenVars(safe) as CSSProperties
  const draft: Branding = { ...branding, name: name || branding.name, tokens }
  return (
    <Card>
      <CardHeader title="Live preview" eyebrow="Updates as you edit, before you Save" />
      <CardBody>
        {/* A picture of the brand, not controls (obj 900807): inert, so the
            sample "Primary action" is not a second real primary on the page
            and cannot take focus or clicks. */}
        <div style={style} className="brand-scope flex flex-col gap-3 rounded-md border border-line bg-surface-0 p-4" inert data-brand-preview="">
          <div className="flex flex-wrap items-center gap-4">
            <BrandLogo branding={draft} size="md" />
            <Button variant="primary" size="sm">Primary action</Button>
            <Button variant="secondary" size="sm">Secondary</Button>
            <a href="#preview" onClick={e => e.preventDefault()} className="text-sm font-medium text-accent hover:underline">A link</a>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PREVIEW_STATUS_PILLS.map(p => (
              <span key={p.label} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${p.tone}`}>{p.label}</span>
            ))}
            <span className="rounded-md border border-line bg-surface-selected px-2 py-0.5 text-xs font-medium text-fg-0 shadow-[inset_2px_0_0_var(--accent-text)]">Selected row</span>
            <span className="rounded-full border border-[color:var(--accent-line)] bg-[var(--accent-tint)] px-2 py-0.5 text-xs font-medium text-accent">Needs you</span>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
