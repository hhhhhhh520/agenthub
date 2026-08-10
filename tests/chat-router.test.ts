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
  mockGetOrchestratorAgent: vi.fn().mockReturnValue({ platform: 'claude-code', apiKey: 'sk', model: 'test', baseUrl: '' }),
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

import { handleOrchestratorDecision, handleOrchestratorChat, isCreateAgentIntent } from '@/lib/services/chat-router'

const sendEvent = vi.fn()
const agents = [
  { id: 'a1', name: 'PM', systemPrompt: '', platform: 'claude-code', expertise: 'product', model: '', baseUrl: '', apiKey: '', tools: '[]' },
  { id: 'a2', name: '架构师', systemPrompt: '', platform: 'claude-code', expertise: 'arch', model: '', baseUrl: '', apiKey: '', tools: '[]' },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockMessageFindMany.mockResolvedValue([])
  mockTaskCount.mockResolvedValue(0)
  mockExecuteSingleAgent.mockResolvedValue({ result: 'agent reply' })
  mockGetOrchestratorAgent.mockReturnValue({ platform: 'claude-code', apiKey: 'sk', model: 'test', baseUrl: '' })
})

// validateDecision 已由 state-machine（canonicalCorrect + applyTransition）替代，P1。
// 原 validateDecision 单测意图迁移到 tests/state-machine.test.ts + 下方 handleOrchestratorDecision 集成测试。

describe('handleOrchestratorDecision', () => {
  // 状态机复合态（phase × phaseStep）
  const idle = { phase: 'idle', phaseStep: '' }
  const alignPm = { phase: 'alignment', phaseStep: 'pm_confirm' }
  const alignArch = { phase: 'alignment', phaseStep: 'architect_plan' }
  const exec = { phase: 'execution', phaseStep: '' }
  it('sends "思考中" status first', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'self', message: 'hi', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, idle)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: '思考中...' }))
  })

  it('action=delegate → calls delegateToAgent', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'delegate', target: 'PM', message: 'do it', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, idle)
    expect(mockDelegateToAgent).toHaveBeenCalledWith('PM', 'do it', 's1', agents, sendEvent, undefined, 'orch-ses')
  })

  it('action=discuss → calls runMultiAgentDiscussion', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'discuss', targets: ['PM', '架构师'], message: 'discuss', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, idle)
    expect(mockRunMultiAgentDiscussion).toHaveBeenCalledWith(['PM', '架构师'], 'discuss', 's1', agents, sendEvent)
  })

  it('action=align_confirm → calls handlePMConfirm', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'align_confirm', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, alignPm)
    expect(mockHandlePMConfirm).toHaveBeenCalled()
  })

  it('action=align_decompose → calls handleArchitectPlan', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'align_decompose', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, alignArch)
    expect(mockHandleArchitectPlan).toHaveBeenCalled()
  })

  it('action=align_qa → calls handleAgentQA', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'align_qa', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, alignArch)
    expect(mockHandleAgentQA).toHaveBeenCalled()
  })

  it('action=execute → calls transitionToExecution', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'execute', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskCount.mockResolvedValueOnce(1)
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockTransitionToExecution).toHaveBeenCalled()
  })

  it('action=execute with 0 tasks → redirect to align_decompose', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'execute', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskCount.mockResolvedValueOnce(0)
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockHandleArchitectPlan).toHaveBeenCalled()
    expect(mockTransitionToExecution).not.toHaveBeenCalled()
  })

  it('action=verify with target → calls delegateToAgent（验证不静默丢失）', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'verify', target: '架构师', message: '请验证产出物', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockDelegateToAgent).toHaveBeenCalledWith('架构师', '请验证产出物', 's1', agents, sendEvent, undefined, 'orch-ses')
  })

  it('action=verify without target → Orchestrator 自己验证（走 CLI 执行）', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'verify', target: null, message: '让我验证一下', reason: 'r' }, sessionId: 'orch-ses' })
    mockSessionFindUnique.mockResolvedValueOnce({ projectDir: '/dir' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockDelegateToAgent).not.toHaveBeenCalled()
    expect(mockExecuteSingleAgent).toHaveBeenCalled()
  })

  it('action=done → transitionPhase 写 done 并发送 done 事件', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'done', message: 'all done', reason: 'r' }, sessionId: 'orch-ses' })
    mockSessionFindUnique.mockResolvedValueOnce({ phase: 'idle', phaseStep: '' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, idle)
    // 回归守卫:必须经 transitionPhase(先读 state 再写),回退为裸 prisma.session.update 必红
    expect(mockSessionFindUnique).toHaveBeenCalledWith({ where: { id: 's1' }, select: { phase: true, phaseStep: true } })
    expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { phase: 'done', phaseStep: '' } })
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }))
  })

  it('getOrchestratorDecision throws → falls back to handleOrchestratorChat', async () => {
    mockGetOrchestratorDecision.mockRejectedValueOnce(new Error('LLM down'))
    mockSessionFindUnique.mockResolvedValueOnce({ projectDir: '/dir' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, idle)
    expect(mockExecuteSingleAgent).toHaveBeenCalled()
  })

  // ── P1 新增:状态机转移表集成测试(Hybrid 纠正 + escalate 回归守卫)──

  it('非法转移 → escalate(不静默): align_pm 提议 align_qa(无 history) → 需人工介入', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'align_qa', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, alignPm)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('需人工介入') }))
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'awaiting_user_input', content: 'escalate' }))
    expect(mockHandleAgentQA).not.toHaveBeenCalled()
  })

  it('Hybrid 规则1: align_pm 提议 done → redirect align_decompose(推进架构师,非原地重确认)', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'done', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, alignPm)
    expect(mockHandleArchitectPlan).toHaveBeenCalled()
    expect(mockHandlePMConfirm).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('规范化纠正') }))
  })

  it('Hybrid 规则2: exec 提议 align_confirm → redirect execute(继续执行,不回退对齐)', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'align_confirm', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskCount.mockResolvedValueOnce(1)
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockTransitionToExecution).toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('规范化纠正') }))
  })

  it('Hybrid 规则3: align_arch 提议 align_qa 但 Q&A 已答 → redirect execute', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'align_qa', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockMessageFindMany.mockResolvedValueOnce([
      { role: 'agent', agentId: '前端工程师', rawContent: '用什么框架？' },
      { role: 'user', agentId: null, rawContent: 'React' },
    ])
    mockTaskCount.mockResolvedValueOnce(1)
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, alignArch)
    expect(mockTransitionToExecution).toHaveBeenCalled()
    expect(mockHandleAgentQA).not.toHaveBeenCalled()
  })

  it('done 守卫(§5.1 exec→done 需 allDone): exec 态有未完成任务(含 failed) -> redirect execute 继续执行', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'done', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskCount.mockResolvedValueOnce(1) // done 守卫: 有非 completed/blocked 任务
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    // 守卫必须拦 completed/blocked 之外的全部状态(含 failed),与 execution.ts allDone 语义一致
    expect(mockTaskCount).toHaveBeenCalledWith({ where: { sessionId: 's1', status: { notIn: ['completed', 'blocked'] } } })
    expect(mockTransitionToExecution).toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('未完成') }))
  })

  it('done 守卫放行: exec 态无未完成任务 -> 直接 done', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'done', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskCount.mockResolvedValueOnce(0) // 无未完成任务
    mockSessionFindUnique.mockResolvedValueOnce({ phase: 'execution', phaseStep: '' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockTransitionToExecution).not.toHaveBeenCalled()
    expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { phase: 'done', phaseStep: '' } })
  })
})

describe('isCreateAgentIntent', () => {
  it('显式创建 Agent 意图 → true', () => {
    expect(isCreateAgentIntent('帮我创建一个 Agent，负责代码审查')).toBe(true)
    expect(isCreateAgentIntent('新建一个智能体')).toBe(true)
    expect(isCreateAgentIntent('添加一个助手，专门处理数据清洗')).toBe(true)
    expect(isCreateAgentIntent('请创建一个 code-review agent')).toBe(true)
    expect(isCreateAgentIntent('create an agent for testing')).toBe(true) // 纯英文旧行为保留
  })

  it('普通文件操作 + AgentHub 产品名 → false（本次修复的误判回归守卫）', () => {
    // "Hello AgentHub" 的 Agent 是产品名的一部分，不是独立 agent 关键词
    expect(isCreateAgentIntent('在当前目录创建一个 hello.txt，内容写入 Hello AgentHub')).toBe(false)
    expect(isCreateAgentIntent('创建 helloAgent.txt 文件')).toBe(false)
  })

  it('缺创建动词或缺 agent 关键词 → false', () => {
    expect(isCreateAgentIntent('分析一下这个项目')).toBe(false)
    expect(isCreateAgentIntent('agent 是什么？')).toBe(false) // 有关键词无创建动词
    expect(isCreateAgentIntent('创建目录')).toBe(false) // 有创建动词无关键词
    expect(isCreateAgentIntent('')).toBe(false)
  })
})

describe('handleOrchestratorChat', () => {
  it('calls executeSingleAgent and saves result', async () => {
    mockSessionFindUnique.mockResolvedValueOnce({ projectDir: '/dir' })
    await handleOrchestratorChat('hello', 's1', sendEvent, [{ name: 'PM', expertise: 'product', platform: 'claude-code' }])
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
