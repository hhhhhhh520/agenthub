import { describe, expect, it } from 'vitest'
import { formatMessageClock, formatMessageFullTime } from '../src/lib/message-time'

describe('message time formatting', () => {
  it('formats a valid timestamp as clock time', () => {
    const value = new Date(2026, 10, 4, 9, 5, 7).toISOString()
    expect(formatMessageClock(value)).toMatch(/\d{2}:\d{2}/)
  })

  it('formats a valid timestamp with full date and seconds for hover', () => {
    const value = new Date(2026, 10, 4, 9, 5, 7).toISOString()
    const full = formatMessageFullTime(value)
    expect(full).toContain('2026')
    expect(full).toContain(':')
  })

  it('returns empty strings for invalid input', () => {
    expect(formatMessageClock('not-a-date')).toBe('')
    expect(formatMessageFullTime('')).toBe('')
  })
})
