import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindFirst, mockCreate, mockQueryRaw, mockExecuteRaw } = vi.hoisted(() => ({
  mockFindFirst: vi.fn().mockResolvedValue(null),
  mockCreate: vi.fn(),
  mockQueryRaw: vi.fn().mockResolvedValue([]),
  mockExecuteRaw: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    agent: { findFirst: mockFindFirst, create: mockCreate },
    $queryRaw: mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  },
}))

vi.mock('@/lib/cli-detect', () => ({
  detectCLIPlatform: vi.fn().mockReturnValue('claude-code'),
}))

// Mock ensureOrchestratorAgent to avoid it consuming our mockFindFirst calls
vi.mock('@/lib/app-config', () => ({
  getOrchestratorConfig: vi.fn().mockResolvedValue({
    apiKey: 'config-key',
    model: 'gpt-4',
    baseUrl: '',
  }),
  ensureOrchestratorAgent: vi.fn().mockResolvedValue(undefined),
}))

const mockAgent = {
  id: 'orch-1',
  name: 'Orchestrator',
  platform: 'claude-code',
  model: 'claude-sonnet-4-20250514',
  baseUrl: '',
  apiKey: 'test-key',
  isOrchestrator: true,
}

import { getOrchestratorAgent } from '@/lib/orchestrator'

describe('getOrchestratorAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return Orchestrator Agent when found in DB', async () => {
    mockFindFirst.mockResolvedValueOnce(mockAgent)

    const result = await getOrchestratorAgent()
    expect(result.platform).toBe('claude-code')
    expect(result.model).toBe('claude-sonnet-4-20250514')
    expect(result.apiKey).toBe('test-key')
  })

  it('should fallback to AppConfig when no Orchestrator Agent found', async () => {
    mockFindFirst.mockResolvedValueOnce(null)
    // getOrchestratorConfig is mocked to return config-key/gpt-4

    const result = await getOrchestratorAgent()
    expect(result.platform).toBe('claude-code')
    expect(result.model).toBe('gpt-4')
    expect(result.apiKey).toBe('config-key')
  })

  it('should use default model when AppConfig is empty', async () => {
    mockFindFirst.mockResolvedValueOnce(null)
    const { getOrchestratorConfig } = await import('@/lib/app-config')
    vi.mocked(getOrchestratorConfig).mockResolvedValueOnce({
      apiKey: '',
      model: 'claude-sonnet-4-20250514',
      baseUrl: '',
    })

    const result = await getOrchestratorAgent()
    expect(result.platform).toBe('claude-code')
    expect(result.model).toBe('claude-sonnet-4-20250514')
  })

  it('provider-qualified model uses local CLI config instead of CC-Switch fallback', async () => {
    mockFindFirst.mockResolvedValueOnce({
      ...mockAgent,
      model: 'opencode-go/mimo-v2.6-flash',
      baseUrl: '',
      apiKey: '',
    })
    const { getOrchestratorConfig } = await import('@/lib/app-config')

    const result = await getOrchestratorAgent()

    expect(result.model).toBe('opencode-go/mimo-v2.6-flash')
    expect(result.apiKey).toBe('')
    expect(result.baseUrl).toBe('')
    expect(getOrchestratorConfig).not.toHaveBeenCalled()
  })

  it('unqualified model with empty key still falls back to AppConfig/CC-Switch', async () => {
    mockFindFirst.mockResolvedValueOnce({
      ...mockAgent,
      model: 'mimo-v2.6-flash',
      baseUrl: '',
      apiKey: '',
    })

    const result = await getOrchestratorAgent()

    expect(result.model).toBe('gpt-4')
    expect(result.apiKey).toBe('config-key')
  })
})
