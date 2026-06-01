import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQueryRaw, mockAgentFindFirst, mockAgentCreate } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn().mockResolvedValue([]),
  mockAgentFindFirst: vi.fn(),
  mockAgentCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    agent: { findFirst: mockAgentFindFirst, create: mockAgentCreate },
  },
}))

vi.mock('@/lib/cli-detect', () => ({
  detectCLIPlatform: vi.fn().mockReturnValue('claude-code'),
}))

import { ensureOrchestratorAgent, getOrchestratorConfig } from '@/lib/app-config'

beforeEach(() => {
  vi.clearAllMocks()
  mockQueryRaw.mockResolvedValue([])
  mockAgentFindFirst.mockResolvedValue(null)
  mockAgentCreate.mockResolvedValue({})
})

describe('ensureOrchestratorAgent', () => {
  it('skips creation when orchestrator agent already exists', async () => {
    mockAgentFindFirst.mockResolvedValueOnce({ id: 'existing' })
    await ensureOrchestratorAgent()
    expect(mockAgentCreate).not.toHaveBeenCalled()
  })

  it('creates orchestrator agent when none exists', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { key: 'orchestrator_apiKey', value: 'sk-123' },
      { key: 'orchestrator_model', value: 'claude-3' },
      { key: 'orchestrator_baseUrl', value: 'https://api.test.com' },
    ])
    await ensureOrchestratorAgent()
    expect(mockAgentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Orchestrator',
        platform: 'claude-code',
        model: 'claude-3',
        apiKey: 'sk-123',
        baseUrl: 'https://api.test.com',
        isPreset: true,
        isOrchestrator: true,
      }),
    })
  })

  it('uses defaults when config is empty', async () => {
    mockQueryRaw.mockResolvedValueOnce([])
    await ensureOrchestratorAgent()
    expect(mockAgentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: 'claude-sonnet-4-20250514',
        apiKey: '',
        baseUrl: '',
      }),
    })
  })

  it('catches unique constraint error silently', async () => {
    mockAgentCreate.mockRejectedValueOnce(new Error('Unique constraint'))
    await expect(ensureOrchestratorAgent()).resolves.not.toThrow()
  })
})

describe('getOrchestratorConfig', () => {
  it('returns config from rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { key: 'orchestrator_apiKey', value: 'sk' },
      { key: 'orchestrator_model', value: 'm1' },
      { key: 'orchestrator_baseUrl', value: 'https://u.com' },
    ])
    const config = await getOrchestratorConfig()
    expect(config).toEqual({ apiKey: 'sk', model: 'm1', baseUrl: 'https://u.com' })
  })

  it('returns defaults for missing keys', async () => {
    mockQueryRaw.mockResolvedValueOnce([])
    const config = await getOrchestratorConfig()
    expect(config).toEqual({ apiKey: '', model: 'claude-sonnet-4-20250514', baseUrl: '' })
  })
})
