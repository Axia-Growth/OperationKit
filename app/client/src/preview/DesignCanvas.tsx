import { useEffect, useState } from 'react'
import { isHttpUrl } from './designReview'
import { Select } from '../components/ui/Select'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Skeleton, SkeletonText } from '../components/ui/Skeleton'
import { Button, Input } from '../components/ui'

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
          <Input
            size="sm"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Paste a preview URL"
            aria-label="Preview URL"
            spellCheck={false}
            className="flex-1 font-mono"
          />
          <Button type="submit" size="sm">Load</Button>
          <Button type="button" size="sm" onClick={refresh} disabled={!src}>Refresh</Button>
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
            {loading && (
              <div className="cc-design-loading" role="status" aria-busy="true" aria-label="Loading preview" data-testid="design-canvas-skeleton">
                <div className="flex w-full max-w-3xl flex-col gap-4 p-6">
                  <Skeleton className="h-8 w-1/3" />
                  <Skeleton className="h-40 w-full rounded-md" />
                  <SkeletonText lines={3} />
                </div>
              </div>
            )}
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
