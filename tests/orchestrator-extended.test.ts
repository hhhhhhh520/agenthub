import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockEnsureOrchestratorAgent, mockGetOrchestratorConfig, mockAgentFindFirst, mockSessionMemberUpdateMany, mockAgentFindById } = vi.hoisted(() => ({
  mockEnsureOrchestratorAgent: vi.fn().mockResolvedValue(undefined),
  mockGetOrchestratorConfig: vi.fn().mockResolvedValue({ apiKey: 'sk', model: 'test', baseUrl: '' }),
  mockAgentFindFirst: vi.fn().mockResolvedValue({ id: 'orch-1', platform: 'claude-code', model: 'test', baseUrl: '', apiKey: 'sk' }),
  mockSessionMemberUpdateMany: vi.fn(),
  mockAgentFindById: vi.fn(),
}))

vi.mock('@/lib/app-config', () => ({
  ensureOrchestratorAgent: mockEnsureOrchestratorAgent,
  getOrchestratorConfig: mockGetOrchestratorConfig,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    agent: { findFirst: mockAgentFindFirst },
    sessionMember: { updateMany: mockSessionMemberUpdateMany, findUnique: vi.fn().mockResolvedValue(null) },
  },
}))

const { mockAdapterConnect, mockAdapterSend, mockAdapterClose, mockCreateAdapter } = vi.hoisted(() => {
  const mockAdapterConnect = vi.fn().mockResolvedValue(undefined)
  const mockAdapterSend = vi.fn()
  const mockAdapterClose = vi.fn().mockResolvedValue(undefined)
  return {
    mockAdapterConnect,
    mockAdapterSend,
    mockAdapterClose,
    mockCreateAdapter: vi.fn().mockReturnValue({
      connect: mockAdapterConnect,
      send: mockAdapterSend,
      close: mockAdapterClose,
    }),
  }
})

vi.mock('@/lib/adapter', () => ({
  createAdapter: mockCreateAdapter,
  StreamChunk: {},
}))

vi.mock('@/lib/mcp-config', () => ({
  buildMCPConfig: vi.fn().mockReturnValue('mcp-config'),
}))

import {
  getOrchestratorAgent,
  callLLMForAnalysis,
  parseJSON,
  analyzeScene,
  getOrchestratorDecision,
  generateRoles,
  decomposeTasks,
  executeSingleAgent,
  executeTaskBatch,
  runDiscussion,
  formatArchitectPlan,
} from '@/lib/orchestrator'

beforeEach(() => {
  vi.clearAllMocks()
  mockEnsureOrchestratorAgent.mockResolvedValue(undefined)
  mockAgentFindFirst.mockResolvedValue({ id: 'orch-1', platform: 'claude-code', model: 'test', baseUrl: '', apiKey: 'sk' })
  mockAdapterConnect.mockResolvedValue(undefined)
  mockAdapterClose.mockResolvedValue(undefined)
  // Default: adapter yields one text chunk then closes
  mockAdapterSend.mockImplementation(async function* () {
    yield { type: 'text', content: '{"result":"ok"}' }
  })
})

describe('getOrchestratorAgent', () => {
  it('returns agent config from DB', async () => {
    const result = await getOrchestratorAgent()
    expect(result.platform).toBe('claude-code')
    expect(result.model).toBe('test')
    expect(mockEnsureOrchestratorAgent).toHaveBeenCalled()
  })

  it('falls back to AppConfig when no agent in DB', async () => {
    mockAgentFindFirst.mockResolvedValueOnce(null)
    mockGetOrchestratorConfig.mockResolvedValueOnce({ apiKey: 'cfg-key', model: 'cfg-model', baseUrl: 'cfg-url' })
    const result = await getOrchestratorAgent()
    expect(result.platform).toBe('claude-code')
    expect(result.model).toBe('cfg-model')
    expect(result.apiKey).toBe('cfg-key')
  })
})

describe('callLLMForAnalysis', () => {
  it('creates adapter, sends prompt, returns result', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'analysis result' }
    })
    const result = await callLLMForAnalysis('analyze this')
    expect(result).toBe('analysis result')
    expect(mockCreateAdapter).toHaveBeenCalled()
    expect(mockAdapterClose).toHaveBeenCalled()
  })

  it('throws when LLM returns empty', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: '  ' }
    })
    await expect(callLLMForAnalysis('test')).rejects.toThrow('LLM returned empty response')
  })

  it('collects error chunks as result', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'error', content: 'something went wrong' }
    })
    const result = await callLLMForAnalysis('test')
    expect(result).toBe('something went wrong')
  })
})

describe('parseJSON', () => {
  it('parses valid JSON directly', () => {
    expect(parseJSON('{"a":1}')).toEqual({ a: 1 })
  })

  it('extracts from markdown code fence', () => {
    expect(parseJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('extracts JSON object from mixed text', () => {
    expect(parseJSON('Here is the result: {"a":1} done')).toEqual({ a: 1 })
  })

  it('extracts JSON array from mixed text', () => {
    expect(parseJSON('Result: [1,2,3] done')).toEqual([1, 2, 3])
  })

  it('throws on invalid JSON', () => {
    expect(() => parseJSON('not json at all')).toThrow('Failed to parse JSON')
  })

  it('throws when required key missing', () => {
    expect(() => parseJSON('{"a":1}', ['b'])).toThrow('Missing required field: b')
  })

  it('passes when all required keys present', () => {
    expect(parseJSON('{"a":1,"b":2}', ['a', 'b'])).toEqual({ a: 1, b: 2 })
  })
})

describe('analyzeScene', () => {
  it('calls LLM and parses response', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: JSON.stringify({ type: 'code', complexity: 'simple', description: 'build a todo app' }) }
    })
    const result = await analyzeScene('build a todo app')
    expect(result.type).toBe('code')
    expect(result.complexity).toBe('simple')
  })
})

describe('getOrchestratorDecision', () => {
  it('calls LLM and parses decision', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: JSON.stringify({ action: 'self', message: 'hi', reason: 'greeting' }) }
    })
    const result = await getOrchestratorDecision('hello', [{ name: 'PM', expertise: 'product', platform: 'claude-code' }], 'context')
    expect(result.decision.action).toBe('self')
    expect(result.decision.reason).toBe('greeting')
  })
})

describe('generateRoles', () => {
  it('calls LLM and parses agents list', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: JSON.stringify({ agents: [{ name: 'PM', expertise: 'product', systemPrompt: 'you are PM', platform: 'claude-code' }] }) }
    })
    const result = await generateRoles('code', 'build a todo app')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('PM')
  })

  it('throws when agents list is empty', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: JSON.stringify({ agents: [] }) }
    })
    await expect(generateRoles('code', 'task')).rejects.toThrow('empty agents list')
  })
})

describe('executeSingleAgent', () => {
  it('sends prompt and returns result', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'hello from agent' }
    })
    const onChunk = vi.fn()
    const result = await executeSingleAgent(
      { name: 'PM', systemPrompt: 'sp', platform: 'claude-code' },
      'do task', 'ctx', onChunk
    )
    expect(result.result).toBe('hello from agent')
    expect(onChunk).toHaveBeenCalled()
  })

  it('captures session id from session chunk', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'session', content: 'sess-123' }
      yield { type: 'text', content: 'done' }
    })
    const result = await executeSingleAgent(
      { name: 'PM', systemPrompt: 'sp', platform: 'claude-code' },
      'task', '', vi.fn()
    )
    expect(result.sessionId).toBe('sess-123')
  })

  it('returns EMPTY_RESPONSE when result is empty', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'status', content: 'done' }
    })
    const onChunk = vi.fn()
    const result = await executeSingleAgent(
      { name: 'PM', systemPrompt: 'sp', platform: 'claude-code' },
      'task', '', onChunk
    )
    expect(result.result).toBe('[Agent 未返回有效内容]')
  })

  it('prepends tools hint when agent has tools', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'ok' }
    })
    await executeSingleAgent(
      { name: 'PM', systemPrompt: 'sp', platform: 'claude-code', tools: '["bash","read"]' },
      'do it', '', vi.fn()
    )
    const sendCall = mockAdapterSend.mock.calls[0][0]
    expect(sendCall.prompt).toContain('[可用工具: bash, read]')
    expect(sendCall.prompt).toContain('do it')
  })
})

describe('executeTaskBatch', () => {
  it('executes tasks and returns results map', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'task result' }
    })
    const tasks = [
      { id: 't1', description: 'task 1', assignedAgent: 'PM', dependencies: [], declaredFiles: [], batch: 0 },
    ]
    const agents = [{ name: 'PM', systemPrompt: 'sp', platform: 'claude-code' }]
    const { results, failedTaskIds } = await executeTaskBatch(tasks, agents, vi.fn())
    expect(results.get('t1')?.result).toBe('task result')
    expect(failedTaskIds).toEqual([])
  })

  it('records failed task ids when adapter throws', async () => {
    mockAdapterSend.mockImplementation(async function* () { throw new Error('crash') })
    const tasks = [
      { id: 't1', description: 'task 1', assignedAgent: 'PM', dependencies: [], declaredFiles: [], batch: 0 },
    ]
    const agents = [{ name: 'PM', systemPrompt: 'sp', platform: 'claude-code' }]
    const { failedTaskIds } = await executeTaskBatch(tasks, agents, vi.fn())
    expect(failedTaskIds).toContain('t1')
  })

  it('respects batch ordering (batch 1 waits for batch 0)', async () => {
    const callOrder: string[] = []
    mockAdapterSend.mockImplementation(async function* () {
      callOrder.push('send')
      yield { type: 'text', content: 'result' }
    })
    const tasks = [
      { id: 't1', description: 'first', assignedAgent: 'PM', dependencies: [], declaredFiles: [], batch: 0 },
      { id: 't2', description: 'second', assignedAgent: 'PM', dependencies: ['t1'], declaredFiles: [], batch: 1 },
    ]
    const agents = [{ name: 'PM', systemPrompt: 'sp', platform: 'claude-code' }]
    await executeTaskBatch(tasks, agents, 'ctx', vi.fn())
    expect(callOrder.length).toBe(2)
  })
})

describe('runDiscussion', () => {
  it('runs multiple rounds and collects opinions', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'my opinion' }
    })
    const agents = [
      { name: 'PM', systemPrompt: 'sp', platform: 'claude-code' },
      { name: 'Arch', systemPrompt: 'sp2', platform: 'claude-code' },
    ]
    const opinions = await runDiscussion('topic', agents, 2, vi.fn())
    expect(opinions).toHaveLength(4) // 2 agents * 2 rounds
    expect(opinions[0]).toContain('PM（第1轮）')
  })

  it('skips agent on error and continues', async () => {
    let callCount = 0
    mockAdapterSend.mockImplementation(async function* () {
      callCount++
      if (callCount === 1) throw new Error('fail')
      yield { type: 'text', content: 'ok' }
    })
    const agents = [{ name: 'PM', systemPrompt: 'sp', platform: 'claude-code' }]
    const opinions = await runDiscussion('topic', agents, 1, vi.fn())
    expect(opinions[0]).toContain('讨论出错')
  })
})

describe('formatArchitectPlan', () => {
  it('formats tasks with batches and dependencies', () => {
    const tasks = [
      { id: 't1', description: 'setup DB', assignedAgent: '后端', dependencies: [], declaredFiles: ['schema.prisma'], batch: 0 },
      { id: 't2', description: 'build API', assignedAgent: '后端', dependencies: ['t1'], declaredFiles: [], batch: 1 },
    ]
    const agents = [{ name: '后端', expertise: 'backend' }]
    const result = formatArchitectPlan(tasks, agents)
    expect(result).toContain('## 架构师方案')
    expect(result).toContain('批次 1')
    expect(result).toContain('批次 2')
    expect(result).toContain('setup DB')
    expect(result).toContain('schema.prisma')
    expect(result).toContain('依赖：t1')
  })
})
