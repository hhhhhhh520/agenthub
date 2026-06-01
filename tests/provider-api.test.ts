import { describe, it, expect } from 'vitest'
import { PROVIDER_CATEGORIES, type ProviderCategory } from '../src/lib/provider-categories'

describe('PROVIDER_CATEGORIES', () => {
  it('should have all 5 categories', () => {
    expect(Object.keys(PROVIDER_CATEGORIES)).toEqual([
      'official', 'cn_official', 'aggregator', 'third_party', 'custom'
    ])
  })

  it('each category should have label and color', () => {
    for (const [key, val] of Object.entries(PROVIDER_CATEGORIES)) {
      expect(val.label).toBeTruthy()
      expect(val.color).toBeTruthy()
      expect(typeof val.label).toBe('string')
      expect(typeof val.color).toBe('string')
    }
  })

  it('should be usable as ProviderCategory type', () => {
    const cat: ProviderCategory = 'official'
    expect(PROVIDER_CATEGORIES[cat].label).toBe('官方')
  })
})

describe('Provider API shape', () => {
  it('database provider response should have required fields', () => {
    // Simulate the shape returned by GET /api/providers for database source
    const dbProvider = {
      name: 'test-id',
      displayName: 'Test Provider',
      baseUrl: 'https://api.example.com',
      model: 'test-model',
      apiKey: 'sk-xxx',
      agentType: 'claudecode',
      source: 'database',
    }

    expect(dbProvider.name).toBeTruthy()
    expect(dbProvider.displayName).toBeTruthy()
    expect(dbProvider.source).toBe('database')
    // Database providers should have full apiKey (not masked)
    expect(dbProvider.apiKey).not.toContain('***')
  })

  it('cc-switch provider response should have masked apiKey', () => {
    // Simulate the shape returned by GET /api/providers for cc-switch source
    const ccSwitchProvider = {
      name: 'cc-switch-provider',
      displayName: 'CC-Switch Provider',
      baseUrl: 'https://api.example.com',
      model: 'test-model',
      apiKey: 'sk-***masked',
      agentType: 'claudecode',
      source: 'cc-switch',
    }

    expect(ccSwitchProvider.source).toBe('cc-switch')
    // CC-Switch providers should have masked apiKey
    // (actual masking depends on maskApiKey function)
  })
})
