import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockMessageFindMany, mockTaskCount, mockTaskFindMany, mockTaskFindFirst, mockSessionUpdate, mockSessionUpdateMany, mockSessionFindUnique, mockMessageCreate } = vi.hoisted(() => ({
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockTaskCount: vi.fn().mockResolvedValue(0),
  mockTaskFindMany: vi.fn().mockResolvedValue([]),
  mockTaskFindFirst: vi.fn().mockResolvedValue(null),
  mockSessionUpdate: vi.fn(),
  mockSessionUpdateMany: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockMessageCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    message: { findMany: mockMessageFindMany, create: mockMessageCreate },
    task: { count: mockTaskCount, findMany: mockTaskFindMany, findFirst: mockTaskFindFirst },
    session: { update: mockSessionUpdate, updateMany: mockSessionUpdateMany, findUnique: mockSessionFindUnique },
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

const { mockHandlePMConfirm, mockHandleArchitectPlan, mockHandleAgentQA, mockTransitionToExecution, mockIsCodeTask } = vi.hoisted(() => ({
  mockHandlePMConfirm: vi.fn(),
  mockHandleArchitectPlan: vi.fn(),
  mockHandleAgentQA: vi.fn(),
  mockTransitionToExecution: vi.fn(),
  mockIsCodeTask: vi.fn().mockReturnValue(false),
}))

vi.mock('@/lib/services/alignment', () => ({
  handlePMConfirm: mockHandlePMConfirm,
  handleArchitectPlan: mockHandleArchitectPlan,
  handleAgentQA: mockHandleAgentQA,
  transitionToExecution: mockTransitionToExecution,
  isCodeTask: mockIsCodeTask,
}))

import { handleOrchestratorDecision, handleOrchestratorChat, isCreateAgentIntent, parseDeclaredFiles } from '@/lib/services/chat-router'

const sendEvent = vi.fn()
const agents = [
  { id: 'a1', name: 'PM', systemPrompt: '', platform: 'claude-code', expertise: 'product', model: '', baseUrl: '', apiKey: '', tools: '[]' },
  { id: 'a2', name: '架构师', systemPrompt: '', platform: 'claude-code', expertise: 'arch', model: '', baseUrl: '', apiKey: '', tools: '[]' },
]

beforeEach(() => {
  // resetAllMocks: 清空 pending mockResolvedValueOnce 队列（clearAllMocks 不清，跨测试泄漏）
  vi.resetAllMocks()
  mockMessageFindMany.mockResolvedValue([])
  mockTaskCount.mockResolvedValue(0)
  mockTaskFindMany.mockResolvedValue([])
  mockTaskFindFirst.mockResolvedValue(null)
  mockSessionUpdateMany.mockResolvedValue({ count: 1 }) // appendDecisionTrace 乐观锁写：默认成功（生命周期审查整改）
  mockIsCodeTask.mockReturnValue(false)
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
    mockTaskFindMany.mockResolvedValueOnce([{ description: '有任务', declaredFiles: '[]' }]) // 非 idle,有任务即可执行
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockTransitionToExecution).toHaveBeenCalled()
  })

  it('action=execute with 0 tasks → redirect to align_decompose', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'execute', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskFindMany.mockResolvedValueOnce([])
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockHandleArchitectPlan).toHaveBeenCalled()
    expect(mockTransitionToExecution).not.toHaveBeenCalled()
  })

  it('P2 回归守卫 T1: idle + execute + 已有代码任务 → 确定性闸门拦截,redirect align_decompose', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'execute', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    // 旧代码只查 taskCount: count=1 会放行 execute;新代码闸门看 isCodeTask → 拒绝跳步
    mockTaskCount.mockResolvedValueOnce(1) // 保证旧代码(只读 count)下必红
    mockTaskFindMany.mockResolvedValueOnce([{ description: '实现登录', declaredFiles: '["src/login.ts"]' }])
    mockIsCodeTask.mockReturnValueOnce(true)
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, idle)
    expect(mockHandleArchitectPlan).toHaveBeenCalled()
    expect(mockTransitionToExecution).not.toHaveBeenCalled()
  })

  it('P2 闸门放行: idle + execute + 已有任务且全非代码 → 允许简单任务跳步', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'execute', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskFindMany.mockResolvedValueOnce([{ description: '整理文档', declaredFiles: '[]' }])
    mockIsCodeTask.mockReturnValueOnce(false)
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, idle)
    expect(mockTransitionToExecution).toHaveBeenCalled()
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
    mockTaskFindMany.mockResolvedValueOnce([{ description: '有任务', declaredFiles: '[]' }])
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
    mockTaskFindMany.mockResolvedValueOnce([{ description: '有任务', declaredFiles: '[]' }])
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
    // P3 声明vs实现审查 F5: done 守卫的 corrections 内容要有断言（reason 字符串改动会被拦）
    const traceCall = mockSessionUpdateMany.mock.calls.find(c => c[0].data?.decisionTrace)
    expect(JSON.parse(traceCall![0].data.decisionTrace)[0].corrections)
      .toEqual([{ from: 'done', to: 'execute', reason: '还有 1 个未完成任务，继续执行' }])
  })

  it('done 守卫放行: exec 态无未完成任务 -> 直接 done', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'done', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskCount.mockResolvedValueOnce(0) // 无未完成任务
    mockSessionFindUnique.mockResolvedValueOnce({ phase: 'execution', phaseStep: '' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockTransitionToExecution).not.toHaveBeenCalled()
    expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { phase: 'done', phaseStep: '' } })
  })

  it('P2 回归守卫 T2: exec + done + verify 任务 blocked → 不关闭会话,redirect execute', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'done', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskCount.mockResolvedValueOnce(0) // blocked 计入 allDone,unfinished=0
    mockTaskFindFirst.mockResolvedValueOnce({ status: 'blocked' }) // verify 被 blocked
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    // 旧代码: blocked 不在 unfinished → 直接 done;新代码: verify 未 completed → redirect execute
    expect(mockTransitionToExecution).toHaveBeenCalled()
    // P3 起 session.update 会被 decisionTrace 写入调用——只断言"没写 done phase"（trace 写是设计内行为）
    expect(mockSessionUpdate).not.toHaveBeenCalledWith({ where: { id: 's1' }, data: { phase: 'done', phaseStep: '' } })
    // P3 声明vs实现审查 F5: verify-blocked 变体的 corrections 内容断言
    const traceCall = mockSessionUpdateMany.mock.calls.find(c => c[0].data?.decisionTrace)
    expect(JSON.parse(traceCall![0].data.decisionTrace)[0].corrections)
      .toEqual([{ from: 'done', to: 'execute', reason: '验证任务未完成（blocked），继续执行' }])
  })

  it('P2 done-verify 放行: verify 已 completed → 正常 done', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'done', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskCount.mockResolvedValueOnce(0)
    mockTaskFindFirst.mockResolvedValueOnce({ status: 'completed' })
    mockSessionFindUnique.mockResolvedValueOnce({ phase: 'execution', phaseStep: '' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    expect(mockTransitionToExecution).not.toHaveBeenCalled()
    expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { phase: 'done', phaseStep: '' } })
  })

  // ── P3 新增:决策输入 trace 回归守卫（§5.6 六字段,回退 trace 钩子必红）──

  it('P3 回归守卫: 决策点把决策输入写进 decisionTrace（6 字段可还原"为什么"）', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'execute', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskFindMany.mockResolvedValueOnce([{ description: '有任务', declaredFiles: '[]' }])
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, exec)
    // 回退 trace 钩子 → session.updateMany 无 decisionTrace 调用 → 必红
    expect(mockSessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 's1' }),
      data: expect.objectContaining({ decisionTrace: expect.any(String) }),
    }))
    const traceCall = mockSessionUpdateMany.mock.calls.find(c => c[0].data?.decisionTrace)
    const entry = JSON.parse(traceCall![0].data.decisionTrace)[0]
    expect(entry).toMatchObject({
      decisionPoint: 'handleOrchestratorDecision',
      inputState: { phase: 'execution', phaseStep: '', state: 'exec' },
      llmProposal: { action: 'execute', reason: 'r' },
      corrections: [],
      validation: { passed: true, validator: 'applyTransition' },
      actualTransition: { from: 'exec', to: 'exec', action: 'execute', applied: true, escalated: false },
      ts: expect.any(String),
    })
  })

  it('P3 回归守卫: escalate 也写 trace（escalated=true, applied=false）', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'align_qa', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, alignPm)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'awaiting_user_input', content: 'escalate' }))
    const traceCall = mockSessionUpdateMany.mock.calls.find(c => c[0].data?.decisionTrace)
    const entry = JSON.parse(traceCall![0].data.decisionTrace)[0]
    expect(entry.actualTransition).toMatchObject({ from: 'align_pm', to: 'align_pm', action: 'align_qa', applied: false, escalated: true })
    expect(entry.validation).toMatchObject({ passed: false, validator: 'applyTransition' })
  })

  it('P3 回归守卫: Object.prototype 成员名 action（toString）→ escalate 而非静默通过', async () => {
    // 攻击者审查抓出：旧代码 TRANSITIONS[state]?.[action] 属性链查找被 toString 继承属性命中 → 通过校验 → switch 无 case → 消息静默吞掉
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'toString', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, idle)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'awaiting_user_input', content: 'escalate' }))
    expect(mockExecuteSingleAgent).not.toHaveBeenCalled()
    expect(mockDelegateToAgent).not.toHaveBeenCalled()
    expect(mockTransitionToExecution).not.toHaveBeenCalled()
    const traceCall = mockSessionUpdateMany.mock.calls.find(c => c[0].data?.decisionTrace)
    const entry = JSON.parse(traceCall![0].data.decisionTrace)[0]
    expect(entry.actualTransition).toMatchObject({ action: 'toString', escalated: true })
  })

  it('P3 回归守卫: 规范化纠正记进 corrections（被否决的备选）', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'done', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, alignPm)
    // align_pm + done → 规则1 纠正为 align_decompose
    expect(mockHandleArchitectPlan).toHaveBeenCalled()
    const traceCall = mockSessionUpdateMany.mock.calls.find(c => c[0].data?.decisionTrace)
    const entry = JSON.parse(traceCall![0].data.decisionTrace)[0]
    expect(entry.llmProposal).toMatchObject({ action: 'done', reason: 'r' })
    expect(entry.corrections).toEqual([{ from: 'done', to: 'align_decompose', reason: expect.stringContaining('规范化纠正') }])
    expect(entry.actualTransition).toMatchObject({ from: 'align_pm', to: 'align_arch', action: 'align_decompose', applied: true })
  })

  it('P3 回归守卫: idle→execute 闸门拦截记 corrections（execute 被否决）', async () => {
    mockGetOrchestratorDecision.mockResolvedValueOnce({ decision: { action: 'execute', message: '', reason: 'r' }, sessionId: 'orch-ses' })
    mockTaskFindMany.mockResolvedValueOnce([{ description: '实现登录', declaredFiles: '["src/login.ts"]' }])
    mockIsCodeTask.mockReturnValueOnce(true)
    await handleOrchestratorDecision('hello', 's1', agents, sendEvent, idle)
    expect(mockHandleArchitectPlan).toHaveBeenCalled()
    const traceCall = mockSessionUpdateMany.mock.calls.find(c => c[0].data?.decisionTrace)
    const entry = JSON.parse(traceCall![0].data.decisionTrace)[0]
    expect(entry.llmProposal).toMatchObject({ action: 'execute' })
    expect(entry.corrections).toEqual([{ from: 'execute', to: 'align_decompose', reason: '确定性闸门：需先对齐拆解' }])
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

describe('parseDeclaredFiles (P2 安全解析,审查整改)', () => {
  it('畸形 JSON（字符串/数字/非数组）→ 降级为 []，不击穿决策点', () => {
    expect(parseDeclaredFiles('"src/login.ts"')).toEqual([]) // LLM 输出字符串而非数组
    expect(parseDeclaredFiles('123')).toEqual([])
    expect(parseDeclaredFiles('not json')).toEqual([])
    expect(parseDeclaredFiles('')).toEqual([])
    expect(parseDeclaredFiles(null)).toEqual([])
  })

  it('数组内非字符串元素被过滤,合法字符串保留', () => {
    expect(parseDeclaredFiles('["a.ts", 42, null, "b.ts"]')).toEqual(['a.ts', 'b.ts'])
  })

  it('合法数组原样返回', () => {
    expect(parseDeclaredFiles('["src/a.ts", "src/b.ts"]')).toEqual(['src/a.ts', 'src/b.ts'])
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
