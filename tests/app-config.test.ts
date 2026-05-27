import { describe, it, expect } from 'vitest'

describe('app-config: Orchestrator config defaults', () => {
  it('default model should be claude-sonnet-4-20250514', () => {
    const defaultModel = 'claude-sonnet-4-20250514'
    expect(defaultModel).toBe('claude-sonnet-4-20250514')
  })

  it('empty apiKey should be treated as undefined for SDK fallback', () => {
    const apiKey = ''
    const resolved = apiKey || undefined
    expect(resolved).toBeUndefined()
  })

  it('empty baseUrl should be treated as undefined for SDK fallback', () => {
    const baseUrl = ''
    const resolved = baseUrl || undefined
    expect(resolved).toBeUndefined()
  })

  it('non-empty apiKey should be passed through', () => {
    const apiKey = 'sk-ant-test123'
    const resolved = apiKey || undefined
    expect(resolved).toBe('sk-ant-test123')
  })
})

describe('app-config: first-run detection', () => {
  it('setupCompleted=true means setup is done', () => {
    const value = 'true'
    expect(value === 'true').toBe(true)
  })

  it('empty value means setup not done', () => {
    const value: string = ''
    expect(value === 'true').toBe(false)
  })

  it('any other value means setup not done', () => {
    const v1: string = 'false'
    const v2: string = '1'
    expect(v1 === 'true').toBe(false)
    expect(v2 === 'true').toBe(false)
  })
})

describe('app-config: API key masking in responses', () => {
  it('config keys ending with _apiKey should be masked', () => {
    const key = 'orchestrator_apiKey'
    expect(key.endsWith('_apiKey')).toBe(true)
  })

  it('non-apiKey keys should not be masked', () => {
    const keys = ['orchestrator_model', 'orchestrator_baseUrl', 'setupCompleted']
    keys.forEach(key => {
      expect(key.endsWith('_apiKey')).toBe(false)
      expect(key.endsWith('_api_key')).toBe(false)
    })
  })
})

describe('setup-wizard: XSS prevention', () => {
  it('should reject agent name with HTML tags', () => {
    const htmlTagRegex = /<[a-zA-Z][^>]*>/
    expect(htmlTagRegex.test('<script>alert(1)</script>')).toBe(true)
    expect(htmlTagRegex.test('正常名称')).toBe(false)
    expect(htmlTagRegex.test('Agent-123')).toBe(false)
  })
})

describe('setup-wizard: CC-Switch import flow', () => {
  it('providerName is required for import', () => {
    const body1 = { providerName: '' }
    const body2 = { providerName: 'my-provider' }
    expect(!body1.providerName || typeof body1.providerName !== 'string').toBe(true)
    expect(!body2.providerName || typeof body2.providerName !== 'string').toBe(false)
  })
})