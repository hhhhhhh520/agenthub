import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateDecision } from '@/lib/services/chat-router'

// ── Mock for transitionToExecution tests ──
const mocks = vi.hoisted(() => ({
  mockTaskFindMany: vi.fn(),
  mockTaskCreate: vi.fn(),
  mockTaskFindFirst: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockMessageCreate: vi.fn(),
  mockSessionMemberFindMany: vi.fn().mockResolvedValue([]),
  mockExecuteSingleAgent: vi.fn(),
  mockDecomposeTasks: vi.fn(),
  mockCallLLMForAnalysis: vi.fn(),
  mockHandleExecution: vi.fn(),
  mockSendEvent: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: { findMany: mocks.mockTaskFindMany, create: mocks.mockTaskCreate, findFirst: mocks.mockTaskFindFirst },
    session: { update: mocks.mockSessionUpdate, findUnique: mocks.mockSessionFindUnique },
    message: { findMany: mocks.mockMessageFindMany, create: mocks.mockMessageCreate },
    sessionMember: { findMany: mocks.mockSessionMemberFindMany },
  },
}))

vi.mock('@/lib/orchestrator', () => ({
  executeSingleAgent: mocks.mockExecuteSingleAgent,
  decomposeTasks: mocks.mockDecomposeTasks,
  callLLMForAnalysis: mocks.mockCallLLMForAnalysis,
  parseJSON: vi.fn(),
  formatArchitectPlan: vi.fn().mockReturnValue('plan summary'),
  generateRoles: vi.fn(),
  analyzeScene: vi.fn(),
}))

vi.mock('@/lib/services/execution', () => ({
  handleExecution: mocks.mockHandleExecution,
}))

import { transitionToExecution, handleArchitectPlan, isCodeTask, buildVerifyDescription } from '@/lib/services/alignment'

function dec(action: string, overrides?: Partial<{ target: string | null; targets: string[] | null; message: string; reason: string }>) {
  return { action, message: '', reason: '', ...overrides }
}

describe('validateDecision — phase guards', () => {
  it('blocks done during alignment phase', () => {
    const result = validateDecision(dec('done'), 'alignment', [])
    expect(result.action).toBe('align_confirm')
    expect(result.reason).toContain('对齐')
  })

  it('allows done during execution phase', () => {
    const result = validateDecision(dec('done'), 'execution', [])
    expect(result.action).toBe('done')
  })

  it('blocks align_confirm during execution phase', () => {
    const result = validateDecision(dec('align_confirm'), 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('blocks align_decompose during execution phase', () => {
    const result = validateDecision(dec('align_decompose'), 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('blocks align_qa during execution phase', () => {
    const result = validateDecision(dec('align_qa'), 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('allows align_* during alignment phase', () => {
    expect(validateDecision(dec('align_confirm'), 'alignment', []).action).toBe('align_confirm')
    expect(validateDecision(dec('align_decompose'), 'alignment', []).action).toBe('align_decompose')
    expect(validateDecision(dec('align_qa'), 'alignment', []).action).toBe('align_qa')
  })

  it('does not interfere during idle phase', () => {
    const result = validateDecision(dec('align_confirm'), 'idle', [])
    expect(result.action).toBe('align_confirm')
  })

  it('does not interfere during other phases', () => {
    const result = validateDecision(dec('done'), 'planning', [])
    expect(result.action).toBe('done')
  })
})

describe('validateDecision — Q&A loop detection', () => {
  it('forces execute when agent asked and user answered', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '产品经理', rawContent: '确认需求...' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用 React 还是 Vue？' },
      { role: 'user', agentId: null, rawContent: '用 React' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('execute')
    expect(result.reason).toContain('Q&A已完成')
  })

  it('allows align_qa when no agent questions yet', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '架构师', rawContent: '方案...' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('allows align_qa when agent asked but user has not answered', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用 React 还是 Vue？' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('allows align_qa when only PM/architect messages exist', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '产品经理', rawContent: '需求确认...' },
      { role: 'agent', agentId: '架构师', rawContent: '技术方案...' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('align_qa')
  })

  it('forces execute when multiple agent Q&A rounds completed', () => {
    const history = [
      { role: 'user', agentId: null, rawContent: '搭建博客' },
      { role: 'agent', agentId: '前端工程师', rawContent: '用什么框架？' },
      { role: 'user', agentId: null, rawContent: 'React' },
      { role: 'agent', agentId: '后端工程师', rawContent: '用什么数据库？' },
      { role: 'user', agentId: null, rawContent: 'PostgreSQL' },
    ]
    const result = validateDecision(dec('align_qa'), 'alignment', history)
    expect(result.action).toBe('execute')
  })
})

describe('validateDecision — passthrough', () => {
  it('preserves self action', () => {
    const result = validateDecision(dec('self', { message: '好的' }), 'alignment', [])
    expect(result.action).toBe('self')
  })

  it('preserves delegate action', () => {
    const result = validateDecision(dec('delegate'), 'alignment', [])
    expect(result.action).toBe('delegate')
  })

  it('preserves discuss action', () => {
    const result = validateDecision(dec('discuss'), 'alignment', [])
    expect(result.action).toBe('discuss')
  })

  it('preserves execute action during execution', () => {
    const result = validateDecision(dec('execute'), 'execution', [])
    expect(result.action).toBe('execute')
  })

  it('preserves message and reason fields', () => {
    const d = dec('self', { message: 'hello', reason: 'chat' })
    const result = validateDecision(d, 'idle', [])
    expect(result.message).toBe('hello')
    expect(result.reason).toBe('chat')
  })

  it('preserves target and targets fields', () => {
    const d = dec('delegate', { target: 'frontend', targets: ['frontend', 'backend'] })
    const result = validateDecision(d, 'execution', [])
    expect(result.target).toBe('frontend')
    expect(result.targets).toEqual(['frontend', 'backend'])
  })
})

// ── transitionToExecution tests ──
describe('transitionToExecution — task-empty fallback', () => {
  const agents = [
    { id: 'a1', name: '前端工程师', systemPrompt: '', platform: 'claude-code', expertise: '前端', model: '', baseUrl: '', apiKey: '', tools: '' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockSessionFindUnique.mockResolvedValue({ projectDir: '', permissionMode: 'default' })
    mocks.mockHandleExecution.mockResolvedValue(undefined)
    // handleArchitectPlan 内部需要的 mock
    mocks.mockMessageFindMany.mockResolvedValue([])
    mocks.mockMessageCreate.mockResolvedValue({})
    mocks.mockSessionMemberFindMany.mockResolvedValue([])
  })

  it('sends auto-decompose status when Task table is empty', async () => {
    // transitionToExecution 的 findMany 返回空 → 触发兜底
    // handleArchitectPlan 内部也会调 findMany
    mocks.mockTaskFindMany.mockResolvedValue([])
    mocks.mockDecomposeTasks.mockResolvedValue([
      { id: 'uuid-1', description: 'task1', assignedAgent: '前端工程师', dependencies: [], declaredFiles: [], batch: 0 },
    ])
    mocks.mockTaskCreate.mockResolvedValue({})

    await transitionToExecution('sess1', agents, mocks.mockSendEvent, '做个网站')

    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'status', content: '任务列表为空，正在自动拆解...' })
    )
    expect(mocks.mockHandleExecution).toHaveBeenCalled()
  })

  it('skips auto-decompose when tasks already exist', async () => {
    mocks.mockTaskFindMany.mockResolvedValueOnce([{ id: 't1', description: 'task1' }])

    await transitionToExecution('sess1', agents, mocks.mockSendEvent, '做个网站')

    // 不应发送"任务列表为空"状态
    const statusCalls = mocks.mockSendEvent.mock.calls.filter(
      (c: any[]) => c[0]?.content === '任务列表为空，正在自动拆解...'
    )
    expect(statusCalls).toHaveLength(0)
    expect(mocks.mockHandleExecution).toHaveBeenCalled()
  })

  it('always transitions to execution phase', async () => {
    mocks.mockTaskFindMany.mockResolvedValue([{ id: 't1' }])

    await transitionToExecution('sess1', agents, mocks.mockSendEvent, '做个网站')

    expect(mocks.mockSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { phase: 'execution', phaseStep: '' } })
    )
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'phase_transition', content: 'execution' })
    )
  })
})

// ── ISSUE-008: 执行层强制 verify(自动创建验证任务) ──
// handleArchitectPlan 无架构师 Agent 时走 else 分支直接调 decomposeTasks(mocked),
// 不触碰 executeSingleAgent / sessionMember,是测试 verify 创建最干净的路径。
describe('ISSUE-008 — 自动创建验证任务', () => {
  const agents = [
    { id: 'a1', name: '前端工程师', systemPrompt: '', platform: 'claude-code', expertise: '前端', model: '', baseUrl: '', apiKey: '', tools: '' },
    { id: 'a3', name: '测试工程师', systemPrompt: '', platform: 'claude-code', expertise: '测试', model: '', baseUrl: '', apiKey: '', tools: '' },
  ]
  const codeTask = { id: 'code-1', description: '实现登录接口', assignedAgent: '后端工程师', dependencies: [], declaredFiles: ['src/api/login.ts'], outputSchema: undefined, batch: 0 }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockMessageFindMany.mockResolvedValue([])
    mocks.mockTaskCreate.mockResolvedValue({})
    mocks.mockTaskFindFirst.mockResolvedValue(null)
  })

  it('代码任务拆解 → 自动创建 verify 任务(依赖代码任务/declaredFiles 空/分配给测试工程师)', async () => {
    mocks.mockDecomposeTasks.mockResolvedValue([codeTask])

    await handleArchitectPlan('做个网站', 'sess1', agents, mocks.mockSendEvent)

    const verifyCall = mocks.mockTaskCreate.mock.calls.find(([arg]) => String(arg.data.id).startsWith('verify-'))
    expect(verifyCall).toBeDefined()
    const data = verifyCall![0].data
    expect(data.id).toMatch(/^verify-/)
    expect(data.description).toContain('实现登录接口')
    expect(data.description).toContain('src/api/login.ts')
    expect(data.dependencies).toBe(JSON.stringify(['code-1']))
    expect(data.declaredFiles).toBe('[]')
    expect(data.assignedAgentId).toBe('a3')
    expect(data.status).toBe('pending')
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('已自动创建验证任务') })
    )
  })

  it('无代码任务 → 不创建 verify', async () => {
    mocks.mockDecomposeTasks.mockResolvedValue([
      { id: 'doc-1', description: '编写 README', assignedAgent: '产品经理', dependencies: [], declaredFiles: ['README.md'], outputSchema: undefined, batch: 0 },
    ])

    await handleArchitectPlan('写文档', 'sess1', agents, mocks.mockSendEvent)

    const verifyCalls = mocks.mockTaskCreate.mock.calls.filter(([arg]) => String(arg.data.id).startsWith('verify-'))
    expect(verifyCalls).toHaveLength(0)
  })

  it('已存在 verify 任务 → 不重复创建', async () => {
    mocks.mockDecomposeTasks.mockResolvedValue([codeTask])
    mocks.mockTaskFindFirst.mockResolvedValue({ id: 'verify-existing' })

    await handleArchitectPlan('做个网站', 'sess1', agents, mocks.mockSendEvent)

    const verifyCalls = mocks.mockTaskCreate.mock.calls.filter(([arg]) => String(arg.data.id).startsWith('verify-'))
    expect(verifyCalls).toHaveLength(0)
  })

  it('无测试工程师时 assignedAgentId 为 null(executeTaskBatch 兜底匹配)', async () => {
    const noTestAgents = agents.filter(a => a.name !== '测试工程师')
    mocks.mockDecomposeTasks.mockResolvedValue([codeTask])

    await handleArchitectPlan('做个网站', 'sess1', noTestAgents, mocks.mockSendEvent)

    const verifyCall = mocks.mockTaskCreate.mock.calls.find(([arg]) => String(arg.data.id).startsWith('verify-'))
    expect(verifyCall).toBeDefined()
    expect(verifyCall![0].data.assignedAgentId).toBeNull()
  })
})

describe('ISSUE-008 — isCodeTask / buildVerifyDescription', () => {
  it('isCodeTask: declaredFiles 含代码后缀 → true', () => {
    expect(isCodeTask({ description: '实现页面', declaredFiles: ['src/app/page.tsx'] })).toBe(true)
    expect(isCodeTask({ description: '写脚本', declaredFiles: ['main.py'] })).toBe(true)
  })

  it('isCodeTask: 前端静态页/数据库类后缀也识别(审查整改补全 html/vue/sql 等)', () => {
    expect(isCodeTask({ description: '实现首页', declaredFiles: ['index.html'] })).toBe(true)
    expect(isCodeTask({ description: '写组件', declaredFiles: ['App.vue'] })).toBe(true)
    expect(isCodeTask({ description: '建表', declaredFiles: ['schema.sql'] })).toBe(true)
    expect(isCodeTask({ description: '样式', declaredFiles: ['style.css'] })).toBe(true)
  })

  it('isCodeTask: description 提到代码文件后缀 → true', () => {
    expect(isCodeTask({ description: '产出 snake_game.py', declaredFiles: [] })).toBe(true)
  })

  it('isCodeTask: 纯文档/讨论任务 → false', () => {
    expect(isCodeTask({ description: '编写 README 文档', declaredFiles: ['README.md'] })).toBe(false)
    expect(isCodeTask({ description: '需求分析', declaredFiles: [] })).toBe(false)
  })

  it('buildVerifyDescription: 列出代码任务及产出文件', () => {
    const desc = buildVerifyDescription([
      { description: '实现登录接口', declaredFiles: ['src/api/login.ts'] },
      { description: '写测试', declaredFiles: [] },
    ])
    expect(desc).toContain('实现登录接口')
    expect(desc).toContain('src/api/login.ts')
    expect(desc).toContain('写测试')
    expect(desc).toContain('验证通过')
  })
})
