import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCallLLMForAnalysis, mockMessageCreate } = vi.hoisted(() => ({
  mockCallLLMForAnalysis: vi.fn(),
  mockMessageCreate: vi.fn(),
}))

vi.mock('@/lib/orchestrator', () => ({
  callLLMForAnalysis: mockCallLLMForAnalysis,
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
})
