import { useEffect, useState } from 'react'
import { isHttpUrl } from './designReview'
import { Select } from '../components/ui/Select'
import { SegmentedControl } from '../components/ui/SegmentedControl'

const VIEWPORTS = [
  { key: 'desktop', label: 'Desktop' },
  { key: 'mobile', label: 'Mobile' },
]

export function DesignCanvas({
  url,
  onUrl,
  seedUrls,
}: {
  url: string
  onUrl: (url: string) => void
  seedUrls: string[]
}) {
  const [draft, setDraft] = useState(url)
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop')
  const [loading, setLoading] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const src = isHttpUrl(url) ? url : null

  useEffect(() => { setDraft(url) }, [url])

  useEffect(() => {
    if (!src) {
      setLoading(false)
      return
    }
    setLoading(true)
  }, [src])

  function load(next?: string) {
    const v = (next ?? draft).trim()
    if (!v) return
    onUrl(v)
  }

  function refresh() {
    if (!src) return
    setLoading(true)
    setFrameKey(k => k + 1)
  }

  return (
    <div className="cc-design-canvas">
      <div className="cc-design-toolbar">
        <form
          className="cc-design-url"
          onSubmit={e => { e.preventDefault(); load() }}
        >
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Paste a preview URL"
            spellCheck={false}
          />
          <button type="submit">Load</button>
          <button type="button" onClick={refresh} disabled={!src}>Refresh</button>
        </form>
        {seedUrls.length > 0 && (
          <Select
            aria-label="Detected preview URLs"
            value=""
            onChange={v => { if (v) load(v) }}
          >
            <option value="">Detected URLs</option>
            {seedUrls.map(u => (
              <option key={u} value={u}>{u}</option>
            ))}
          </Select>
        )}
        <SegmentedControl
          label="Preview viewport"
          items={VIEWPORTS}
          value={viewport}
          onChange={k => setViewport(k === 'mobile' ? 'mobile' : 'desktop')}
        />
      </div>
      <div className={`cc-design-stage ${viewport}`}>
        {!src && (
          <div className="cc-design-empty">
            Paste a live preview URL to open the site here. Notes go in chat.
          </div>
        )}
        {src && (
          <>
            {loading && <div className="cc-design-loading">Loading preview…</div>}
            <iframe
              key={`${src}#${frameKey}`}
              title="Design canvas"
              src={src}
              className="cc-design-frame"
              onLoad={() => setLoading(false)}
            />
          </>
        )}
      </div>
    </div>
  )
}
