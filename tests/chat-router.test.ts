import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockMessageFindMany, mockTaskCount, mockSessionUpdate, mockSessionFindUnique, mockMessageCreate } = vi.hoisted(() => ({
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockTaskCount: vi.fn().mockResolvedValue(0),
  mockSessionUpdate: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockMessageCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    message: { findMany: mockMessageFindMany, create: mockMessageCreate },
    task: { count: mockTaskCount },
    session: { update: mockSessionUpdate, findUnique: mockSessionFindUnique },
  },
}))

const { mockGetOrchestratorDecision, mockExecuteSingleAgent, mockGetOrchestratorAgent } = vi.hoisted(() => ({
  mockGetOrchestratorDecision: vi.fn(),
  mockExecuteSingleAgent: vi.fn().mockResolvedValue({ result: 'agent reply' }),
  mockGetOrchestratorAgent: vi.fn().mockReturnValue({ platform: 'llm', apiKey: 'sk', model: 'test', baseUrl: '' }),
}))

vi.mock('@/lib/orchestrator', () => ({
  getOrchestratorDecision: mockGetOrchestratorDecision,
  executeSingleAgent: mockExecuteSingleAgent,
  getOrchestratorAgent: mockGetOrchestratorAgent,
}))

vi.mock('@/lib/services/context-builder', () => ({
  buildContextFromHistory: vi.fn().mockReturnValue('context'),
}))

const { mockDelegateToAgent, mockRunMultiAgentDiscussion } = vi.hoisted(() => ({
  mockDelegateToAgent: vi.fn(),
  mockRunMultiAgentDiscussion: vi.fn(),
}))

vi.mock('@/lib/services/review', () => ({
  reviewResult: vi.fn(),
  delegateToAgent: mockDelegateToAgent,
  runMultiAgentDiscussion: mockRunMultiAgentDiscussion,
}))

const { mockHandlePMConfirm, mockHandleArchitectPlan, mockHandleAgentQA, mockTransitionToExecution } = vi.hoisted(() => ({
  mockHandlePMConfirm: vi.fn(),
  mockHandleArchitectPlan: vi.fn(),
  mockHandleAgentQA: vi.fn(),
  mockTransitionToExecution: vi.fn(),
}))

vi.mock('@/lib/services/alignment', () => ({
  handlePMConfirm: mockHandlePMConfirm,
  handleArchitectPlan: mockHandleArchitectPlan,
  handleAgentQA: mockHandleAgentQA,
  transitionToExecution: mockTransitionToExecution,
}))

import { handleOrchestratorDecision, validateDecision, handleOrchestratorChat } from '@/lib/services/chat-router'

const sendEvent = vi.fn()
const agents = [
  { id: 'a1', name: 'PM', systemPrompt: '', platform: 'llm', expertise: 'product', model: '', baseUrl: '', apiKey: '', tools: '[]' },
  { id: 'a2', name: '架构师', systemPrompt: '', platform: 'llm', expertise: 'arch', model: '', baseUrl: '', apiKey: '', tools: '[]' },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockMessageFindMany.mockResolvedValue([])
  mockTaskCount.mockResolvedValue(0)
  mockExecuteSingleAgent.mockResolvedValue({ result: 'agent reply' })
  mockGetOrchestratorAgent.mockReturnValue({ platform: 'llm', apiKey: 'sk', model: 'test', baseUrl: '' })
})

describe('validateDecision', () => {
  it('alignment phase + done → redirect to align_confirm', () => {
    const result = validateDecision({ action: 'done', message: '', reason: '' }, 'alignment', [])
    expect(result.action).toBe('align_confirm')
  })

  it('execution phase + align_* → redirect to execute', () => {
    const result = validateDecision({ action: 'align_confirm', message: '', reason: '' }, 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('align_qa with answered questions → redirect to execute', () => {
    const history = [
      { role: 'agent', agentId: '前端工程师', rawContent: '用什么框架？' },
      { role: 'user', rawContent: '用 React' },
    ]
    const result = validateDecision({ action: 'align_qa', message: '', reason: '' }, 'alignment', history)
    expect(result.action).toBe('execute')
  })

  it('align_qa with unanswered questions → keep align_qa', () => {
    const history = [
      { role: 'agent', agentId: '前端工程师', rawContent: '用什么框架？' },
    ]
    const result = validateDecision({ action: 'align_qa', message: '', reason: '' }, 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('normal decision → pass through unchanged', () => {
    const result = validateDecision({ action: 'self', message: 'hi', reason: 'r' }, 'chat', [])
    expect(result).toEqual({ action: 'self', message: 'hi', reason: 'r' })
  })
})

describe('handleOrchestratorDecision', () => {
  it('sends "思考中" status first', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ action: 'self', message: 'hi', reason: 'r' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'chat')
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: '思考中...' }))
  })

  it('action=delegate → calls delegateToAgent', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ action: 'delegate', target: 'PM', message: 'do it', reason: 'r' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'chat')
    expect(mockDelegateToAgent).toHaveBeenCalledWith('PM', 'do it', 's1', agents, sendEvent)
  })

  it('action=discuss → calls runMultiAgentDiscussion', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ action: 'discuss', targets: ['PM', '架构师'], message: 'discuss', reason: 'r' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'chat')
    expect(mockRunMultiAgentDiscussion).toHaveBeenCalledWith(['PM', '架构师'], 'discuss', 's1', agents, sendEvent)
  })

  it('action=align_confirm → calls handlePMConfirm', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ action: 'align_confirm', message: '', reason: 'r' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'alignment')
    expect(mockHandlePMConfirm).toHaveBeenCalled()
  })

  it('action=align_decompose → calls handleArchitectPlan', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ action: 'align_decompose', message: '', reason: 'r' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'alignment')
    expect(mockHandleArchitectPlan).toHaveBeenCalled()
  })

  it('action=align_qa → calls handleAgentQA', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ action: 'align_qa', message: '', reason: 'r' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'alignment')
    expect(mockHandleAgentQA).toHaveBeenCalled()
  })

  it('action=execute → calls transitionToExecution', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ action: 'execute', message: '', reason: 'r' })
    mockTaskCount.mockResolvedValueOnce(1)
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'execution')
    expect(mockTransitionToExecution).toHaveBeenCalled()
  })

  it('action=execute with 0 tasks → redirect to align_decompose', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ action: 'execute', message: '', reason: 'r' })
    mockTaskCount.mockResolvedValueOnce(0)
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'execution')
    expect(mockHandleArchitectPlan).toHaveBeenCalled()
    expect(mockTransitionToExecution).not.toHaveBeenCalled()
  })

  it('action=done → updates session phase and sends done event', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ action: 'done', message: 'all done', reason: 'r' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'chat')
    expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { phase: 'done', phaseStep: '' } })
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }))
  })

  it('getOrchestratorDecision throws → falls back to handleOrchestratorChat', async () => {
    mockGetOrchestratorDecision.mockRejectedValueOnce(new Error('LLM down'))
    mockSessionFindUnique.mockResolvedValueOnce({ projectDir: '/dir' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, 'chat')
    expect(mockExecuteSingleAgent).toHaveBeenCalled()
  })
})

describe('handleOrchestratorChat', () => {
  it('calls executeSingleAgent and saves result', async () => {
    mockSessionFindUnique.mockResolvedValueOnce({ projectDir: '/dir' })
    await handleOrchestratorChat('hello', 's1', sendEvent, [{ name: 'PM', expertise: 'product', platform: 'llm' }])
    expect(mockExecuteSingleAgent).toHaveBeenCalled()
    expect(mockMessageCreate).toHaveBeenCalledWith({
      data: { role: 'orchestrator', rawContent: 'agent reply', sessionId: 's1' },
    })
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'agent reply' }))
  })

  it('uses process.cwd() when projectDir is empty', async () => {
    mockSessionFindUnique.mockResolvedValueOnce({ projectDir: '' })
    await handleOrchestratorChat('hello', 's1', sendEvent)
    const config = mockExecuteSingleAgent.mock.calls[0][0]
    expect(config.workDir).toBe(process.cwd())
  })
})
