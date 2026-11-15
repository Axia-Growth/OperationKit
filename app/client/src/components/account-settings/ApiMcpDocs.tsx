/**
 * Settings → API & MCP → API docs reference (sprint 4b, obj 900496).
 *
 * Purely presentational: links to the live API contract instead of forking a
 * stale copy of it, plus a REST curl example an agent (or the person pasting
 * into one) can copy straight in. Does not change any key scope, default, or
 * permission.
 *
 * obj 900745 (Operator's 2026-11-12 walkthrough):
 *   - The "MCP config — copy-paste for your agent" JSON snippet is gone. It
 *     duplicated the Quick setup prompt in CodingAgentSetup.tsx, which already
 *     carries the MCP install step for every client (including the
 *     `npx mcp-remote` stdio bridge under "Other agent").
 *   - Links resolve on THIS install: the live spec and discovery doc are built
 *     from window.location.origin. The prose docs point at the real public
 *     repo (PUBLIC_DOCS_BASE in hooks/useBranding.ts). They used to be hard-coded to the private
 *     upstream repo, which the OSS genericizer rewrites to the non-existent
 *     github.com/your-org/operationkit on public installs.
 *
 * obj 900803: a white-labeled install (its own name or marks) never links out
 * to the default product's public repo — only the on-install spec + discovery
 * doc are shown there.
 */
import { useMemo, type ReactNode } from 'react'
// Direct module paths (not the '../ui' barrel) so suites that mock the barrel
// with only Modal/useConfirm (e.g. AccountSettings.google.test.tsx) still render this card.
import { SectionHeader } from '../ui/SettingsSection'
import { CopyButton } from '../ui/CopyButton'
import { PUBLIC_DOCS_BASE, useBranding } from '../../hooks/useBranding'

/** Every link the card renders. Exported for tests. */
export function apiDocLinks(origin: string, whiteLabel = false) {
  return {
    spec: `${origin}/api/openapi.json`,
    discovery: `${origin}/api/agent`,
    readme: whiteLabel ? null : `${PUBLIC_DOCS_BASE}/docs/api/README.md`,
    agentPrompt: whiteLabel ? null : `${PUBLIC_DOCS_BASE}/docs/api/AGENT-PROMPT.md`,
  }
}

const LINK = 'text-accent underline-offset-2 hover:text-accent-hover hover:underline'

function Snippet({ code }: { code: string }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-md border border-line bg-surface-1 p-3 font-mono text-xs leading-relaxed text-fg-1">
      <code>{code}</code>
    </pre>
  )
}

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      {children}
    </a>
  )
}

export function ApiMcpDocs() {
  const origin = useMemo(() => (typeof window !== 'undefined' ? window.location.origin : 'https://<your-install-host>'), [])
  const whiteLabel = useBranding().white_label
  const links = useMemo(() => apiDocLinks(origin, whiteLabel), [origin, whiteLabel])

  const curlExample = `curl -s ${origin}/api/agent/attention \\\n  -H "Authorization: Bearer cc_live_…"`

  return (
    <section className="mt-6 rounded-lg border border-line bg-surface-1 p-5" aria-labelledby="api-mcp-docs-heading" data-testid="api-mcp-docs">
      <SectionHeader headingId="api-mcp-docs-heading" className="mb-4" title="API docs" />
      <div className="space-y-5">
        <p className="max-w-prose text-sm leading-relaxed text-fg-2">
          The full, current contract for this install is the live spec at{' '}
          <DocLink href={links.spec}><code className="font-mono">{links.spec}</code></DocLink> (never stale) and
          the discovery doc at <DocLink href={links.discovery}><code className="font-mono">{links.discovery}</code></DocLink>.
          {links.readme && links.agentPrompt && (
            <>
              {' '}The guide (auth, scopes, the agent loop, every REST route and its MCP tool) is{' '}
              <DocLink href={links.readme}>docs/api/README.md</DocLink>, and a portable prompt for handing an agent this
              whole API in one shot is <DocLink href={links.agentPrompt}>docs/api/AGENT-PROMPT.md</DocLink>.
            </>
          )}
        </p>

        <p className="max-w-prose text-xs text-fg-3">
          Connecting an agent over MCP? Use the setup prompt in <span className="text-fg-1">Connect a coding agent</span>{' '}
          above — one URL (<code className="font-mono">{origin}/api/mcp</code>) for board and knowledge-base tools,
          with a named agent key.
        </p>

        <div className="space-y-2">
          <SectionHeader
            level={3}
            className="mb-0 sm:items-center"
            title="REST — copy-paste curl example"
            actions={<CopyButton value={curlExample} label="Copy curl" />}
          />
          <p className="text-xs text-fg-3">
            Every call: <code className="font-mono">Authorization: Bearer cc_live_…</code>. This one reads the
            cards that need a decision (<code className="font-mono">board:read</code>).
          </p>
          <Snippet code={curlExample} />
        </div>
      </div>
    </section>
  )
}
