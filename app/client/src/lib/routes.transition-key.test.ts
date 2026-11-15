import { describe, it, expect } from 'vitest'
import { isChatPath, pageTransitionKey } from './routes'

/* obj 900865 — PageTransition remounts on a key change, so the key must name a
   page. Switching bots used to change it on every click. */

describe('pageTransitionKey', () => {
  it('gives every Bots page URL the same key, so picking a bot never remounts the page', () => {
    const keys = ['/chat', '/chat/alpha', '/chat/beta', '/chat/demo-assistant'].map(p => pageTransitionKey(p, false))
    expect(new Set(keys)).toEqual(new Set(['chat']))
  })

  it('keeps distinct pages distinct', () => {
    expect(pageTransitionKey('/knowledge', false)).toBe('/knowledge')
    expect(pageTransitionKey('/jobs', false)).toBe('/jobs')
    expect(pageTransitionKey('/chatter', false)).toBe('/chatter')
    expect(pageTransitionKey('/settings/models', false)).toBe('settings')
    expect(pageTransitionKey('/archive', false)).toBe('archive')
    expect(pageTransitionKey('/w/operationkit', true)).toBe('board')
  })

  it('isChatPath matches the Bots page and nothing else', () => {
    expect(isChatPath('/chat')).toBe(true)
    expect(isChatPath('/chat/x')).toBe(true)
    expect(isChatPath('/chatter')).toBe(false)
    expect(isChatPath('/')).toBe(false)
  })
})
