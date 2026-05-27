import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma for orchestrator functions that need DB access
vi.mock('@/lib/db', () => ({
  prisma: {
    agent: { update: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    session: { findUnique: vi.fn() },
    message: { create: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn(),
  },
}))

// Mock app-config to avoid real DB calls
vi.mock('@/lib/app-config', () => ({
  getOrchestratorConfig: vi.fn().mockResolvedValue({
    apiKey: 'test-key',
    model: 'claude-sonnet-4-20250514',
    baseUrl: '',
  }),
  ensureOrchestratorAgent: vi.fn().mockResolvedValue(undefined),
}))

// Mock adapter module — we control what chunks are yielded
const mockChunks: Array<{ type: string; content: string }> = []
vi.mock('@/lib/adapter', () => ({
  createAdapter: vi.fn(() => ({
    connect: vi.fn(),
    send: vi.fn(async function* () {
      for (const chunk of mockChunks) yield chunk
    }),
    close: vi.fn(),
  })),
}))

vi.mock('@/lib/orchestrator/prompts', () => ({
  SCENE_ANALYSIS_PROMPT: '',
  ROLE_GENERATION_PROMPT: '',
  TASK_DECOMPOSITION_PROMPT: '',
  buildDiscussionPrompt: vi.fn(() => ''),
  ORCHESTRATOR_DECISION_PROMPT: '',
}))

import { callLLMForAnalysis } from '@/lib/orchestrator'

describe('callLLMForAnalysis — chunk accumulation', () => {
  beforeEach(() => {
    mockChunks.length = 0
  })

  it('should accumulate error chunks when LLM API fails', async () => {
    mockChunks.push({ type: 'error', content: 'Authentication error: API key not configured' })

    const result = await callLLMForAnalysis('test prompt')
    expect(result).toContain('Authentication error')
    expect(result).toContain('API key not configured')
  })

  it('should accumulate text chunks normally', async () => {
    mockChunks.push({ type: 'text', content: 'Hello ' })
    mockChunks.push({ type: 'text', content: 'World' })

    const result = await callLLMForAnalysis('test prompt')
    expect(result).toBe('Hello World')
  })

  it('should mix text and error chunks', async () => {
    mockChunks.push({ type: 'text', content: 'Partial response...' })
    mockChunks.push({ type: 'error', content: ' Stream interrupted' })

    const result = await callLLMForAnalysis('test prompt')
    expect(result).toContain('Partial response')
    expect(result).toContain('Stream interrupted')
  })

  it('should NOT accumulate status chunks', async () => {
    mockChunks.push({ type: 'status', content: 'working' })
    mockChunks.push({ type: 'text', content: 'Actual response' })
    mockChunks.push({ type: 'status', content: 'completed' })

    const result = await callLLMForAnalysis('test prompt')
    expect(result).toBe('Actual response')
    expect(result).not.toContain('working')
    expect(result).not.toContain('completed')
  })

  it('should throw when all chunks are status (no text/error)', async () => {
    mockChunks.push({ type: 'status', content: 'thinking...' })
    mockChunks.push({ type: 'status', content: 'completed' })

    await expect(callLLMForAnalysis('test prompt')).rejects.toThrow('LLM returned empty response')
  })
})
