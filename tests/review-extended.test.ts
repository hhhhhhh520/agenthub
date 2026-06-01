import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockMessageFindMany, mockSessionFindUnique, mockMessageCreate } = vi.hoisted(() => ({
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockSessionFindUnique: vi.fn(),
  mockMessageCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    message: { findMany: mockMessageFindMany, create: mockMessageCreate },
    session: { findUnique: mockSessionFindUnique },
  },
}))

const { mockExecuteSingleAgent, mockRunDiscussion, mockCallLLMForAnalysis } = vi.hoisted(() => ({
  mockExecuteSingleAgent: vi.fn().mockResolvedValue({ result: 'agent output' }),
  mockRunDiscussion: vi.fn().mockResolvedValue(['opinion 1', 'opinion 2']),
  mockCallLLMForAnalysis: vi.fn().mockResolvedValue(JSON.stringify({ needsCorrection: false, quality: 'good' })),
}))

vi.mock('@/lib/orchestrator', () => ({
  executeSingleAgent: mockExecuteSingleAgent,
  runDiscussion: mockRunDiscussion,
  callLLMForAnalysis: mockCallLLMForAnalysis,
}))

vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: vi.fn().mockReturnValue('monitoring prompt'),
}))

vi.mock('@/lib/services/context-builder', () => ({
  buildContextFromHistory: vi.fn().mockReturnValue('context'),
}))

import { delegateToAgent, runMultiAgentDiscussion } from '@/lib/services/review'

const sendEvent = vi.fn()
const agents = [
  { id: 'a1', name: 'PM', systemPrompt: 'you are PM', platform: 'llm', expertise: 'product', model: 'm1', baseUrl: '', apiKey: '', tools: '[]' },
  { id: 'a2', name: '架构师', systemPrompt: 'you are arch', platform: 'llm', expertise: 'arch', model: 'm2', baseUrl: '', apiKey: '', tools: '[]' },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockExecuteSingleAgent.mockResolvedValue({ result: 'agent output' })
  mockRunDiscussion.mockResolvedValue(['opinion 1', 'opinion 2'])
  mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({ needsCorrection: false, quality: 'good' }))
  mockSessionFindUnique.mockResolvedValue({ projectDir: '/dir' })
})

describe('delegateToAgent', () => {
  it('sends error when agent not found', async () => {
    await delegateToAgent('不存在', 'task', 's1', agents, sendEvent)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      content: '未找到名为 不存在 的 Agent',
    }))
    expect(mockExecuteSingleAgent).not.toHaveBeenCalled()
  })

  it('calls executeSingleAgent with correct config', async () => {
    await delegateToAgent('PM', 'do task', 's1', agents, sendEvent)
    expect(mockExecuteSingleAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'PM', systemPrompt: 'you are PM', platform: 'llm', model: 'm1' }),
      'do task',
      'context',
      expect.any(Function),
      's1',
      '/dir'
    )
  })

  it('saves result to message and sends done event', async () => {
    await delegateToAgent('PM', 'task', 's1', agents, sendEvent)
    expect(mockMessageCreate).toHaveBeenCalledWith({
      data: { role: 'agent', rawContent: 'agent output', sessionId: 's1', agentId: 'PM' },
    })
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'PM', type: 'done', content: 'agent output',
    }))
  })

  it('reviews result and includes quality in done event', async () => {
    await delegateToAgent('PM', 'task', 's1', agents, sendEvent)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      data: { quality: 'good' },
    }))
  })

  it('uses process.cwd() when projectDir is empty', async () => {
    mockSessionFindUnique.mockResolvedValueOnce({ projectDir: '' })
    await delegateToAgent('PM', 'task', 's1', agents, sendEvent)
    const config = mockExecuteSingleAgent.mock.calls[0][0]
    expect(config.workDir).toBe(process.cwd())
  })
})

describe('runMultiAgentDiscussion', () => {
  it('sends error when no matching agents found', async () => {
    await runMultiAgentDiscussion(['不存在'], 'topic', 's1', agents, sendEvent)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      content: '未找到参与讨论的 Agent',
    }))
    expect(mockRunDiscussion).not.toHaveBeenCalled()
  })

  it('calls runDiscussion with matching agents', async () => {
    await runMultiAgentDiscussion(['PM', '架构师'], 'topic', 's1', agents, sendEvent)
    expect(mockRunDiscussion).toHaveBeenCalledWith(
      'topic',
      expect.arrayContaining([
        expect.objectContaining({ name: 'PM' }),
        expect.objectContaining({ name: '架构师' }),
      ]),
      3,
      expect.any(Function),
      's1',
      '/dir'
    )
  })

  it('saves summary and sends done event', async () => {
    await runMultiAgentDiscussion(['PM', '架构师'], 'topic', 's1', agents, sendEvent)
    expect(mockMessageCreate).toHaveBeenCalledWith({
      data: { role: 'orchestrator', rawContent: 'opinion 1\n\nopinion 2', sessionId: 's1' },
    })
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'done',
      content: 'opinion 1\n\nopinion 2',
    }))
  })

  it('filters out non-existent agents from discussion', async () => {
    await runMultiAgentDiscussion(['PM', '不存在'], 'topic', 's1', agents, sendEvent)
    const discussionAgents = mockRunDiscussion.mock.calls[0][1]
    expect(discussionAgents).toHaveLength(1)
    expect(discussionAgents[0].name).toBe('PM')
  })

  it('uses process.cwd() when projectDir is empty', async () => {
    mockSessionFindUnique.mockResolvedValueOnce({ projectDir: '' })
    await runMultiAgentDiscussion(['PM'], 'topic', 's1', agents, sendEvent)
    const workDir = mockRunDiscussion.mock.calls[0][5]
    expect(workDir).toBe(process.cwd())
  })
})
