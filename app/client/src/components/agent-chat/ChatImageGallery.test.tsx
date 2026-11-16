// @vitest-environment jsdom
/**
 * obj 901028 — images attached to a chat message render as inline
 * thumbnails and open full size in a lightbox (download link, alt text,
 * Escape/close). Covers both the person's bubble (UserBubble) and the
 * bot's reply (AssistantBubble), since a bot-attached screenshot renders
 * through the exact same gallery.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, click, render } from '../../test/render'
import { AssistantBubble, ChatImageGallery, ToolLine, UserBubble } from './ChatItems'
import type { ChatAgentInfo, ChatImage, ChatMessage } from './types'

afterEach(async () => {
  await cleanup()
})

const image: ChatImage = {
  id: 7,
  name: 'screenshot.png',
  media_type: 'image/png',
  size: 1234,
  url: '/api/agent-chat/attachments/7',
  alt_text: 'Board after the fix',
}

const agent: ChatAgentInfo = {
  slug: 'ops',
  name: 'Ops',
  description: 'test bot',
  avatar: 'O',
  colour: 'blue',
  knowledge_folders: [],
  tools: [],
  model: null,
  provider: null,
  version: null,
  author: null,
  source: 'file',
  answered_by: { id: 'claude', model: null },
}

function assistantMessage(images: ChatImage[]): ChatMessage {
  return {
    id: 1,
    role: 'assistant',
    content: 'Here is the before/after.',
    provider: 'claude',
    model: 'claude-sonnet-5',
    tool_name: null,
    meta: null,
    images,
    created_at: '2026-11-16T12:00:00Z',
  }
}

describe('ChatImageGallery', () => {
  it('renders a thumbnail with alt text and no lightbox until clicked', async () => {
    const view = await render(<ChatImageGallery images={[image]} />)
    const thumb = view.container.querySelector('img')
    expect(thumb).toBeTruthy()
    expect(thumb!.getAttribute('src')).toBe(image.url)
    expect(thumb!.getAttribute('alt')).toBe('Board after the fix')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens a full-size lightbox with a download link and the alt text as a caption', async () => {
    const view = await render(<ChatImageGallery images={[image]} />)
    const thumbButton = view.container.querySelector('button')
    expect(thumbButton).toBeTruthy()
    await click(thumbButton)

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    const fullImg = dialog!.querySelector('img')
    expect(fullImg!.getAttribute('src')).toBe(image.url)

    const download = dialog!.querySelector('a[download]')
    expect(download).toBeTruthy()
    expect(download!.getAttribute('href')).toBe(image.url)

    expect(dialog!.textContent).toContain('Board after the fix')
  })

  it('closes the lightbox on the close button', async () => {
    const view = await render(<ChatImageGallery images={[image]} />)
    await click(view.container.querySelector('button'))
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()

    const closeBtn = document.querySelector<HTMLElement>('[aria-label="Close"]')
    await click(closeBtn)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('renders nothing for a message with no images', async () => {
    const view = await render(<ChatImageGallery images={[]} />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('button')).toBeNull()
  })
})

describe('AssistantBubble — bot-attached images (attach_image tool)', () => {
  it('renders an image the bot attached to its own reply inline', async () => {
    const view = await render(<AssistantBubble m={assistantMessage([image])} agent={agent} />)
    const thumb = view.container.querySelector('img')
    expect(thumb).toBeTruthy()
    expect(thumb!.getAttribute('src')).toBe(image.url)
    expect(view.container.textContent).toContain('Here is the before/after.')
  })

  it('renders only the markdown prose when a reply has no images', async () => {
    const view = await render(<AssistantBubble m={assistantMessage([])} agent={agent} />)
    expect(view.container.querySelector('img')).toBeNull()
  })
})

describe('UserBubble — uses the same gallery for a pasted screenshot', () => {
  it('renders the person\'s attached image as a thumbnail', async () => {
    const view = await render(<UserBubble m={{ content: 'look at this', images: [image], created_at: '2026-11-16T12:00:00Z' }} />)
    const thumb = view.container.querySelector('img')
    expect(thumb).toBeTruthy()
    expect(thumb!.getAttribute('alt')).toBe('Board after the fix')
  })
})

describe('ToolLine — attach_image lands on the TOOL row, not the final assistant text', () => {
  it('renders the attached image inline next to the tool summary', async () => {
    const toolRow: ChatMessage = {
      id: 2,
      role: 'tool',
      content: 'Attached image chart.png',
      provider: null,
      model: null,
      tool_name: 'attach_image',
      meta: { ok: true },
      images: [image],
      created_at: '2026-11-16T12:00:00Z',
    }
    const view = await render(<ToolLine m={toolRow} />)
    expect(view.container.textContent).toContain('Attached image chart.png')
    const thumb = view.container.querySelector('img')
    expect(thumb).toBeTruthy()
    expect(thumb!.getAttribute('src')).toBe(image.url)
  })

  it('renders no gallery when the tool row has no images', async () => {
    const toolRow: ChatMessage = {
      id: 3,
      role: 'tool',
      content: 'Searched the board',
      provider: null,
      model: null,
      tool_name: 'list_objectives',
      meta: { ok: true },
      images: [],
      created_at: '2026-11-16T12:00:00Z',
    }
    const view = await render(<ToolLine m={toolRow} />)
    expect(view.container.querySelector('img')).toBeNull()
  })
})
