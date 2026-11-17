import { describe, it, expect } from 'vitest'
import {
  formatAbsoluteTime, formatRelativeTime, formatDateTime, formatDate,
  formatCost, formatDuration, formatBytes, humanize, describeCron, friendlyError, actionErrorMessage, NETWORK_ERROR_MESSAGE,
} from './format'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

describe('time', () => {
  it('relative past and future in words', () => {
    expect(formatRelativeTime('2026-11-15T11:59:50Z', NOW)).toBe('just now')
    expect(formatRelativeTime('2026-11-15T11:55:00Z', NOW)).toBe('5 minutes ago')
    expect(formatRelativeTime('2026-11-15T11:59:00Z', NOW)).toBe('1 minute ago')
    expect(formatRelativeTime('2026-11-15T09:00:00Z', NOW)).toBe('3 hours ago')
    expect(formatRelativeTime('2026-11-14T12:00:00Z', NOW)).toBe('yesterday')
    expect(formatRelativeTime('2026-11-12T12:00:00Z', NOW)).toBe('3 days ago')
    expect(formatRelativeTime('2026-11-15T14:00:00Z', NOW)).toBe('in 2 hours')
    expect(formatRelativeTime('2026-11-16T12:00:00Z', NOW)).toBe('tomorrow')
  })
  it('falls back to a date past a week, never ISO', () => {
    const out = formatRelativeTime('2026-10-01T12:00:00Z', NOW)
    expect(out).toMatch(/2026/)
    expect(out).not.toMatch(ISO_RE)
  })
  it('treats a zone-less SQLite stamp as UTC', () => {
    expect(formatRelativeTime('2026-11-15 11:55:00', NOW)).toBe('5 minutes ago')
  })
  it('missing or bad input', () => {
    expect(formatRelativeTime(null)).toBe('')
    expect(formatRelativeTime('nope')).toBe('')
    expect(formatAbsoluteTime(undefined)).toBe('')
    expect(formatDate('')).toBe('')
    expect(formatDateTime(null)).toEqual({ label: '—', title: '' })
  })
  it('formatDateTime gives a relative label and an absolute local title', () => {
    const r = formatDateTime('2026-11-15T11:00:00Z', NOW)
    expect(r.label).toBe('1 hour ago')
    expect(r.title).toMatch(/Nov 15, 2026|Nov 15/)
    expect(r.title).not.toMatch(ISO_RE)
    expect(r.title).not.toMatch(/UTC|Z$/)
  })
})

describe('formatCost', () => {
  it('two decimals with separators', () => {
    expect(formatCost(1.2345)).toBe('$1.23')
    expect(formatCost(1204.5)).toBe('$1,204.50')
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost('3')).toBe('$3.00')
  })
  it('sub-cent and missing', () => {
    expect(formatCost(0.0004)).toBe('<$0.01')
    expect(formatCost(null)).toBe('—')
    expect(formatCost('x')).toBe('—')
  })
})

describe('formatDuration', () => {
  it('scales units', () => {
    expect(formatDuration(450)).toBe('450 ms')
    expect(formatDuration(12_000)).toBe('12 s')
    expect(formatDuration(245_000)).toBe('4 min 5 s')
    expect(formatDuration(120_000)).toBe('2 min')
    expect(formatDuration(7_800_000)).toBe('2 h 10 min')
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 d 4 h')
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(1)).toBe('1 byte')
    expect(formatBytes(512)).toBe('512 bytes')
    expect(formatBytes(4300)).toBe('4.2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(null)).toBe('—')
  })
})

describe('humanize', () => {
  it('sentence-cases codes and keeps acronyms', () => {
    expect(humanize('ai_review')).toBe('AI review')
    expect(humanize('needs-review')).toBe('Needs review')
    expect(humanize('flowRun')).toBe('Flow run')
    expect(humanize('pr_merged')).toBe('PR merged')
    expect(humanize('')).toBe('')
  })
  it('uses an override map', () => {
    expect(humanize('review', { review: 'Needs you' })).toBe('Needs you')
  })
})

describe('describeCron', () => {
  it('reads common shapes', () => {
    expect(describeCron('* * * * *')).toBe('Every minute')
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes')
    expect(describeCron('0 * * * *')).toBe('Every hour')
    expect(describeCron('30 * * * *')).toBe('Every hour at :30')
    expect(describeCron('0 */4 * * *')).toBe('Every 4 hours')
    expect(describeCron('0 6 * * *')).toBe('Every day at 6:00 AM')
    expect(describeCron('15 18 * * *', { utc: true })).toBe('Every day at 6:15 PM (UTC)')
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 9:00 AM')
    expect(describeCron('0 9 * * 1')).toBe('Every Monday at 9:00 AM')
    expect(describeCron('0 9 * * 1,3')).toBe('Monday and Wednesday at 9:00 AM')
    expect(describeCron('0 8 1 * *')).toBe('Monthly on day 1 at 8:00 AM')
    expect(describeCron('0 6,18 * * *')).toBe('Every day at 6:00 AM and 6:00 PM')
  })
  it('never echoes an unreadable expression', () => {
    expect(describeCron('5 4 * 2 1#2')).toBe('Custom schedule')
    expect(describeCron('@daily')).toBe('Custom schedule')
    expect(describeCron('')).toBe('No schedule')
    expect(describeCron(null)).toBe('No schedule')
  })
})

describe('friendlyError', () => {
  it('maps status codes to sentences, detail kept for a collapsed block', () => {
    expect(friendlyError(500).message).toBe('Something went wrong on our side. Try again in a moment.')
    expect(friendlyError('HTTP 502').message).toMatch(/our side/)
    expect(friendlyError('HTTP 502').detail).toBe('HTTP 502')
    expect(friendlyError({ status: 404 }).message).toMatch(/could not find/)
    expect(friendlyError(new Error('Failed to fetch')).message).toMatch(/reach the server/)
    expect(friendlyError(new Error('boom'))).toEqual({ message: 'Something went wrong. Try again in a moment.', detail: 'boom' })
  })
  it('never puts "HTTP 500" in the message', () => {
    for (const s of [400, 401, 403, 404, 409, 413, 429, 500, 503]) {
      expect(friendlyError(s).message).not.toMatch(/HTTP|\d{3}/)
    }
  })
})

describe('actionErrorMessage', () => {
  it('turns a browser network failure into the plain sentence', () => {
    expect(actionErrorMessage(new TypeError('Failed to fetch'), 'Message not sent')).toBe(NETWORK_ERROR_MESSAGE)
    expect(actionErrorMessage(new TypeError('NetworkError when attempting to fetch resource.'), 'x')).toBe(NETWORK_ERROR_MESSAGE)
    expect(actionErrorMessage(new TypeError('Load failed'), 'x')).toBe(NETWORK_ERROR_MESSAGE)
  })
  it('keeps a server message, and falls back when there is none', () => {
    expect(actionErrorMessage(Object.assign(new Error('Message is too long'), { status: 400 }), 'Message not sent')).toBe('Message is too long')
    expect(actionErrorMessage(new Error('Request timed out — message not sent'), 'x')).toBe('Request timed out — message not sent')
    expect(actionErrorMessage(undefined, 'Message not sent')).toBe('Message not sent')
  })
})
