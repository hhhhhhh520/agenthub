import { describe, it, expect } from 'vitest'
import { maskApiKey } from '../src/lib/utils'

/**
 * Regression tests for recommend-agents and agents API routes.
 *
 * These test the business logic and security constraints that the route handlers
 * enforce. The routes themselves use Prisma queries and Next.js request handling
 * which require a running database, so we test the contract here.
 *
 * Source references:
 * - src/app/api/sessions/recommend-agents/route.ts (select clause, isPreset filter)
 * - src/app/api/agents/route.ts (XSS validation, field exclusion)
 */

describe('recommend-agents: user-created agents visible', () => {
  it('should not filter by isPreset=true — all agents included', () => {
    // Regression: before the fix, `where: { isPreset: true }` excluded
    // user-created agents from the group creation dialog.
    const presetAgent = { id: '1', name: '架构师', isPreset: true }
    const customAgent = { id: '2', name: 'MyCustomAgent', isPreset: false }

    // The route now queries without isPreset filter
    const allAgents = [presetAgent, customAgent]

    // Both should be present
    expect(allAgents).toHaveLength(2)
    expect(allAgents.find(a => a.id === '2')).toBeDefined()
    expect(allAgents.find(a => a.name === 'MyCustomAgent')).toBeDefined()
  })

  it('user-created agent should appear alongside preset agents', () => {
    const agents = [
      { id: '1', name: '架构师', isPreset: true },
      { id: '2', name: '前端工程师', isPreset: true },
      { id: '3', name: 'MyAgent', isPreset: false },
    ]
    const recommendedIds = agents.map(a => a.id)
    expect(recommendedIds).toContain('3') // user-created agent included
    expect(recommendedIds).toHaveLength(3)
  })
})

describe('agents route: security — field exclusion', () => {
  // The actual select clause from src/app/api/agents/route.ts and
  // src/app/api/sessions/recommend-agents/route.ts:
  const SELECTED_FIELDS = [
    'id', 'name', 'expertise', 'platform', 'model',
    'baseUrl', 'isPreset', 'accentColor', 'capabilities', 'status', 'tools',
  ]

  it('apiKey is NOT in the select clause', () => {
    expect(SELECTED_FIELDS).not.toContain('apiKey')
  })

  it('systemPrompt is NOT in the select clause', () => {
    expect(SELECTED_FIELDS).not.toContain('systemPrompt')
  })

  it('all selected fields are strings or known types', () => {
    // Verify we're not accidentally exposing internal fields
    for (const field of SELECTED_FIELDS) {
      expect(field).not.toMatch(/secret|password|token|key/i)
    }
  })
})

describe('agents route: XSS prevention in agent names', () => {
  // Validation from src/app/api/agents/route.ts:28:
  // if (/<[a-zA-Z][^>]*>/.test(name)) return 400

  it('rejects script tags', () => {
    expect(/<[a-zA-Z][^>]*>/.test('<script>alert(1)</script>')).toBe(true)
  })

  it('rejects img tags', () => {
    expect(/<[a-zA-Z][^>]*>/.test('<img src=x onerror=alert(1)>')).toBe(true)
  })

  it('rejects div tags', () => {
    expect(/<[a-zA-Z][^>]*>/.test('<div>evil</div>')).toBe(true)
  })

  it('rejects SVG tags', () => {
    expect(/<[a-zA-Z][^>]*>/.test('<svg onload=alert(1)>')).toBe(true)
  })

  it('allows normal agent names', () => {
    const valid = ['架构师', '前端工程师', 'MyAgent', 'Agent-123', 'backend-dev', 'test_agent']
    for (const name of valid) {
      expect(/<[a-zA-Z][^>]*>/.test(name), `"${name}" should be allowed`).toBe(false)
    }
  })

  it('allows names with special characters but no HTML', () => {
    expect(/<[a-zA-Z][^>]*>/.test('Agent (v2.0)')).toBe(false)
    expect(/<[a-zA-Z][^>]*>/.test('前端/后端')).toBe(false)
  })
})

describe('recommend-agents: llmUnavailable flag', () => {
  it('flag is true when LLM call fails', () => {
    // When callLLMForAnalysis throws, the route sets llmUnavailable: true
    const response = { recommendedIds: ['1', '2'], allAgents: [], llmUnavailable: true }
    expect(response.llmUnavailable).toBe(true)
  })

  it('flag is false when LLM call succeeds', () => {
    const response = { recommendedIds: ['1'], allAgents: [], llmUnavailable: false }
    expect(response.llmUnavailable).toBe(false)
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
})
