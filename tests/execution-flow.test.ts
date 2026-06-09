import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock declarations ──────────────────────────────────────────────
const {
  mockSessionFindUnique,
  mockSessionUpdate,
  mockAgentFindUnique,
  mockAgentCreate,
  mockSessionMemberFindMany,
  mockSessionMemberCreate,
  mockTaskFindMany,
  mockTaskCreate,
  mockTaskUpdate,
  mockTaskCount,
  mockMessageFindMany,
  mockMessageCreate,
  mockExecuteSingleAgent,
  mockExecuteTaskBatch,
  mockCallLLMForAnalysis,
  mockAnalyzeScene,
  mockGenerateRoles,
  mockDecomposeTasks,
  mockGetChangedFiles,
  mockGetGitSnapshot,
} = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockAgentFindUnique: vi.fn(),
  mockAgentCreate: vi.fn(),
  mockSessionMemberFindMany: vi.fn(),
  mockSessionMemberCreate: vi.fn(),
  mockTaskFindMany: vi.fn(),
  mockTaskCreate: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskCount: vi.fn(),
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockMessageCreate: vi.fn(),
  mockExecuteSingleAgent: vi.fn(),
  mockExecuteTaskBatch: vi.fn(),
  mockCallLLMForAnalysis: vi.fn(),
  mockAnalyzeScene: vi.fn(),
  mockGenerateRoles: vi.fn(),
  mockDecomposeTasks: vi.fn(),
  mockGetChangedFiles: vi.fn().mockReturnValue([]),
  mockGetGitSnapshot: vi.fn().mockReturnValue(new Set()),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: mockSessionFindUnique, update: mockSessionUpdate },
    agent: { findUnique: mockAgentFindUnique, create: mockAgentCreate },
    sessionMember: { findMany: mockSessionMemberFindMany, create: mockSessionMemberCreate, updateMany: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
    task: { findMany: mockTaskFindMany, create: mockTaskCreate, update: mockTaskUpdate, count: mockTaskCount },
    message: { findMany: mockMessageFindMany, create: mockMessageCreate },
  },
}))

vi.mock('@/lib/orchestrator', () => ({
  executeSingleAgent: mockExecuteSingleAgent,
  executeTaskBatch: mockExecuteTaskBatch,
  callLLMForAnalysis: mockCallLLMForAnalysis,
  analyzeScene: mockAnalyzeScene,
  generateRoles: mockGenerateRoles,
  decomposeTasks: mockDecomposeTasks,
  parseJSON: vi.fn(),
  getOrchestratorAgent: vi.fn().mockResolvedValue({ platform: 'claude-code', model: 'test', apiKey: 'key', baseUrl: '' }),
  formatArchitectPlan: vi.fn().mockReturnValue('## 架构师方案\n'),
  runDiscussion: vi.fn().mockResolvedValue([]),
  topologicalSort: vi.fn(),
}))

vi.mock('@/lib/services/git-utils', () => ({
  getChangedFiles: mockGetChangedFiles,
  getGitSnapshot: mockGetGitSnapshot,
}))

vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: vi.fn().mockReturnValue('monitoring prompt'),
  PM_CONFIRMATION_PROMPT: '确认需求：{userMessage}',
  buildAgentQuestionPrompt: vi.fn().mockReturnValue('question prompt'),
  buildDiscussionPrompt: vi.fn().mockReturnValue('discussion prompt'),
  SCENE_ANALYSIS_PROMPT: 'scene prompt',
  ROLE_GENERATION_PROMPT: 'role prompt',
  TASK_DECOMPOSITION_PROMPT: 'task prompt',
  ORCHESTRATOR_DECISION_PROMPT: 'decision prompt',
}))

vi.mock('@/lib/app-config', () => ({
  getOrchestratorConfig: vi.fn().mockResolvedValue({ apiKey: '', model: 'test', baseUrl: '' }),
  ensureOrchestratorAgent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/session-lock', () => ({
  acquireSessionLock: vi.fn().mockReturnValue(() => {}),
}))

vi.mock('@/lib/services/context-builder', () => ({
  buildContextFromHistory: vi.fn().mockReturnValue('context'),
}))

vi.mock('@/lib/orchestrator/scheduler', () => ({
  topologicalSort: vi.fn().mockImplementation((tasks: any[]) => tasks),
  enforceFileOverlap: vi.fn().mockImplementation((tasks: any[]) => tasks),
}))

// ── Imports ────────────────────────────────────────────────────────
import { handlePMConfirm, handleArchitectPlan, handleAgentQA } from '@/lib/services/alignment'
import { handleExecution } from '@/lib/services/execution'

// ── Helpers ────────────────────────────────────────────────────────
function makeAgent(overrides?: Partial<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>) {
  return {
    id: 'agent-1', name: '测试Agent', systemPrompt: '你是测试Agent', platform: 'claude-code',
    expertise: '测试', model: 'test', baseUrl: '', apiKey: '', tools: '[]', ...overrides,
  }
}

function makeTask(overrides?: Partial<{ id: string; description: string; status: string; assignedAgentId: string; sessionId: string; dependencies: string; declaredFiles: string; correctionCount: number; cliSessionId: string | null }>) {
  return {
    id: 'task-1', description: '测试任务', status: 'pending', assignedAgentId: 'agent-1',
    sessionId: 'session-1', dependencies: '[]', declaredFiles: '[]', correctionCount: 0, cliSessionId: null, ...overrides,
  }
}

const sendEvent = vi.fn()

// ── Tests ──────────────────────────────────────────────────────────

describe('1. align_confirm — PM确认需求', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionFindUnique.mockResolvedValue({ id: 'session-1', projectDir: '', permissionMode: 'default' })
  })

  it('路径A: agents非空 → 直接用传入的PM agent', async () => {
    const pmAgent = makeAgent({ id: 'pm-1', name: '产品经理' })
    mockExecuteSingleAgent.mockResolvedValue({ result: '需求确认：搭建博客系统' })

    await handlePMConfirm('搭建博客', 'session-1', [pmAgent], sendEvent)

    // 设置 phase
    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { phase: 'alignment', phaseStep: 'pm_confirm' },
    })
    // PM agent 被调用
    expect(mockExecuteSingleAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: '产品经理' }),
      expect.stringContaining('确认需求'),
      '',
      expect.any(Function),
      'session-1',
      expect.any(String),
    )
    // 结果写入 message
    expect(mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'agent', agentId: '产品经理' }) }),
    )
    // 发送 awaiting_user_input
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'awaiting_user_input', content: 'pm_confirm' }))
  })

  it('路径B: agents空 → 自动组建团队', async () => {
    mockAnalyzeScene.mockResolvedValue({ type: 'code', complexity: 'complex', description: '搭建博客' })
    mockGenerateRoles.mockResolvedValue([
      { name: '前端工程师', expertise: 'React', systemPrompt: '你是前端', platform: 'claude-code' },
    ])
    mockAgentFindUnique.mockResolvedValue(null)
    mockAgentCreate.mockResolvedValue({ id: 'new-agent-1', name: '前端工程师' })
    mockSessionMemberCreate.mockResolvedValue({})
    mockSessionMemberFindMany.mockResolvedValue([
      { agent: makeAgent({ id: 'new-agent-1', name: '前端工程师' }) },
    ])
    mockExecuteSingleAgent.mockResolvedValue({ result: '需求确认...' })

    await handlePMConfirm('搭建博客', 'session-1', [], sendEvent)

    // 组建团队
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: '正在分析任务并组建团队...' }))
    expect(mockAgentCreate).toHaveBeenCalled()
    expect(mockSessionMemberCreate).toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('已组建团队') }))
  })
})

describe('2. align_decompose — 架构师拆任务', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionFindUnique.mockResolvedValue({ id: 'session-1', projectDir: '', permissionMode: 'default' })
    mockMessageFindMany.mockResolvedValue([{ role: 'user', rawContent: '搭建博客', agentId: null }])
  })

  it('正常路径: 架构师返回合法JSON → 任务写入DB', async () => {
    const archAgent = makeAgent({ id: 'arch-1', name: '架构师' })
    const taskJson = JSON.stringify({
      tasks: [{ id: 1, description: '建数据库', assignedAgent: '后端', dependencies: [], declared_files: ['src/db/schema.prisma'] }],
    })
    mockExecuteSingleAgent.mockResolvedValue({ result: taskJson })
    // mock parseJSON to return parsed tasks
    const { parseJSON } = await import('@/lib/orchestrator')
    vi.mocked(parseJSON).mockReturnValue({
      tasks: [{ id: 1, description: '建数据库', assignedAgent: '后端', dependencies: [], declared_files: ['src/db/schema.prisma'] }],
    })

    await handleArchitectPlan('搭建博客', 'session-1', [archAgent], sendEvent)

    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { phase: 'alignment', phaseStep: 'architect_plan' },
    })
    expect(mockTaskCreate).toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'awaiting_user_input', content: 'architect_plan' }))
  })

  it('fallback路径: 架构师返回非JSON → decomposeTasks兜底', async () => {
    const archAgent = makeAgent({ id: 'arch-1', name: '架构师' })
    mockExecuteSingleAgent.mockResolvedValue({ result: '这不是JSON' })
    const { parseJSON } = await import('@/lib/orchestrator')
    vi.mocked(parseJSON).mockImplementation(() => { throw new Error('parse error') })
    mockDecomposeTasks.mockResolvedValue([
      { id: 'task-fallback', description: 'fallback任务', assignedAgent: '后端', dependencies: [], declaredFiles: [], batch: 0 },
    ])

    await handleArchitectPlan('搭建博客', 'session-1', [archAgent], sendEvent)

    expect(mockDecomposeTasks).toHaveBeenCalled()
    expect(mockTaskCreate).toHaveBeenCalled()
  })
})

describe('3. align_qa — 各Agent提问', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionFindUnique.mockResolvedValue({ id: 'session-1', projectDir: '', permissionMode: 'default' })
    mockMessageFindMany.mockResolvedValue([
      { role: 'user', rawContent: '搭建博客', agentId: null },
      { role: 'agent', rawContent: '方案...', agentId: '架构师' },
    ])
  })

  it('有问题路径: Agent返回问题 → 写入DB + awaiting_user_input', async () => {
    const agents = [
      makeAgent({ id: 'fe-1', name: '前端工程师', expertise: 'React' }),
      makeAgent({ id: 'be-1', name: '后端工程师', expertise: 'Node.js' }),
    ]
    mockExecuteSingleAgent
      .mockResolvedValueOnce({ result: '用 React 还是 Vue？' })
      .mockResolvedValueOnce({ result: '用什么数据库？' })

    await handleAgentQA('搭建博客', 'session-1', agents, sendEvent)

    // 两条问题消息写入 DB
    const messageCalls = mockMessageCreate.mock.calls.filter(
      (c: any[]) => c[0].data.role === 'agent'
    )
    expect(messageCalls.length).toBe(2)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'awaiting_user_input', content: 'agent_qa' }))
  })

  it('无问题路径: 所有Agent返回"无问题" → 自动进入execution', async () => {
    const agents = [
      makeAgent({ id: 'fe-1', name: '前端工程师', expertise: 'React' }),
    ]
    mockExecuteSingleAgent.mockResolvedValue({ result: '无问题' })
    mockTaskFindMany.mockResolvedValue([])

    await handleAgentQA('搭建博客', 'session-1', agents, sendEvent)

    // 发送"无疑问，开始执行"
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('无疑问') }))
    // transitionToExecution 发送 phase_transition=execution
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'phase_transition', content: 'execution' }))
  })
})

describe('4. while(hasProgress) 执行循环', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionFindUnique.mockResolvedValue({ id: 'session-1', projectDir: '/tmp/test', permissionMode: 'default' })
    mockSessionMemberFindMany.mockResolvedValue([
      { agent: makeAgent({ id: 'agent-1', name: 'Agent1' }) },
      { agent: makeAgent({ id: 'agent-2', name: 'Agent2' }) },
      { agent: makeAgent({ id: 'agent-3', name: 'Agent3' }) },
    ])
    mockMessageFindMany.mockResolvedValue([])
  })

  it('按依赖顺序分批执行: A先 → B,C并行', async () => {
    const taskA = makeTask({ id: 'a', description: '任务A', status: 'pending', assignedAgentId: 'agent-1', dependencies: '[]' })
    const taskB = makeTask({ id: 'b', description: '任务B', status: 'pending', assignedAgentId: 'agent-2', dependencies: '["a"]' })
    const taskC = makeTask({ id: 'c', description: '任务C', status: 'pending', assignedAgentId: 'agent-3', dependencies: '["a"]' })

    // findMany returns tasks with mutable status
    const tasks = [taskA, taskB, taskC]
    mockTaskFindMany.mockResolvedValue(tasks)

    // executeTaskBatch: first call → A completes, second call → B,C complete
    mockExecuteTaskBatch
      .mockResolvedValueOnce({ results: new Map([['a', { result: 'result-a' }]]), failedTaskIds: [] })
      .mockResolvedValueOnce({ results: new Map([['b', { result: 'result-b' }], ['c', { result: 'result-c' }]]), failedTaskIds: [] })

    // LLM review passes for all tasks
    mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({ needsCorrection: false, quality: 'good' }))

    await handleExecution('', 'session-1', [
      makeAgent({ id: 'agent-1', name: 'Agent1' }),
      makeAgent({ id: 'agent-2', name: 'Agent2' }),
      makeAgent({ id: 'agent-3', name: 'Agent3' }),
    ], sendEvent)

    // executeTaskBatch called twice
    expect(mockExecuteTaskBatch).toHaveBeenCalledTimes(2)
    // First call: only task A
    const firstCallArgs = mockExecuteTaskBatch.mock.calls[0][0]
    expect(firstCallArgs).toHaveLength(1)
    expect(firstCallArgs[0].id).toBe('a')
    // Second call: tasks B and C
    const secondCallArgs = mockExecuteTaskBatch.mock.calls[1][0]
    expect(secondCallArgs).toHaveLength(2)
    const secondIds = secondCallArgs.map((t: any) => t.id).sort()
    expect(secondIds).toEqual(['b', 'c'])
    // session phase → done
    expect(mockSessionUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'done' }) }))
  })

  it('无ready任务时循环立即终止', async () => {
    // Task with unmet dependency → never ready → loop exits immediately
    const task = makeTask({ id: 'blocked-1', dependencies: '["dep-1"]' })
    mockTaskFindMany.mockResolvedValue([task])

    await handleExecution('', 'session-1', [makeAgent({ id: 'agent-1' })], sendEvent)

    // executeTaskBatch should not be called (no ready tasks)
    expect(mockExecuteTaskBatch).not.toHaveBeenCalled()
    // Should still complete (no error about safety limit)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'done',
    }))
  })
})

describe('5. Git diff 越界修改检测', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionFindUnique.mockResolvedValue({ id: 'session-1', projectDir: '/tmp/test', permissionMode: 'default' })
    mockSessionMemberFindMany.mockResolvedValue([{ agent: makeAgent({ id: 'agent-1' }) }])
    mockMessageFindMany.mockResolvedValue([])
  })

  it('有越界修改 → 发送[越界修改]警告', async () => {
    const task = makeTask({ id: 't1', declaredFiles: '["src/schema.prisma"]', dependencies: '[]' })
    mockTaskFindMany.mockResolvedValue([task])
    mockExecuteTaskBatch.mockResolvedValue({ results: new Map([['t1', { result: 'done' }]]), failedTaskIds: [] })
    mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({ needsCorrection: false, quality: 'good' }))
    mockGetChangedFiles.mockReturnValue(['src/schema.prisma', 'src/undeclared.ts'])

    await handleExecution('', 'session-1', [makeAgent({ id: 'agent-1' })], sendEvent)

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'text',
      content: expect.stringContaining('越界修改'),
    }))
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('src/undeclared.ts'),
    }))
  })

  it('无越界修改 → 不发警告', async () => {
    const task = makeTask({ id: 't1', declaredFiles: '["src/schema.prisma"]', dependencies: '[]' })
    mockTaskFindMany.mockResolvedValue([task])
    mockExecuteTaskBatch.mockResolvedValue({ results: new Map([['t1', { result: 'done' }]]), failedTaskIds: [] })
    mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({ needsCorrection: false, quality: 'good' }))
    mockGetChangedFiles.mockReturnValue(['src/schema.prisma'])

    await handleExecution('', 'session-1', [makeAgent({ id: 'agent-1' })], sendEvent)

    // Should report changed files but NOT "越界修改"
    const outOfBoundsCalls = sendEvent.mock.calls.filter(
      (c: any[]) => c[0].content?.includes('越界修改')
    )
    expect(outOfBoundsCalls).toHaveLength(0)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('修改了'),
    }))
  })
})

describe('6. LLM 质量审查 + 纠偏重试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionFindUnique.mockResolvedValue({ id: 'session-1', projectDir: '/tmp/test', permissionMode: 'default' })
    mockSessionMemberFindMany.mockResolvedValue([{ agent: makeAgent({ id: 'agent-1' }) }])
    mockMessageFindMany.mockResolvedValue([])
  })

  it('首次纠偏: correctionCount=0 → 回退到pending, correctionCount=1', async () => {
    const task = makeTask({ id: 't1', correctionCount: 0, dependencies: '[]' })
    mockTaskFindMany.mockResolvedValue([task])

    mockExecuteTaskBatch
      .mockResolvedValue({ results: new Map([['t1', { result: 'done' }]]), failedTaskIds: [] })
    // First call: correction needed. Subsequent calls: pass (to let loop exit)
    mockCallLLMForAnalysis
      .mockResolvedValueOnce(JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理' }))
      .mockResolvedValue(JSON.stringify({ needsCorrection: false, quality: 'good' }))

    await handleExecution('', 'session-1', [makeAgent({ id: 'agent-1' })], sendEvent)

    // Verify correction was triggered
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Orchestrator 纠偏'),
    }))
    // Verify task.update was called to reset to pending with correctionCount=1
    expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'pending', correctionCount: 1 }),
    }))
  })

  it('达到上限: correctionCount=2 → 不再重试', async () => {
    const task = makeTask({ id: 't1', correctionCount: 2, dependencies: '[]' })
    mockTaskFindMany.mockResolvedValue([task])
    mockExecuteTaskBatch.mockResolvedValue({ results: new Map([['t1', { result: 'done' }]]), failedTaskIds: [] })
    mockCallLLMForAnalysis.mockResolvedValue(
      JSON.stringify({ needsCorrection: true, correctionNote: '还是有问题' })
    )

    await handleExecution('', 'session-1', [makeAgent({ id: 'agent-1' })], sendEvent)

    // Should NOT set task back to pending
    const pendingCalls = mockTaskUpdate.mock.calls.filter(
      (c: any[]) => c[1]?.data?.status === 'pending'
    )
    expect(pendingCalls).toHaveLength(0)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('已达上限'),
    }))
  })

  it('审查通过: 任务保持completed', async () => {
    const task = makeTask({ id: 't1', correctionCount: 0, dependencies: '[]' })
    mockTaskFindMany.mockResolvedValue([task])
    mockExecuteTaskBatch.mockResolvedValue({ results: new Map([['t1', { result: 'done' }]]), failedTaskIds: [] })
    mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({ needsCorrection: false, quality: 'good' }))

    await handleExecution('', 'session-1', [makeAgent({ id: 'agent-1' })], sendEvent)

    // Task completed, no correction
    expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed' }),
    }))
    const correctionCalls = sendEvent.mock.calls.filter(
      (c: any[]) => c[0].content?.includes('纠偏')
    )
    expect(correctionCalls).toHaveLength(0)
  })
})

describe('7. blocked 状态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionFindUnique.mockResolvedValue({ id: 'session-1', projectDir: '/tmp/test', permissionMode: 'default' })
    mockSessionMemberFindMany.mockResolvedValue([
      { agent: makeAgent({ id: 'agent-1' }) },
      { agent: makeAgent({ id: 'agent-2' }) },
    ])
    mockMessageFindMany.mockResolvedValue([])
  })

  it('依赖任务失败 → pending任务变为blocked', async () => {
    const taskA = makeTask({ id: 'a', status: 'pending', assignedAgentId: 'agent-1', dependencies: '[]' })
    const taskB = makeTask({ id: 'b', status: 'pending', assignedAgentId: 'agent-2', dependencies: '["a"]' })
    mockTaskFindMany.mockResolvedValue([taskA, taskB])

    // Task A fails
    mockExecuteTaskBatch.mockRejectedValueOnce(new Error('execution failed'))
    mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({ needsCorrection: false, quality: 'good' }))

    await handleExecution('', 'session-1', [
      makeAgent({ id: 'agent-1' }),
      makeAgent({ id: 'agent-2' }),
    ], sendEvent)

    // Task A should be failed
    expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed' }),
    }))
    // Task B should be blocked
    expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'blocked' }),
    }))
    // B should not have been executed
    expect(mockExecuteTaskBatch).toHaveBeenCalledTimes(1) // Only A was attempted
  })
})
