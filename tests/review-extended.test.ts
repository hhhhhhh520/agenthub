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
    sessionMember: { findUnique: vi.fn().mockResolvedValue(null) },
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
  { id: 'a1', name: 'PM', systemPrompt: 'you are PM', platform: 'claude-code', expertise: 'product', model: 'm1', baseUrl: '', apiKey: '', tools: '[]' },
  { id: 'a2', name: '架构师', systemPrompt: 'you are arch', platform: 'claude-code', expertise: 'arch', model: 'm2', baseUrl: '', apiKey: '', tools: '[]' },
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
      content: expect.stringContaining('未找到名为「不存在」的 Agent'),
    }))
    expect(mockExecuteSingleAgent).not.toHaveBeenCalled()
  })

  it('calls executeSingleAgent with correct config', async () => {
    await delegateToAgent('PM', 'do task', 's1', agents, sendEvent)
    expect(mockExecuteSingleAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'PM', systemPrompt: 'you are PM', platform: 'claude-code', model: 'm1' }),
      'do task',
      '',
      expect.any(Function),
      's1',
      '/dir',
      undefined
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
      content: expect.stringContaining('未找到参与讨论的 Agent'),
    }))
    expect(mockRunDiscussion).not.toHaveBeenCalled()
  })

  it('calls runDiscussion with matching agents', async () => {
    await runMultiAgentDiscussion(['PM', '架构师'], 'topic', 's1', agents, sendEvent)
    // ISSUE-003 后:不传 workDir(讨论无 MCP),但传 sessionId 作进程隔离维度
    expect(mockRunDiscussion).toHaveBeenCalledWith(
      'topic',
      expect.arrayContaining([
        expect.objectContaining({ name: 'PM' }),
        expect.objectContaining({ name: '架构师' }),
      ]),
      3,
      expect.any(Function),
      's1'
    )
  })

  it('saves summary and sends done event', async () => {
    await runMultiAgentDiscussion(['PM', '架构师'], 'topic', 's1', agents, sendEvent)
    expect(mockMessageCreate).toHaveBeenCalledWith({
      data: { role: 'orchestrator', rawContent: '[DISCUSSION_SUMMARY][STATUS:success]opinion 1\n\nopinion 2', sessionId: 's1' },
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

  it('ISSUE-003: adapter status chunks are not forwarded to SSE', async () => {
    // 真回归守卫:旧代码透传所有 chunk,status 噪音(completed/retrying...)
    // 会进前端 streaming 文本。注意只断言 agent 维度——orchestrator 自己的
    // "讨论中..." status 是有意的 UX 状态,不在过滤范围
    mockRunDiscussion.mockImplementation(async (_t, _a, _r, onChunk) => {
      onChunk('PM', { type: 'status', content: 'completed' })
      onChunk('PM', { type: 'status', content: 'retrying in 1000ms...' })
      onChunk('PM', { type: 'text', content: 'my opinion' })
      return ['PM（第1轮）：my opinion']
    })
    await runMultiAgentDiscussion(['PM'], 'topic', 's1', agents, sendEvent)
    const pmStatusEvents = sendEvent.mock.calls.filter(
      c => c[0].agentId === 'PM' && c[0].type === 'status'
    )
    expect(pmStatusEvents).toHaveLength(0)
    // text chunk 仍正常转发(防过度抑制)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'PM', type: 'text', content: 'my opinion',
    }))
  })
})
