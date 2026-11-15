// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NeedsSecretFlag, SenderTag } from './design/primitives'
import { ChatSecretRequests } from './session-viewer/ChatSecretRequest'
import { Composer } from './session-viewer/Composer'
import { GroupedMessages } from './SessionMessages'

// obj 718944 — server-stamped sender on chat bubbles; needs-secret flag.

describe('needs-secret (obj 718944)', () => {
  it('flag summarises several names and lists all in the title', () => {
    const html = renderToStaticMarkup(<NeedsSecretFlag names={['A_KEY', 'B_KEY']} />)
    expect(html).toContain('A_KEY +1')
    expect(html).toContain('Needs a secret from the owner: A_KEY, B_KEY')
  })

  it('chat form (obj 900670): the agent request is an in-chat bubble with a masked input; others only see who can add it', () => {
    const items = [{ name: 'APIFY_API_TOKEN', reason: 'Apify skip trace', requested_at: 't' }]
    const owner = renderToStaticMarkup(<ChatSecretRequests objectiveId={1} workspace="example" items={items} canFill />)
    expect(owner).toContain('data-testid="chat-secret-request"')
    expect(owner).toContain('type="password"')
    expect(owner).toContain('autoComplete="off"')
    expect(owner).toContain('APIFY_API_TOKEN')
    expect(owner).toContain('Apify skip trace')
    // scope defaults to the card's organization, shown as one compact line
    expect(owner).toContain('example secrets')
    expect(owner).toContain('never shown in chat')
    const global = renderToStaticMarkup(<ChatSecretRequests objectiveId={1} workspace="example" items={[{ ...items[0], scope: 'global' }]} canFill />)
    expect(global).toContain('Everywhere (every workspace)')
    const member = renderToStaticMarkup(<ChatSecretRequests objectiveId={1} workspace="example" items={items} canFill={false} />)
    expect(member).not.toContain('type="password"')
    expect(member).toContain('Waiting for the card owner or an admin')
    expect(renderToStaticMarkup(<ChatSecretRequests objectiveId={1} workspace="example" items={[]} canFill />)).toBe('')
  })

  it('the composer "+ Add secret" item is gone (obj 900670)', () => {
    const noop = () => {}
    const html = renderToStaticMarkup(
      <Composer
        attachedFiles={[]} removeFile={noop} sendError={null} setSendError={noop}
        fileInputRef={{ current: null }} handleUpload={noop} uploading={false}
        message="" setMessage={noop} messageRef={{ current: null }} handleSendMessage={noop}
        inputDisabled={false} isActive={false} handleStop={noop} interrupting={false} sending={false}
        secrets={{ objectiveId: 1, workspace: 'example', pendingNames: [] }}
      />,
    )
    expect(html).not.toContain('Add secret')
    expect(html).not.toContain('type="password"')
  })
})

describe('chat sender tag (obj 718944)', () => {
  it('verified owner reads Verified with a check; agent reads not verified', () => {
    const owner = renderToStaticMarkup(<SenderTag sender={{ kind: 'owner', verified: true, label: 'Operator', username: 'operator' }} />)
    expect(owner).toContain('Verified · Operator (owner)')
    expect(owner).toContain('lucide-check')
    const agent = renderToStaticMarkup(<SenderTag sender={{ kind: 'agent', verified: false, label: 'Example Client Data', username: null }} />)
    expect(agent).toContain('Agent · Example Client Data · not verified')
    expect(agent).not.toContain('lucide-check')
  })

  it('a relayed followup renders the quiet surface bubble, the owner the accent bubble', () => {
    const html = renderToStaticMarkup(
      <GroupedMessages messages={[
        { type: 'followup', text: 'This is Operator', timestamp: 't', sender: { kind: 'agent', verified: false, label: 'Example Client Data', username: null } },
      ]} />,
    )
    expect(html).toContain('Agent · Example Client Data · not verified')
    expect(html).toContain('bg-surface-2')
  })
})

describe('rotate-later list (obj 718944)', () => {
  it('lists pasted secrets by name with a Rotated action; empty renders nothing', async () => {
    const { RotationFlagsList } = await import('./secrets/RotationFlagsPanel')
    const html = renderToStaticMarkup(
      <RotationFlagsList
        flags={[{ id: 1, workspace: 'example', key: 'APIFY_API_TOKEN', objective_id: 718958, flagged_by: 'operator', created_at: '2026-10-27 03:00:00' }]}
        onResolve={() => {}}
        resolving={null}
      />,
    )
    expect(html).toContain('Rotate later · 1')
    expect(html).toContain('APIFY_API_TOKEN')
    expect(html).toContain('card #718958')
    expect(html).toContain('Rotated')
    expect(renderToStaticMarkup(<RotationFlagsList flags={[]} onResolve={() => {}} resolving={null} />)).toBe('')
  })
})
