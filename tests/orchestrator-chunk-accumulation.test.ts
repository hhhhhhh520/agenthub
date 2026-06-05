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

vi.mock('@/lib/mcp-config', () => ({
  buildMCPConfig: vi.fn(),
}))

import { callLLMForAnalysis, runDiscussion } from '@/lib/orchestrator'

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

describe('runDiscussion — error chunk filtering (QA-18)', () => {
  beforeEach(() => {
    mockChunks.length = 0
  })

  it('should NOT include error chunks in discussion opinions', async () => {
    mockChunks.push({ type: 'text', content: '我认为应该用 React' })
    mockChunks.push({ type: 'error', content: 'API rate limit exceeded' })

    const onChunk = vi.fn()
    const opinions = await runDiscussion('test topic', [{ name: '前端工程师', systemPrompt: 'test' }], 1, onChunk)

    expect(opinions[0]).toContain('我认为应该用 React')
    expect(opinions[0]).not.toContain('API rate limit exceeded')
  })

  it('should use EMPTY_RESPONSE when only error chunks received', async () => {
    mockChunks.push({ type: 'error', content: 'Connection timeout' })

    const onChunk = vi.fn()
    const opinions = await runDiscussion('test topic', [{ name: '测试工程师', systemPrompt: 'test' }], 1, onChunk)

    expect(opinions[0]).not.toContain('Connection timeout')
    expect(opinions[0]).toContain('测试工程师')
  })

  it('should still forward error chunks to onChunk for SSE display', async () => {
    mockChunks.push({ type: 'text', content: '正常回复' })
    mockChunks.push({ type: 'error', content: 'Some warning' })

    const onChunk = vi.fn()
    await runDiscussion('test topic', [{ name: '后端工程师', systemPrompt: 'test' }], 1, onChunk)

    // error chunk is still forwarded via onChunk for real-time display
    expect(onChunk).toHaveBeenCalledWith('后端工程师', { type: 'error', content: 'Some warning' })
    // but NOT accumulated into the opinion
    const textCalls = onChunk.mock.calls.filter(c => c[1].type === 'text')
    expect(textCalls.length).toBe(1)
  })
})
