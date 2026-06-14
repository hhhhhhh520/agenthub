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

