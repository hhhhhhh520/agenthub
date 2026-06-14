import { describe, it, expect } from 'vitest'
import { maskApiKey } from '../src/lib/utils'
import { XSS_TAG_RE, SELECTED_FIELDS } from '../src/app/api/agents/route'

/**
 * Tests for recommend-agents and agents API business logic.
 * Security assertions (apiKey masking, mass assignment) are in api-safety.test.ts.
 * These tests cover the remaining business logic: XSS validation, field filtering.
 *
 * XSS_TAG_RE 和 SELECTED_FIELDS 从 route.ts 导入，确保测试与实际代码同步。
 */

describe('agents route: XSS prevention in agent names', () => {
  it('rejects script tags', () => {
    expect(XSS_TAG_RE.test('<script>alert(1)</script>')).toBe(true)
  })

  it('rejects img tags', () => {
    expect(XSS_TAG_RE.test('<img src=x onerror=alert(1)>')).toBe(true)
  })

  it('rejects div tags', () => {
    expect(XSS_TAG_RE.test('<div>evil</div>')).toBe(true)
  })

  it('rejects SVG tags', () => {
    expect(XSS_TAG_RE.test('<svg onload=alert(1)>')).toBe(true)
  })

  it('allows normal agent names', () => {
    const valid = ['架构师', '前端工程师', 'MyAgent', 'Agent-123', 'backend-dev', 'test_agent']
    for (const name of valid) {
      expect(XSS_TAG_RE.test(name), `"${name}" should be allowed`).toBe(false)
    }
  })

  it('allows names with special characters but no HTML', () => {
    expect(XSS_TAG_RE.test('Agent (v2.0)')).toBe(false)
    expect(XSS_TAG_RE.test('前端/后端')).toBe(false)
  })
})

describe('agents route: field exclusion contract', () => {
  it('apiKey should be excluded from API responses', () => {
    expect(SELECTED_FIELDS).not.toContain('apiKey')
  })

  it('systemPrompt should be excluded from list responses', () => {
    expect(SELECTED_FIELDS).not.toContain('systemPrompt')
  })

  it('no field name should contain secret/password/token/key patterns', () => {
    for (const field of SELECTED_FIELDS) {
      expect(field).not.toMatch(/secret|password|token|key/i)
    }
  })
})

describe('maskApiKey (from utils)', () => {
  it('masks long keys showing only last 4 chars', () => {
    expect(maskApiKey('sk-1234567890abcd')).toBe('***abcd')
  })

  it('masks short keys completely', () => {
    expect(maskApiKey('abc')).toBe('***')
    expect(maskApiKey('abcd')).toBe('***')
  })

  it('returns empty string for empty input', () => {
    expect(maskApiKey('')).toBe('')
  })

  it('shows last 4 chars for 5-char keys', () => {
    expect(maskApiKey('abcde')).toBe('***bcde')
  })
})
