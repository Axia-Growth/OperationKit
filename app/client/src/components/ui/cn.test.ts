import { describe, it, expect } from 'vitest'
import { cn } from './cn'

describe('cn (polish F1: last class in a group wins)', () => {
  it('joins and drops falsy parts', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b')
  })
  it('later size, color, height and radius override earlier ones', () => {
    expect(cn('h-8 px-3 text-sm', 'h-6 text-xs')).toBe('px-3 h-6 text-xs')
    expect(cn('text-fg-1 text-sm', 'text-accent')).toBe('text-sm text-accent')
    expect(cn('rounded-md', 'rounded-full')).toBe('rounded-full')
    expect(cn('bg-surface-2 bg-cover', 'bg-accent')).toBe('bg-cover bg-accent')
  })
  it('keeps text size and text color apart', () => {
    expect(cn('text-xs text-fg-3')).toBe('text-xs text-fg-3')
    expect(cn('text-[13px]', 'text-base')).toBe('text-base')
  })
  it('a later shorthand removes earlier sides; a later side keeps the shorthand', () => {
    expect(cn('px-2 py-1', 'p-4')).toBe('p-4')
    expect(cn('p-4', 'px-2')).toBe('p-4 px-2')
    expect(cn('rounded-l-md', 'rounded-lg')).toBe('rounded-lg')
  })
  it('scopes conflicts per variant and per important flag', () => {
    expect(cn('hover:bg-surface-3 bg-surface-2', 'bg-accent')).toBe('hover:bg-surface-3 bg-accent')
    expect(cn('sm:min-h-[36px]', 'sm:min-h-[28px]')).toBe('sm:min-h-[28px]')
    expect(cn('data-[open]:bg-surface-3', 'data-[open]:bg-surface-4')).toBe('data-[open]:bg-surface-4')
    expect(cn('!p-0 p-2')).toBe('!p-0 p-2')
  })
  it('separates border width, style, color and side color', () => {
    expect(cn('border border-line', 'border-transparent')).toBe('border border-transparent')
    expect(cn('border-line border-l-accent')).toBe('border-line border-l-accent')
    expect(cn('border border-2')).toBe('border-2')
    expect(cn('border-dashed border-solid')).toBe('border-solid')
  })
  it('separates font weight from font family, and display/position groups', () => {
    expect(cn('font-mono font-medium', 'font-semibold')).toBe('font-mono font-semibold')
    expect(cn('inline-flex', 'hidden')).toBe('hidden')
    expect(cn('relative', 'absolute')).toBe('absolute')
  })
  it('leaves unknown classes alone', () => {
    expect(cn('cc-pop-in', 'cc-pop-in foo')).toBe('cc-pop-in cc-pop-in foo')
  })
})
