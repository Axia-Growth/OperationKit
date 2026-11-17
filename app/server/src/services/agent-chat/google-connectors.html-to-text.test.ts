import { describe, expect, it } from 'vitest'
import { gmailBodyText, htmlToText } from './google-connectors.js'

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('htmlToText (Gmail HTML bodies)', () => {
  it('nested / obfuscated <script> leaves no tag and no markup', () => {
    for (const html of [
      '<scr<script>ipt>alert(1)</script>',
      '<<script>script>alert(1)<</script>/script>',
      '<SCRIPT src=x>alert(1)</SCRIPT >hi',
      '<script>alert(1)',
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<img src=x onerror=alert(1)>',
    ]) {
      const out = htmlToText(html)
      expect(out).not.toMatch(/<\s*\/?\s*script/i)
      expect(out).not.toMatch(/[<>]/)
    }
    expect(htmlToText('<script>alert(1)</script>Hi')).toBe('Hi')
    expect(htmlToText('<SCRIPT src=x>alert(1)</SCRIPT >hi')).toBe('hi')
  })

  it('decodes entities exactly once: &amp;lt;script&amp;gt; is the literal &lt;script&gt;', () => {
    const out = htmlToText('<p>&amp;lt;script&amp;gt;</p>')
    expect(out).toBe('&lt;script&gt;')
    expect(out).not.toContain('<script>')
    expect(htmlToText('&amp;amp;')).toBe('&amp;')
    expect(htmlToText('&amp;#60;')).toBe('&#60;')
  })

  it('entity edge cases', () => {
    expect(htmlToText('a &amp; b')).toBe('a & b')
    expect(htmlToText('&lt;x&gt;')).toBe('<x>')
    expect(htmlToText('&quot;q&quot; it&#39;s')).toBe('"q" it\'s')
    expect(htmlToText('a&nbsp;b')).toBe('a b')
    expect(htmlToText('caf&#233; &#x2014; &#X41;')).toBe('café — A')
    expect(htmlToText('&apos;&unknown; &#0; &#xD800; &#99999999;')).toBe('\'&unknown; &#0; &#xD800; &#99999999;')
    // Entity text that arrives as a tag is still text, never a tag.
    expect(htmlToText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('<script>alert(1)</script>')
  })

  it('normal email HTML becomes readable text with line breaks', () => {
    expect(htmlToText('<p>Hello<br>world</p>')).toBe('Hello\nworld')
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo')
    expect(htmlToText('<div>Hi <b>there</b>, <a href="https://x.test">link</a></div><!-- c -->')).toBe('Hi there, link')
  })

  it('drops <style> and <head> content', () => {
    const out = htmlToText('<html><head><title>T</title><style>p { color: red }</style></head><body><style type="text/css">.a{}</style><p>Body</p></body></html>')
    expect(out).toBe('Body')
  })
})

describe('gmailBodyText', () => {
  it('prefers text/plain, else htmlToText(text/html), else snippet; caps at 20k', () => {
    const plain = { id: '1', snippet: 's', payload: { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: { data: b64url('<p>H</p>') } },
      { mimeType: 'text/plain', body: { data: b64url('P <raw>') } },
    ] } }
    expect(gmailBodyText(plain)).toBe('P <raw>')
    const html = { id: '2', snippet: 's', payload: { mimeType: 'text/html', body: { data: b64url('<scr<script>ipt>x</script><p>a &amp;lt;b</p>') } } }
    expect(gmailBodyText(html)).toBe('iptx\na &lt;b')
    expect(gmailBodyText({ id: '3', snippet: 'snip', payload: { mimeType: 'multipart/mixed' } })).toBe('snip')
    const big = { id: '4', payload: { mimeType: 'text/plain', body: { data: b64url('x'.repeat(25_000)) } } }
    expect(gmailBodyText(big)).toBe(`${'x'.repeat(20_000)}\n…(truncated)`)
  })
})
