import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requestSessionCancel, clearSessionCancel } from '@/lib/cancellation'

// Mock prisma
const mockPrisma = {
  agent: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  sessionMember: {
    create: vi.fn(),
  },
  message: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout')
    await new Promise(r => setTimeout(r, 5))
  }
}

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))

// Mock orchestrator
const mockCallLLMForAnalysis = vi.fn()
const mockParseJSON = vi.fn()

vi.mock('@/lib/orchestrator', () => ({
  callLLMForAnalysis: (...args: unknown[]) => mockCallLLMForAnalysis(...args),
  parseJSON: (...args: unknown[]) => mockParseJSON(...args),
}))

describe('agent-factory — handleCreateAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) =>
      fn({ agent: mockPrisma.agent, sessionMember: mockPrisma.sessionMember, message: mockPrisma.message } as typeof mockPrisma)
    )
  })

  it('creates agent successfully with valid LLM output', async () => {
    const { handleCreateAgent } = await import('@/lib/services/agent-factory')

    mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({
      name: '测试工程师',
      expertise: '擅长自动化测试',
      systemPrompt: '你是一位测试工程师',
      platform: 'claude-code',
      capabilities: ['测试', '质量保证'],
      accentColor: '#10b981',
    }))
    mockParseJSON.mockReturnValue({
      name: '测试工程师',
      expertise: '擅长自动化测试',
      systemPrompt: '你是一位测试工程师',
      platform: 'claude-code',
      capabilities: ['测试', '质量保证'],
      accentColor: '#10b981',
    })

    mockPrisma.agent.findUnique.mockResolvedValue(null) // No existing agent
    mockPrisma.agent.create.mockResolvedValue({
      id: 'agent-1',
      name: '测试工程师',
      expertise: '擅长自动化测试',
      platform: 'claude-code',
    })
    mockPrisma.sessionMember.create.mockResolvedValue({})
    mockPrisma.message.create.mockResolvedValue({})

    const sendEvent = vi.fn()
    await handleCreateAgent('帮我创建一个测试工程师', 'session-1', sendEvent)

    expect(mockPrisma.agent.create).toHaveBeenCalled()
    expect(mockPrisma.sessionMember.create).toHaveBeenCalledWith({
      data: { sessionId: 'session-1', agentId: 'agent-1' },
    })
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'done' })
    )
  })

  it('handles name collision by appending suffix', async () => {
    const { handleCreateAgent } = await import('@/lib/services/agent-factory')

    mockCallLLMForAnalysis.mockResolvedValue('{}')
    mockParseJSON.mockReturnValue({
      name: '前端工程师',
      expertise: 'React',
      systemPrompt: '你是一位前端工程师',
    })

    // Name already exists
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'existing', name: '前端工程师' })
    mockPrisma.agent.create.mockResolvedValue({
      id: 'agent-2',
      name: '前端工程师_abc1',
      expertise: 'React',
      platform: 'claude-code',
    })
    mockPrisma.sessionMember.create.mockResolvedValue({})
    mockPrisma.message.create.mockResolvedValue({})

    const sendEvent = vi.fn()
    await handleCreateAgent('创建前端工程师', 'session-1', sendEvent)

    expect(mockPrisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: expect.stringMatching(/^前端工程师_/),
        }),
      })
    )
  })

  it('sends error when LLM output cannot be parsed', async () => {
    const { handleCreateAgent } = await import('@/lib/services/agent-factory')

    mockCallLLMForAnalysis.mockResolvedValue('not json')
    mockParseJSON.mockImplementation(() => { throw new Error('parse error') })

    const sendEvent = vi.fn()
    await handleCreateAgent('创建xxx', 'session-1', sendEvent)

    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', content: expect.stringContaining('解析失败') })
    )
    expect(mockPrisma.agent.create).not.toHaveBeenCalled()
  })

  it('sets default platform to claude-code when not specified', async () => {
    const { handleCreateAgent } = await import('@/lib/services/agent-factory')

    mockCallLLMForAnalysis.mockResolvedValue('{}')
    mockParseJSON.mockReturnValue({
      name: '设计师',
      expertise: 'UI设计',
      systemPrompt: '你是一位设计师',
      // no platform specified
    })

    mockPrisma.agent.findUnique.mockResolvedValue(null)
    mockPrisma.agent.create.mockResolvedValue({
      id: 'agent-3',
      name: '设计师',
      platform: 'claude-code',
    })
    mockPrisma.sessionMember.create.mockResolvedValue({})
    mockPrisma.message.create.mockResolvedValue({})

    const sendEvent = vi.fn()
    await handleCreateAgent('创建设计师', 'session-1', sendEvent)

    expect(mockPrisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ platform: 'claude-code' }),
      })
    )
  })

  it('P2-09: LLM 返回后取消 → 不创建 Agent/成员/消息，发停止帧', async () => {
    const { handleCreateAgent } = await import('@/lib/services/agent-factory')
    const gate = deferred<void>()
    mockCallLLMForAnalysis.mockImplementation(async () => {
      await gate.promise
      return '{}'
    })
    mockParseJSON.mockReturnValue({
      name: '取消测试 Agent',
      expertise: 'test',
      systemPrompt: 'test',
    })
    const sendEvent = vi.fn()
    try {
      const pending = handleCreateAgent('创建取消测试 Agent', 'session-cancel', sendEvent)
      await waitUntil(() => mockCallLLMForAnalysis.mock.calls.length > 0)
      requestSessionCancel('session-cancel')
      gate.resolve()
      await pending

      expect(mockPrisma.agent.findUnique).not.toHaveBeenCalled()
      expect(mockPrisma.agent.create).not.toHaveBeenCalled()
      expect(mockPrisma.sessionMember.create).not.toHaveBeenCalled()
      expect(mockPrisma.message.create).not.toHaveBeenCalled()
      expect(sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'done', content: '执行已停止' }),
      )
    } finally {
      clearSessionCancel('session-cancel')
    }
  })

  it('P2-09: Agent 创建期间取消 → 不写成员/消息', async () => {
    const { handleCreateAgent } = await import('@/lib/services/agent-factory')
    mockCallLLMForAnalysis.mockResolvedValue('{}')
    mockParseJSON.mockReturnValue({
      name: '创建中取消 Agent',
      expertise: 'test',
      systemPrompt: 'test',
    })
    mockPrisma.agent.findUnique.mockResolvedValue(null)
    mockPrisma.agent.create.mockImplementation(async () => {
      requestSessionCancel('session-cancel')
      return { id: 'agent-cancel', name: '创建中取消 Agent', expertise: 'test', platform: 'claude-code' }
    })
    const sendEvent = vi.fn()
    try {
      await handleCreateAgent('创建中取消 Agent', 'session-cancel', sendEvent)

      expect(mockPrisma.sessionMember.create).not.toHaveBeenCalled()
      expect(mockPrisma.message.create).not.toHaveBeenCalled()
      expect(sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'done', content: '执行已停止' }),
      )
    } finally {
      clearSessionCancel('session-cancel')
    }
  })

  it('sends status event before processing', async () => {
    const { handleCreateAgent } = await import('@/lib/services/agent-factory')

    mockCallLLMForAnalysis.mockResolvedValue('{}')
    mockParseJSON.mockReturnValue({
      name: 'DevOps', expertise: 'CI/CD', systemPrompt: 'DevOps engineer',
    })
    mockPrisma.agent.findUnique.mockResolvedValue(null)
    mockPrisma.agent.create.mockResolvedValue({ id: 'a1', name: 'DevOps', platform: 'claude-code' })
    mockPrisma.sessionMember.create.mockResolvedValue({})
    mockPrisma.message.create.mockResolvedValue({})

    const sendEvent = vi.fn()
    await handleCreateAgent('创建DevOps', 'session-1', sendEvent)

    // First call should be status
    expect(sendEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ type: 'status' })
    )
  })
})
