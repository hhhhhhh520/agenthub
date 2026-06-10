import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecuteSingleAgent, mockMessageCreate, mockGetOrchestratorAgent } = vi.hoisted(() => ({
  mockExecuteSingleAgent: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockGetOrchestratorAgent: vi.fn().mockResolvedValue({ platform: 'claude-code', model: 'test', baseUrl: '', apiKey: 'sk' }),
}))

vi.mock('@/lib/orchestrator', () => ({
  executeSingleAgent: mockExecuteSingleAgent,
  callLLMForAnalysis: vi.fn(),
  runDiscussion: vi.fn(),
  getOrchestratorAgent: mockGetOrchestratorAgent,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    message: { create: mockMessageCreate },
  },
}))

vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: vi.fn().mockReturnValue('monitoring prompt'),
  ORCHESTRATOR_DECISION_PROMPT: 'test prompt',
}))

import { reviewResult } from '@/lib/services/review'

describe('reviewResult', () => {
  const sendEvent = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return quality poor and send correction message when LLM says needsCorrection', async () => {
    mockExecuteSingleAgent.mockResolvedValueOnce({
      result: JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' }),
    })

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent)

    expect(result).toEqual({ quality: 'poor' })
    expect(sendEvent).toHaveBeenCalledWith({
      agentId: 'orchestrator',
      type: 'text',
      content: 'Orchestrator 纠偏：缺少错误处理',
      data: { quality: 'poor' },
    })
    expect(mockMessageCreate).toHaveBeenCalledWith({
      data: { role: 'orchestrator', rawContent: 'Orchestrator 纠偏：缺少错误处理', sessionId: 'session-1' },
    })
  })

  it('should return quality good when LLM says no correction needed', async () => {
    mockExecuteSingleAgent.mockResolvedValueOnce({
      result: JSON.stringify({ needsCorrection: false, quality: 'good' }),
    })

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent)

    expect(result).toEqual({ quality: 'good' })
    expect(sendEvent).not.toHaveBeenCalled()
    expect(mockMessageCreate).not.toHaveBeenCalled()
  })

  it('should fallback to quality good when LLM throws exception', async () => {
    mockExecuteSingleAgent.mockRejectedValueOnce(new Error('LLM timeout'))

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent)

    expect(result).toEqual({ quality: 'good' })
    expect(sendEvent).not.toHaveBeenCalled()
    expect(mockMessageCreate).not.toHaveBeenCalled()
  })

  it('should not retry when retryContext is not provided', async () => {
    mockExecuteSingleAgent.mockResolvedValueOnce({
      result: JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' }),
    })

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent)

    expect(result).toEqual({ quality: 'poor' })
    // executeSingleAgent called once for monitoring, not for retry
    expect(mockExecuteSingleAgent).toHaveBeenCalledTimes(1)
  })

  it('should retry when needsCorrection is true and retryContext is provided', async () => {
    // First call: monitoring returns needsCorrection
    mockExecuteSingleAgent
      .mockResolvedValueOnce({
        result: JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' }),
      })
      // Second call: retry agent execution
      .mockResolvedValueOnce({ result: 'improved output' })
      // Third call: monitoring of retry result returns good
      .mockResolvedValueOnce({
        result: JSON.stringify({ needsCorrection: false, quality: 'good' }),
      })

    const retryContext = {
      agent: { name: 'test-agent', systemPrompt: 'prompt', platform: 'claude-code' },
      maxRetries: 3,
      currentRetry: 0,
      chatSessionId: 'session-1',
      projectDir: '/test',
    }

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent, retryContext)

    expect(result).toEqual({ quality: 'good' })
    // Second call should be the retry
    expect(mockExecuteSingleAgent).toHaveBeenCalledTimes(3)
    expect(sendEvent).toHaveBeenCalledWith({
      agentId: 'orchestrator',
      type: 'text',
      content: '正在要求 Agent 改进（第 1/3 次重试）...',
    })
  })

  it('should not retry when currentRetry >= maxRetries', async () => {
    mockExecuteSingleAgent.mockResolvedValueOnce({
      result: JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' }),
    })

    const retryContext = {
      agent: { name: 'test-agent', systemPrompt: 'prompt', platform: 'claude-code' },
      maxRetries: 3,
      currentRetry: 3,
      chatSessionId: 'session-1',
      projectDir: '/test',
    }

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent, retryContext)

    expect(result).toEqual({ quality: 'poor' })
    // Only monitoring call, no retry
    expect(mockExecuteSingleAgent).toHaveBeenCalledTimes(1)
  })

  it('should return quality poor when executeSingleAgent fails during retry', async () => {
    // First call: monitoring returns needsCorrection
    mockExecuteSingleAgent.mockResolvedValueOnce({
      result: JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' }),
    })
    // Second call: retry agent execution fails
    mockExecuteSingleAgent.mockRejectedValueOnce(new Error('CLI crashed'))

    const retryContext = {
      agent: { name: 'test-agent', systemPrompt: 'prompt', platform: 'claude-code' },
      maxRetries: 3,
      currentRetry: 0,
      chatSessionId: 'session-1',
      projectDir: '/test',
    }

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent, retryContext)

    expect(result).toEqual({ quality: 'poor' })
    expect(mockExecuteSingleAgent).toHaveBeenCalled()
  })
})
