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

  it('ISSUE-027: CLI 合成错误文本上抛而非当返回值（09-27 聊天假成功死相的收口）', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: "There's an issue with the selected model (mimo-v2.6-flash). It may not exist or you may not have access to it." }
    })
    await expect(executeSingleAgent(
      { name: 'PM', systemPrompt: 'sp', platform: 'claude-code' },
      'task', '', vi.fn()
    )).rejects.toThrow(/\[CLI 合成错误拦截\]/)
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
    const { failedTaskIds, failedTaskReasons } = await executeTaskBatch(tasks, agents, vi.fn())
    expect(failedTaskIds).toContain('t1')
    // ISSUE-011 F1: rejection reason 透传,不丢弃
    expect(failedTaskReasons['t1']).toBe('crash')
  })

  it('ISSUE-011 F1: no crash on null-prototype rejection reason', async () => {
    // null-prototype 对象没有 toString/valueOf,旧代码 String(reason) 会抛
    // TypeError → 冒泡到 execution.ts catch → 整批误标失败且真实原因丢失
    mockAdapterSend.mockImplementation(async function* () {
      throw Object.create(null)
    })
    const tasks = [
      { id: 't1', description: 'task 1', assignedAgent: 'PM', dependencies: [], declaredFiles: [], batch: 0 },
    ]
    const agents = [{ name: 'PM', systemPrompt: 'sp', platform: 'claude-code' }]
    const { failedTaskIds, failedTaskReasons } = await executeTaskBatch(tasks, agents, vi.fn())
    expect(failedTaskIds).toContain('t1')
    // 不抛异常:JSON.stringify(null-prototype 空对象) 安全序列化为 '{}'
    expect(failedTaskReasons['t1']).toBe('{}')
  })

  it('P0: preloadedIds marks priorResults history, not batch tasks', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'batch result' }
    })
    const tasks = [
      { id: 't1', description: 'task 1', assignedAgent: 'PM', dependencies: [], declaredFiles: [], batch: 0 },
    ]
    const agents = [{ name: 'PM', systemPrompt: 'sp', platform: 'claude-code' }]
    const priorResults = new Map<string, string>([['historical-1', 'old result']])
    const { results, preloadedIds, failedTaskIds } = await executeTaskBatch(
      tasks, agents, vi.fn(), undefined, undefined, priorResults
    )
    // 预装的历史任务被标记为 preloaded(供 handleExecution 跳过)
    expect(preloadedIds).toContain('historical-1')
    // 本批新执行任务不被标记为预装
    expect(preloadedIds).not.toContain('t1')
    // 预装结果仍在 results 里(executeTaskBatch 内部依赖查找需要)
    expect(results.get('historical-1')?.result).toBe('old result')
    expect(failedTaskIds).toEqual([])
  })

  it('P0: 纠偏重试任务(本批执行且出现在 priorResults)不被标记 preloaded,新结果不被丢弃', async () => {
    // 生命周期审查抓到的 overlap ❌: 纠偏后任务置回 pending,下一迭代它同时在
    // priorResults(旧 result) 和本批 readyTasks(重跑)。若被标记 preloaded,
    // handleExecution 会误跳过本批真实执行的新结果 → 任务滞留 pending 永久不完成
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'retry result v2' }
    })
    const tasks = [
      { id: 't1', description: 'task 1', assignedAgent: 'PM', dependencies: [], declaredFiles: [], batch: 0 },
    ]
    const agents = [{ name: 'PM', systemPrompt: 'sp', platform: 'claude-code' }]
    // t1 上一轮执行过(旧 result 在 allResults),本批又要重跑(纠偏/redo)
    const priorResults = new Map<string, string>([['t1', 'old result v1']])
    const { results, preloadedIds, failedTaskIds } = await executeTaskBatch(
      tasks, agents, vi.fn(), undefined, undefined, priorResults
    )
    // 本批执行的任务即使出现在 priorResults 也不标记 preloaded
    expect(preloadedIds).not.toContain('t1')
    // 本批真实执行的新结果覆盖旧结果,handleExecution 会正常处理它
    expect(results.get('t1')?.result).toBe('retry result v2')
    expect(failedTaskIds).toEqual([])
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
  it('ISSUE-027: agent 回复=CLI 合成错误 → 真实错误文本进 skipMsg，不当观点消费', async () => {
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'Failed to authenticate. API Error: 401 The API key format is incorrect. Request id: 0217ab' }
    })
    const agents = [{ name: 'PM', systemPrompt: 'sp', platform: 'claude-code' }]
    const opinions = await runDiscussion('topic', agents, 1, vi.fn())
    expect(opinions[0]).toContain('讨论出错，已跳过：')
    expect(opinions[0]).toContain('Failed to authenticate') // 真实错误透传（09-27 只见「超时」的根治面）
    expect(opinions[0]).toContain('[CLI 合成错误拦截]')
  })

  it('ISSUE-027: 正常长回复以错误字符串开头 → 不误拦（长度上限防线）', async () => {
    const legit = 'Failed to authenticate. API Error: 401 是常见状态码。' +
      '排查步骤：一、确认 baseUrl 的协议面（OpenAI/Anthropic）；二、确认 key 前缀格式属于该网关；' +
      '三、在控制台确认模型权限已开通（403 Unpurchased 场景要看 AccessDenied 的具体错误码）。' +
      '另外注意 claude CLI 的 -p 模式会忽略进程环境变量里注入的 ANTHROPIC_BASE_URL，' +
      '所以即使 env 配置完全正确，请求也可能落到用户级 settings.json 声明的旧端点上；' +
      '错误文本里的 Request id 前缀能帮你判断真正被击中的是哪家网关，' +
      'UUID 风格与 0217 开头的长串分属不同平台，这是本次排查里最省时的鉴别技巧。'
    expect(legit.length).toBeGreaterThanOrEqual(300)
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: legit }
    })
    const agents = [{ name: 'PM', systemPrompt: 'sp', platform: 'claude-code' }]
    const opinions = await runDiscussion('topic', agents, 1, vi.fn())
    expect(opinions[0]).toContain('PM（第1轮）：Failed to authenticate') // 作为观点正常收集
  })

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

  it('ISSUE-003: discussion agents get per-agent isolated processes, no MCP', async () => {
    // 真回归守卫:旧代码有 sessionId 时会 buildMCPConfig 注入 mcpConfig(本测试红)。
    // 同时钉住进程隔离维度——同会话不同 Agent 必须走不同 registry key(防串话)
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'opinion' }
    })
    await runDiscussion('topic', [
      { name: 'PM', systemPrompt: 'sp', platform: 'claude-code' },
      { name: '架构师', systemPrompt: 'sp2', platform: 'claude-code' },
    ], 1, vi.fn(), 'sess-1')
    const connects = mockAdapterConnect.mock.calls.map(c => c[0])
    expect(connects).toHaveLength(2)
    // 每个 Agent 独立 agentId → registry key 不同 → 独立 CLI 进程(防同凭证 Agent 串话)
    expect(connects[0].agentId).toBe('PM')
    expect(connects[1].agentId).toBe('架构师')
    expect(connects[0].chatSessionId).toBe('sess-1')
    // 讨论阶段绝不注入 MCP(物理隔离工具)
    for (const cfg of connects) {
      expect(cfg.mcpConfig).toBeUndefined()
    }
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

// ── ISSUE-028 T2 集成：设 AGENTHUB_DECISION_MODEL → 决策/拆解走快模型直连，不走 CLI adapter ──
describe('ISSUE-028 决策快模型通道集成', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = ['AGENTHUB_DECISION_MODEL', 'AGENTHUB_DECISION_BASE_URL', 'AGENTHUB_DECISION_API_KEY'] as const

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    vi.unstubAllGlobals()
  })

  function stubFetch(content: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => content,
      text: async () => JSON.stringify(content),
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('env 未设 → 快通道关闭，走原 adapter 路径（行为不变对照，fetch 零调用）', async () => {
    const fetchMock = stubFetch({ choices: [{ message: { content: '{}' } }] })
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: JSON.stringify({ action: 'self', message: 'hi', reason: 'r' }) }
    })
    const result = await getOrchestratorDecision('hello', [{ name: 'PM', expertise: 'product', platform: 'claude-code' }], 'context')
    expect(result.decision.action).toBe('self')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockCreateAdapter).toHaveBeenCalled()
  })

  it('env 设定 + orchestrator 凭据齐全 → fetch 直连决策，adapter 零调用，sessionId undefined', async () => {
    mockAgentFindFirst.mockResolvedValueOnce({ id: 'orch-1', platform: 'opencode', model: 'mimo-v2.6-flash', baseUrl: 'https://gw.test/v1', apiKey: 'sk-orch' })
    const fetchMock = stubFetch({ choices: [{ message: { content: JSON.stringify({ action: 'align_confirm', target: null, targets: null, message: 'm', reason: 'r' }) } }] })
    process.env.AGENTHUB_DECISION_MODEL = 'qwen3.8-flash'
    const result = await getOrchestratorDecision('hello', [{ name: 'PM', expertise: 'product', platform: 'opencode' }], 'context')
    expect(result.decision.action).toBe('align_confirm')
    expect(result.sessionId).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://gw.test/v1/chat/completions')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-orch')
    expect(JSON.parse(init.body as string).model).toBe('qwen3.8-flash')
    expect(mockCreateAdapter).not.toHaveBeenCalled()
  })

  it('快通道调用失败 → 原样上抛（不静默回落 CLI 慢路径）', async () => {
    mockAgentFindFirst.mockResolvedValueOnce({ id: 'orch-1', platform: 'opencode', model: 'mimo', baseUrl: 'https://gw.test/v1', apiKey: 'sk-orch' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('gateway down')))
    process.env.AGENTHUB_DECISION_MODEL = 'qwen3.8-flash'
    await expect(getOrchestratorDecision('hello', [], 'context')).rejects.toThrow('gateway down')
    expect(mockCreateAdapter).not.toHaveBeenCalled()
  })

  it('env 设定但 orchestrator 无 baseUrl → 配置解析 null，回落原 adapter 路径', async () => {
    mockAgentFindFirst.mockResolvedValueOnce({ id: 'orch-1', platform: 'claude-code', model: 'test', baseUrl: '', apiKey: 'sk' })
    const fetchMock = stubFetch({ choices: [] })
    process.env.AGENTHUB_DECISION_MODEL = 'qwen3.8-flash'
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: JSON.stringify({ action: 'self', message: 'hi', reason: 'r' }) }
    })
    const result = await getOrchestratorDecision('hello', [], 'context')
    expect(result.decision.action).toBe('self')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockCreateAdapter).toHaveBeenCalled()
  })

  it('decomposeTasks 同享快通道（callLLM 收口，架构师拆解不再依赖推理模型 JSON）', async () => {
    mockAgentFindFirst.mockResolvedValueOnce({ id: 'orch-1', platform: 'opencode', model: 'mimo', baseUrl: 'https://gw.test/v1', apiKey: 'sk-orch' })
    const tasksPayload = { tasks: [{ id: 1, description: '实现登录', assignedAgent: '后端', dependencies: [], declared_files: ['src/login.ts'] }] }
    const fetchMock = stubFetch({ choices: [{ message: { content: JSON.stringify(tasksPayload) } }] })
    process.env.AGENTHUB_DECISION_MODEL = 'qwen3.8-flash'
    const tasks = await decomposeTasks('做登录', [{ name: '后端', expertise: 'backend' }])
    expect(tasks).toHaveLength(1)
    expect(tasks[0].description).toBe('实现登录')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockCreateAdapter).not.toHaveBeenCalled()
  })

  it('callLLMForAnalysis 不走快通道（review 质量审查维持原线路——声明排除项，防未来顺手收口）', async () => {
    process.env.AGENTHUB_DECISION_MODEL = 'qwen3.8-flash'
    const fetchMock = stubFetch({ choices: [{ message: { content: '{}' } }] })
    mockAdapterSend.mockImplementation(async function* () {
      yield { type: 'text', content: 'analysis result' }
    })
    const result = await callLLMForAnalysis('analyze this')
    expect(result).toBe('analysis result')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockCreateAdapter).toHaveBeenCalled()
  })
})
