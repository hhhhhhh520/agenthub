import { describe, it, expect } from 'vitest'
import { cn, maskApiKey } from '../src/lib/utils'

describe('cn (className merge)', () => {
  it('should merge class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('should handle conditional classes', () => {
    expect(cn('base', true && 'enabled', false && 'disabled')).toBe('base enabled')
  })

  it('should handle undefined and null', () => {
    expect(cn('base', undefined, null, 'end')).toBe('base end')
  })

  it('should merge tailwind classes with conflict resolution', () => {
    // twMerge should resolve conflicts: p-4 overrides p-2
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })

  it('should handle array inputs', () => {
    expect(cn(['a', 'b'], 'c')).toBe('a b c')
  })

  it('should handle object inputs', () => {
    expect(cn({ active: true, disabled: false })).toBe('active')
  })

  it('should return empty string for no inputs', () => {
    expect(cn()).toBe('')
  })

  it('should handle mixed inputs', () => {
    expect(cn('base', ['arr1', 'arr2'], { obj: true }, false && 'skip')).toBe('base arr1 arr2 obj')
  })
})

describe('maskApiKey', () => {
  it('should return empty string for empty input', () => {
    expect(maskApiKey('')).toBe('')
  })

  it('should mask short keys (1 char) completely', () => {
    expect(maskApiKey('a')).toBe('***')
  })

  it('should mask short keys (3 chars) completely', () => {
    expect(maskApiKey('abc')).toBe('***')
  })

  it('should mask 4-char keys completely', () => {
    expect(maskApiKey('abcd')).toBe('***')
  })

  it('should show last 4 chars for normal keys', () => {
    expect(maskApiKey('sk-1234567890abcd')).toBe('***abcd')
  })

  it('should show last 4 chars for 5-char keys', () => {
    expect(maskApiKey('abcde')).toBe('***bcde')
  })
})