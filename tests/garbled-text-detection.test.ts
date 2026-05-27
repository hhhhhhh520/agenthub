import { describe, it, expect } from 'vitest'

function hasLoneSurrogates(str: string): boolean {
  let i = 0
  while (i < str.length) {
    const code = str.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = str.charCodeAt(i + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
      i += 2
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true
    } else {
      i++
    }
  }
  return false
}

describe('hasLoneSurrogates — garbled text detection', () => {
  it('should return false for normal ASCII text', () => {
    expect(hasLoneSurrogates('Hello World')).toBe(false)
  })

  it('should return false for valid Chinese text', () => {
    expect(hasLoneSurrogates('测试会话')).toBe(false)
    expect(hasLoneSurrogates('新会话')).toBe(false)
  })

  it('should return false for valid emoji', () => {
    expect(hasLoneSurrogates('Hello 🌍')).toBe(false)
  })

  it('should return true for lone surrogates (GBK garbled text)', () => {
    // GBK bytes misinterpreted as UTF-16 produce lone surrogates
    expect(hasLoneSurrogates('鏂颁細璇\udc9d')).toBe(true)
    expect(hasLoneSurrogates('\ud800')).toBe(true)
    expect(hasLoneSurrogates('\udfff')).toBe(true)
  })

  it('should return false for empty string', () => {
    expect(hasLoneSurrogates('')).toBe(false)
  })

  it('should return false for mixed valid text', () => {
    expect(hasLoneSurrogates('Session 测试 123 🎉')).toBe(false)
  })
})