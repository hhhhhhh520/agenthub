import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCallLLMForAnalysis, mockMessageCreate, mockExecuteSingleAgent } = vi.hoisted(() => ({
  mockCallLLMForAnalysis: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockExecuteSingleAgent: vi.fn(),
}))

vi.mock('@/lib/orchestrator', () => ({
  callLLMForAnalysis: mockCallLLMForAnalysis,
  executeSingleAgent: mockExecuteSingleAgent,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    message: { create: mockMessageCreate },
  },
}))

vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: vi.fn().mockReturnValue('monitoring prompt'),
}))

import { reviewResult } from '@/lib/services/review'

describe('reviewResult', () => {
  const sendEvent = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return quality poor and send correction message when LLM says needsCorrection', async () => {
    mockCallLLMForAnalysis.mockResolvedValueOnce(
      JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' })
    )

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
    mockCallLLMForAnalysis.mockResolvedValueOnce(
      JSON.stringify({ needsCorrection: false, quality: 'good' })
    )

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent)

    expect(result).toEqual({ quality: 'good' })
    expect(sendEvent).not.toHaveBeenCalled()
    expect(mockMessageCreate).not.toHaveBeenCalled()
  })

  it('should fallback to quality good when LLM throws exception', async () => {
    mockCallLLMForAnalysis.mockRejectedValueOnce(new Error('LLM timeout'))

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent)

    expect(result).toEqual({ quality: 'good' })
    expect(sendEvent).not.toHaveBeenCalled()
    expect(mockMessageCreate).not.toHaveBeenCalled()
  })

  it('should not retry when retryContext is not provided', async () => {
    mockCallLLMForAnalysis.mockResolvedValueOnce(
      JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' })
    )

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent)

    expect(result).toEqual({ quality: 'poor' })
    expect(mockExecuteSingleAgent).not.toHaveBeenCalled()
  })

  it('should retry when needsCorrection is true and retryContext is provided', async () => {
    mockCallLLMForAnalysis
      .mockResolvedValueOnce(
        JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' })
      )
      .mockResolvedValueOnce(
        JSON.stringify({ needsCorrection: false, quality: 'good' })
      )

    mockExecuteSingleAgent.mockResolvedValueOnce({ result: 'improved output' })

    const retryContext = {
      agent: { name: 'test-agent', systemPrompt: 'prompt', platform: 'claude-code' },
      maxRetries: 3,
      currentRetry: 0,
      chatSessionId: 'session-1',
      projectDir: '/test',
    }

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent, retryContext)

    expect(result).toEqual({ quality: 'good' })
    expect(mockExecuteSingleAgent).toHaveBeenCalledWith(
      { name: 'test-agent', systemPrompt: 'prompt', platform: 'claude-code', workDir: '/test' },
      expect.stringContaining('缺少错误处理'),
      '',
      expect.any(Function),
      'session-1',
      '/test',
    )
    expect(sendEvent).toHaveBeenCalledWith({
      agentId: 'orchestrator',
      type: 'text',
      content: '正在要求 Agent 改进（第 1/3 次重试）...',
    })
  })

  it('should not retry when currentRetry >= maxRetries', async () => {
    mockCallLLMForAnalysis.mockResolvedValueOnce(
      JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' })
    )

    const retryContext = {
      agent: { name: 'test-agent', systemPrompt: 'prompt', platform: 'claude-code' },
      maxRetries: 3,
      currentRetry: 3,
      chatSessionId: 'session-1',
      projectDir: '/test',
    }

    const result = await reviewResult('task output', 'task desc', 'session-1', sendEvent, retryContext)

    expect(result).toEqual({ quality: 'poor' })
    expect(mockExecuteSingleAgent).not.toHaveBeenCalled()
  })

  it('should return quality poor when executeSingleAgent fails during retry', async () => {
    mockCallLLMForAnalysis.mockResolvedValueOnce(
      JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理', quality: 'poor' })
    )

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
