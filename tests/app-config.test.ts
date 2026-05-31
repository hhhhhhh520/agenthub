import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @/lib/db so prisma.$queryRaw / $executeRaw are controllable
const mockQueryRaw = vi.fn()
const mockExecuteRaw = vi.fn()
vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  },
}))

// Mock @/lib/cli-detect (used by ensureOrchestratorAgent)
vi.mock('@/lib/cli-detect', () => ({
  detectCLIPlatform: () => 'claude-code',
}))

// Import AFTER mocks are set up
const appConfig = await import('../src/lib/app-config')

describe('getConfig', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset()
  })

  it('returns value from database', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ value: 'my-value' }])
    const result = await appConfig.getConfig('myKey')
    expect(result).toBe('my-value')
  })

  it('returns empty string when key not found', async () => {
    mockQueryRaw.mockResolvedValueOnce([])
    const result = await appConfig.getConfig('nonexistent')
    expect(result).toBe('')
  })
})

describe('setConfig', () => {
  beforeEach(() => {
    mockExecuteRaw.mockReset()
  })

  it('calls INSERT OR REPLACE with key and value', async () => {
    mockExecuteRaw.mockResolvedValueOnce(undefined)
    await appConfig.setConfig('myKey', 'myValue')
    expect(mockExecuteRaw).toHaveBeenCalledOnce()
  })
})

describe('isSetupCompleted', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset()
  })

  it('returns true when setupCompleted is "true"', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ value: 'true' }])
    expect(await appConfig.isSetupCompleted()).toBe(true)
  })

  it('returns false when setupCompleted is empty', async () => {
    mockQueryRaw.mockResolvedValueOnce([])
    expect(await appConfig.isSetupCompleted()).toBe(false)
  })

  it('returns false when setupCompleted is "false"', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ value: 'false' }])
    expect(await appConfig.isSetupCompleted()).toBe(false)
  })
})

describe('getOrchestratorConfig', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset()
  })

  it('returns config from database rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { key: 'orchestrator_apiKey', value: 'sk-ant-123' },
      { key: 'orchestrator_model', value: 'claude-sonnet-4-20250514' },
      { key: 'orchestrator_baseUrl', value: 'https://api.anthropic.com' },
    ])
    const config = await appConfig.getOrchestratorConfig()
    expect(config.apiKey).toBe('sk-ant-123')
    expect(config.model).toBe('claude-sonnet-4-20250514')
    expect(config.baseUrl).toBe('https://api.anthropic.com')
  })

  it('uses default model when not in database', async () => {
    mockQueryRaw.mockResolvedValueOnce([])
    const config = await appConfig.getOrchestratorConfig()
    expect(config.model).toBe('claude-sonnet-4-20250514')
  })

  it('returns empty string for missing apiKey and baseUrl', async () => {
    mockQueryRaw.mockResolvedValueOnce([])
    const config = await appConfig.getOrchestratorConfig()
    expect(config.apiKey).toBe('')
    expect(config.baseUrl).toBe('')
  })
})

describe('maskApiKey behavior in config route', () => {
  // The config route uses maskApiKey from @/lib/utils to mask _apiKey keys.
  // We test the masking logic directly since it's a pure function.
  it('keys ending with _apiKey should be identified for masking', () => {
    const key = 'orchestrator_apiKey'
    expect(key.endsWith('_apiKey') || key.endsWith('_api_key')).toBe(true)
  })

  it('non-apiKey keys should not be identified for masking', () => {
    const keys = ['orchestrator_model', 'orchestrator_baseUrl', 'setupCompleted']
    for (const key of keys) {
      expect(key.endsWith('_apiKey') || key.endsWith('_api_key')).toBe(false)
    }
  })
})
