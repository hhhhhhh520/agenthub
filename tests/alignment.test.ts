import { describe, it, expect, vi, beforeEach } from 'vitest'
import { canonicalCorrect, applyTransition, stateFromSession } from '@/lib/orchestrator/state-machine'

// ── Mock for transitionToExecution tests ──
const mocks = vi.hoisted(() => ({
  mockTaskFindMany: vi.fn(),
  mockTaskCreate: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskFindFirst: vi.fn(),
  mockTaskCount: vi.fn().mockResolvedValue(1),
  mockTransaction: vi.fn(),
  mockTxTaskCreates: [] as string[],
  mockSessionUpdate: vi.fn(),
  mockSessionUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  mockSessionFindUnique: vi.fn(),
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockMessageCreate: vi.fn(),
  mockSessionMemberFindMany: vi.fn().mockResolvedValue([]),
  mockSessionMemberFindUnique: vi.fn().mockResolvedValue(null),
  mockExecuteSingleAgent: vi.fn(),
  mockDecomposeTasks: vi.fn(),
  mockCallLLMForAnalysis: vi.fn(),
  mockHandleExecution: vi.fn(),
  mockSendEvent: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: { findMany: mocks.mockTaskFindMany, create: mocks.mockTaskCreate, findFirst: mocks.mockTaskFindFirst, update: mocks.mockTaskUpdate, count: mocks.mockTaskCount },
    $transaction: mocks.mockTransaction,
    session: { update: mocks.mockSessionUpdate, updateMany: mocks.mockSessionUpdateMany, findUnique: mocks.mockSessionFindUnique },
    message: { findMany: mocks.mockMessageFindMany, create: mocks.mockMessageCreate },
    sessionMember: { findMany: mocks.mockSessionMemberFindMany, findUnique: mocks.mockSessionMemberFindUnique },
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

import { transitionToExecution, handleArchitectPlan, ensureExecutableState, isCodeTask, buildVerifyDescription, countConsecutiveReplans, buildPlanId, isExplicitPlanApproval, recordPlanApproval } from '@/lib/services/alignment'
import { TimeoutError } from '@/lib/orchestrator/timeout'
import { requestSessionCancel, clearSessionCancel } from '@/lib/cancellation'

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

// 交互式事务 mock：把 tx.task.* 映射到同一组 task mock，既有断言无需改。
mocks.mockTransaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => fn({
  task: {
    create: (arg: any) => {
      mocks.mockTxTaskCreates.push(arg.data.id)
      return mocks.mockTaskCreate(arg)
    },
    findFirst: mocks.mockTaskFindFirst,
    update: mocks.mockTaskUpdate,
    findMany: mocks.mockTaskFindMany,
  },
}))

beforeEach(() => {
  mocks.mockTxTaskCreates.length = 0
})

describe('state-machine: phase guards（原 validateDecision，P1 迁移）', () => {
  it('对齐中提议 done 被纠正（align_pm->align_decompose / arch|qa->execute）', () => {
    expect(canonicalCorrect('align_pm', 'done')).toEqual({ redirect: 'align_decompose' })
    expect(canonicalCorrect('align_arch', 'done')).toEqual({ redirect: 'execute' })
    expect(canonicalCorrect('align_qa', 'done')).toEqual({ redirect: 'execute' })
  })

  it('执行中允许 done（全完成收尾）', () => {
    expect(applyTransition('exec', 'done')).toEqual({ ok: true, nextState: 'done' })
  })

  it('执行中提议 align_* 被纠正为 execute', () => {
    expect(canonicalCorrect('exec', 'align_confirm')).toEqual({ redirect: 'execute' })
    expect(canonicalCorrect('exec', 'align_decompose')).toEqual({ redirect: 'execute' })
    expect(canonicalCorrect('exec', 'align_qa')).toEqual({ redirect: 'execute' })
  })

  it('对齐中 align_* 均合法（各自子态）', () => {
    expect(applyTransition('align_pm', 'align_confirm')).toEqual({ ok: true, nextState: 'align_pm' })
    expect(applyTransition('align_arch', 'align_decompose')).toEqual({ ok: true, nextState: 'align_arch' })
    expect(applyTransition('align_arch', 'align_qa')).toEqual({ ok: true, nextState: 'align_qa' })
  })

  it('idle 阶段合法转移不受影响', () => {
    expect(applyTransition('idle', 'align_confirm')).toEqual({ ok: true, nextState: 'align_pm' })
    expect(applyTransition('idle', 'done')).toEqual({ ok: true, nextState: 'done' })
  })

  it('未知 phase 兜底为 idle', () => {
    expect(stateFromSession('chat', '')).toBe('idle')
    expect(stateFromSession('planning', '')).toBe('idle')
  })
})

describe('state-machine: Q&A loop detection（原 validateDecision，P1 迁移）', () => {
  const h = (...msgs: Array<{ role: string; agentId?: string | null }>) =>
    msgs.map(m => ({ ...m, rawContent: 'x' }))

  it('Agent 提问且用户已回答 -> 纠正为 execute', () => {
    const history = h({ role: 'agent', agentId: '前端工程师' }, { role: 'user' })
    expect(canonicalCorrect('align_qa', 'align_qa', history)).toEqual({ redirect: 'execute' })
  })

  it('无 Agent 提问 -> 不纠正', () => {
    const history = h({ role: 'user' }, { role: 'agent', agentId: '架构师' })
    expect(canonicalCorrect('align_qa', 'align_qa', history)).toBeNull()
  })

  it('Agent 提问但用户未答 -> 不纠正', () => {
    const history = h({ role: 'user' }, { role: 'agent', agentId: '前端工程师' })
    expect(canonicalCorrect('align_qa', 'align_qa', history)).toBeNull()
  })

  it('仅 PM/架构师消息 -> 不纠正（排除 PM/架构师）', () => {
    const history = h({ role: 'user' }, { role: 'agent', agentId: '产品经理' }, { role: 'agent', agentId: '架构师' })
    expect(canonicalCorrect('align_qa', 'align_qa', history)).toBeNull()
  })

  it('多轮 Q&A 均完成 -> 纠正为 execute', () => {
    const history = h(
      { role: 'agent', agentId: '前端工程师' },
      { role: 'user' },
      { role: 'agent', agentId: '后端工程师' },
      { role: 'user' },
    )
    expect(canonicalCorrect('align_qa', 'align_qa', history)).toEqual({ redirect: 'execute' })
  })
})

describe('state-machine: passthrough（原 validateDecision，P1 迁移）', () => {
  it('旁路 action(self/delegate/discuss) 合法于任何状态，不转 phase', () => {
    for (const s of ['idle', 'align_pm', 'align_arch', 'align_qa', 'exec', 'done'] as const) {
      const r = applyTransition(s, 'self')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.nextState).toBe(s)
    }
    expect(applyTransition('align_pm', 'delegate')).toEqual({ ok: true, nextState: 'align_pm' })
    expect(applyTransition('align_pm', 'discuss')).toEqual({ ok: true, nextState: 'align_pm' })
  })

  it('执行中 execute 是自环（no-op）', () => {
    expect(applyTransition('exec', 'execute')).toEqual({ ok: true, nextState: 'exec' })
  })

  it('对齐中 align_pm + execute 非法（未拆解不可执行）', () => {
    expect(applyTransition('align_pm', 'execute').ok).toBe(false)
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
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'idle', phaseStep: '', projectDir: '', permissionMode: 'default' })
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

    // §3.2: transitionPhase 走 session.updateMany 快照条件写
    expect(mocks.mockSessionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { phase: 'execution', phaseStep: '' } })
    )
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'phase_transition', content: 'execution' })
    )
  })

  it('P2 回归守卫 T5: 补拆 0 任务 → 中止,不进 execute/handleExecution', async () => {
    mocks.mockTaskFindMany.mockResolvedValue([]) // 无任务 → 触发兜底补拆
    mocks.mockDecomposeTasks.mockResolvedValue([]) // 补拆也 0 任务
    mocks.mockTaskCreate.mockResolvedValue({})

    await transitionToExecution('sess1', agents, mocks.mockSendEvent, '做个复杂需求')

    // 不进 execute(phase 不写 execution),不调 handleExecution
    // 旧代码: 补拆 0 任务后仍 transitionPhase('execute') + handleExecution → 红
    expect(mocks.mockSessionUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { phase: 'execution', phaseStep: '' } })
    )
    expect(mocks.mockHandleExecution).not.toHaveBeenCalled()
  })

  it('P2 回归守卫 T5: handleArchitectPlan 拆解 0 任务 → 返回 false,phase 不空转,等用户重述', async () => {
    mocks.mockMessageFindMany.mockResolvedValue([])
    mocks.mockDecomposeTasks.mockResolvedValue([])

    const result = await handleArchitectPlan('做个复杂需求', 'sess1', agents, mocks.mockSendEvent)

    expect(result).toBe(false)
    // phase 不空转 align_arch(旧代码顶部先 transitionPhase('align_decompose') → 红)
    expect(mocks.mockSessionUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { phase: 'alignment', phaseStep: 'architect_plan' } })
    )
    // 等用户重述
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'awaiting_user_input' })
    )
  })

  it('P2 待办④: [REPLAN] 标记后重述流进拆解(用最新 user 消息,不冻结首条)', async () => {
    mocks.mockMessageFindMany.mockResolvedValue([
      { role: 'user', rawContent: '做个网站' },
      { role: 'orchestrator', rawContent: '[REPLAN]未能生成有效任务方案，请重新描述需求或手动指定任务' },
      { role: 'user', rawContent: '做个带登录的网站' },
    ])
    mocks.mockDecomposeTasks.mockResolvedValue([
      { id: 'uuid-1', description: 'task1', assignedAgent: '前端工程师', dependencies: [], declaredFiles: [], batch: 0 },
    ])
    mocks.mockTaskCreate.mockResolvedValue({})

    await handleArchitectPlan('做个带登录的网站', 'sess1', agents, mocks.mockSendEvent)

    // decomposeTasks 收到的应是最新重述而非冻结首条(旧代码: 首条 '做个网站' 不含 '带登录' → 红)
    const [req] = mocks.mockDecomposeTasks.mock.calls[0]
    expect(String(req)).toContain('带登录')
  })
})

// ── 执行恢复边界：任务已存在但 phase 未推进 ──
describe('ensureExecutableState / transitionToExecution recovery', () => {
  const agents = [
    { id: 'a1', name: '前端工程师', systemPrompt: '', platform: 'claude-code', expertise: '前端', model: '', baseUrl: '', apiKey: '', tools: '' },
  ]

  const setupState = (phase: string, step: string) => {
    let currentPhase = phase
    let currentStep = step
    mocks.mockSessionFindUnique.mockImplementation(async () => ({
      phase: currentPhase,
      phaseStep: currentStep,
      decisionTrace: '[]',
      projectDir: '',
      permissionMode: 'default',
    }))
    mocks.mockSessionUpdateMany.mockImplementation(async (arg: any) => {
      if (arg?.data && Object.hasOwn(arg.data, 'phase')) {
        currentPhase = arg.data.phase
        currentStep = arg.data.phaseStep ?? ''
      }
      return { count: 1 }
    })
  }

  const planMessages = (taskIds: string[] = ['t1']) => [
    { role: 'user', rawContent: '做个网站' },
    {
      role: 'agent',
      agentId: '架构师',
      rawContent: `plan summary\n\n> 计划编号：plan-${buildPlanId(taskIds)}`,
    },
    { role: 'user', rawContent: '确认执行' },
    { role: 'system', rawContent: `[PLAN_APPROVED]plan-${buildPlanId(taskIds)}` },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'idle', phaseStep: '', projectDir: '', permissionMode: 'default' })
    mocks.mockTaskFindMany.mockResolvedValue([{
      id: 't1',
      description: 'task1',
      assignedAgentId: 'a1',
      dependencies: '[]',
      declaredFiles: '[]',
      outputSchema: null,
    }])
    mocks.mockTaskCount.mockResolvedValue(1)
    mocks.mockMessageFindMany.mockResolvedValue(planMessages())
    mocks.mockMessageCreate.mockResolvedValue({})
    mocks.mockHandleExecution.mockResolvedValue(undefined)
    mocks.mockSendEvent.mockResolvedValue(undefined)
  })

  it('align_pm + 已有任务：沿 align_decompose → execute 恢复，不重新拆解/不建任务', async () => {
    setupState('alignment', 'pm_confirm')

    await transitionToExecution('sess1', agents, mocks.mockSendEvent, '继续执行')

    const phaseWrites = mocks.mockSessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))
    expect(phaseWrites).toEqual([
      { phase: 'alignment', phaseStep: 'architect_plan' },
      { phase: 'execution', phaseStep: '' },
    ])
    expect(mocks.mockDecomposeTasks).not.toHaveBeenCalled()
    expect(mocks.mockTaskCreate).not.toHaveBeenCalled()
    expect(mocks.mockHandleExecution).toHaveBeenCalledTimes(1)
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'phase_transition', content: 'execution' })
    )
  })

  it.each([
    ['alignment', 'architect_plan'],
    ['alignment', 'agent_qa'],
  ])('align_arch/align_qa (%s/%s) + 已有任务：一条 execute 边恢复', async (phase, step) => {
    setupState(phase, step)

    const result = await ensureExecutableState('sess1')

    expect(result).toEqual({ ok: true, atExec: true })
    const phaseWrites = mocks.mockSessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))
    expect(phaseWrites).toEqual([{ phase: 'execution', phaseStep: '' }])
  })

  it('exec：no-op，不写 phase', async () => {
    setupState('execution', '')

    const result = await ensureExecutableState('sess1')

    expect(result).toEqual({ ok: true, atExec: true })
    const phaseWrites = mocks.mockSessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))
    expect(phaseWrites).toHaveLength(0)
  })

  it('P2-04: align_pm + 有任务但计划未呈现：拒绝恢复，不写 phase', async () => {
    setupState('alignment', 'pm_confirm')
    mocks.mockMessageFindMany.mockResolvedValue([{ role: 'user', rawContent: '做个网站' }])

    const result = await ensureExecutableState('sess1')

    expect(result).toMatchObject({ ok: false, needsPlan: true })
    expect(result).not.toMatchObject({ ok: true })
    const phaseWrites = mocks.mockSessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))
    expect(phaseWrites).toHaveLength(0)
  })

  it('P2-04: align_arch + 计划已呈现但没有用户确认：拒绝执行', async () => {
    setupState('alignment', 'architect_plan')
    mocks.mockMessageFindMany.mockResolvedValue(planMessages().slice(0, 2))

    const result = await ensureExecutableState('sess1')

    expect(result).toMatchObject({ ok: false, needsPlan: true })
    const phaseWrites = mocks.mockSessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))
    expect(phaseWrites).toHaveLength(0)
  })

  it('F2: 计划后有普通用户消息但没有结构化批准：拒绝执行', async () => {
    setupState('alignment', 'architect_plan')
    mocks.mockMessageFindMany.mockResolvedValue([
      ...planMessages().slice(0, 2),
      { role: 'user', rawContent: '我看看再说' },
    ])

    const result = await ensureExecutableState('sess1')

    expect(result).toMatchObject({ ok: false, needsPlan: true })
    expect(mocks.mockSessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))).toHaveLength(0)
  })

  it('F2: 明确拒绝文本即使包含“执行”也不能当作批准', async () => {
    expect(isExplicitPlanApproval('确认执行')).toBe(true)
    expect(isExplicitPlanApproval('执行！')).toBe(true)
    expect(isExplicitPlanApproval('不同意，先不要执行，我要修改方案')).toBe(false)
    expect(isExplicitPlanApproval('修改方案后再执行')).toBe(false)
    expect(isExplicitPlanApproval('继续')).toBe(false)
  })

  it('F2: 旧批准之后又有拒绝消息：旧批准失效', async () => {
    setupState('alignment', 'architect_plan')
    mocks.mockMessageFindMany.mockResolvedValue([
      ...planMessages(),
      { role: 'user', rawContent: '不同意，先不要执行' },
    ])

    const result = await ensureExecutableState('sess1')

    expect(result).toMatchObject({ ok: false, needsPlan: true })
    expect(mocks.mockHandleExecution).not.toHaveBeenCalled()
  })

  it('R2: ensure 等待期间取消，needsPlan 分支不再重呈计划', async () => {
    setupState('alignment', 'pm_confirm')
    const gate = deferred<void>()
    mocks.mockMessageFindMany.mockImplementation(async () => {
      await gate.promise
      return [{ role: 'user', rawContent: '做个网站' }]
    })
    try {
      const pending = transitionToExecution('sess1', agents, mocks.mockSendEvent, '继续执行')
      await waitUntil(() => mocks.mockMessageFindMany.mock.calls.length > 0)
      requestSessionCancel('sess1')
      gate.resolve()
      await pending

      expect(mocks.mockMessageCreate).not.toHaveBeenCalled()
      expect(mocks.mockSessionUpdateMany.mock.calls
        .map(c => c[0]?.data)
        .filter(d => d && Object.hasOwn(d, 'phase'))).toHaveLength(0)
      expect(mocks.mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'done', content: '执行已停止' }),
      )
    } finally {
      clearSessionCancel('sess1')
    }
  })

  it('F2: recordPlanApproval 只为明确批准写入绑定 plan ID 的记录', async () => {
    mocks.mockTaskFindMany.mockResolvedValue([{ id: 't1' }])
    mocks.mockMessageFindMany.mockResolvedValue(planMessages().slice(0, 2))
    mocks.mockMessageCreate.mockResolvedValue({})

    await expect(recordPlanApproval('sess1', '不同意，先不要执行')).resolves.toBe(false)
    expect(mocks.mockMessageCreate).not.toHaveBeenCalled()

    await expect(recordPlanApproval('sess1', '确认执行')).resolves.toBe(true)
    expect(mocks.mockMessageCreate).toHaveBeenCalledWith({
      data: {
        role: 'system',
        rawContent: `[PLAN_APPROVED]plan-${buildPlanId(['t1'])}`,
        sessionId: 'sess1',
      },
    })
  })

  it('P2-04: 计划 ID 与当前任务集不匹配：拒绝执行', async () => {
    setupState('alignment', 'architect_plan')
    mocks.mockMessageFindMany.mockResolvedValue(planMessages(['other-task']))

    const result = await ensureExecutableState('sess1')

    expect(result).toMatchObject({ ok: false, needsPlan: true })
    const phaseWrites = mocks.mockSessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))
    expect(phaseWrites).toHaveLength(0)
  })

  it('P2-04: handleArchitectPlan 写入的计划消息编码当前任务集 ID', async () => {
    setupState('alignment', 'pm_confirm')
    mocks.mockMessageFindMany.mockResolvedValue([{ role: 'user', rawContent: '做个网站' }])
    mocks.mockTaskFindMany.mockResolvedValue([{ id: 'task-a' }, { id: 'task-b' }])
    mocks.mockDecomposeTasks.mockResolvedValue([
      { id: 'task-a', description: '任务 A', assignedAgent: '前端工程师', dependencies: [], declaredFiles: [], batch: 0 },
      { id: 'task-b', description: '任务 B', assignedAgent: '前端工程师', dependencies: [], declaredFiles: [], batch: 0 },
    ])
    mocks.mockTaskCreate.mockResolvedValue({})

    const result = await handleArchitectPlan('做个网站', 'sess1', agents, mocks.mockSendEvent)

    expect(result).toBe(true)
    const planMessage = mocks.mockMessageCreate.mock.calls
      .map(c => c[0]?.data)
      .find(d => d?.agentId === '架构师' && typeof d?.rawContent === 'string')
    expect(planMessage?.rawContent).toContain(`plan-${buildPlanId(['task-a', 'task-b'])}`)
  })

  it('F6: 旧任务与新任务的展示集、plan ID 一致', async () => {
    setupState('alignment', 'pm_confirm')
    mocks.mockMessageFindMany.mockResolvedValue([{ role: 'user', rawContent: '做个网站' }])
    mocks.mockTaskFindMany.mockResolvedValue([
      { id: 'old-task', description: '旧任务', assignedAgentId: 'a1', dependencies: '[]', declaredFiles: '[]', outputSchema: null },
      { id: 'task-a', description: '任务 A', assignedAgentId: 'a1', dependencies: '[]', declaredFiles: '[]', outputSchema: null },
      { id: 'task-b', description: '任务 B', assignedAgentId: 'a1', dependencies: '[]', declaredFiles: '[]', outputSchema: null },
    ])
    mocks.mockDecomposeTasks.mockResolvedValue([
      { id: 'task-a', description: '任务 A', assignedAgent: '前端工程师', dependencies: [], declaredFiles: [], batch: 0 },
      { id: 'task-b', description: '任务 B', assignedAgent: '前端工程师', dependencies: [], declaredFiles: [], batch: 0 },
    ])
    mocks.mockTaskCreate.mockResolvedValue({})
    const { formatArchitectPlan } = await import('@/lib/orchestrator')
    const formatMock = vi.mocked(formatArchitectPlan)
    formatMock.mockClear()

    const result = await handleArchitectPlan('做个网站', 'sess1', agents, mocks.mockSendEvent)

    expect(result).toBe(true)
    const planMessage = mocks.mockMessageCreate.mock.calls
      .map(c => c[0]?.data)
      .find(d => d?.agentId === '架构师' && typeof d?.rawContent === 'string')
    expect(planMessage?.rawContent).toContain(`plan-${buildPlanId(['old-task', 'task-a', 'task-b'])}`)
    expect(formatMock).toHaveBeenCalledTimes(1)
    const displayed = formatMock.mock.calls[0][0] as Array<{ id: string }>
    expect(displayed.map(t => t.id).sort()).toEqual(['old-task', 'task-a', 'task-b'])
  })

  it('P2-04: 计划已呈现但无用户确认：不重复建计划，等待确认且不执行', async () => {
    setupState('alignment', 'architect_plan')
    mocks.mockMessageFindMany.mockResolvedValue(planMessages().slice(0, 2))

    await transitionToExecution('sess1', agents, mocks.mockSendEvent, '继续执行')

    expect(mocks.mockHandleExecution).not.toHaveBeenCalled()
    expect(mocks.mockMessageCreate).not.toHaveBeenCalled()
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'awaiting_user_input', content: 'architect_plan' }),
    )
  })

  it('P2-04: 任务已建、phase 未推进、无计划：重新展示并等待确认，不执行', async () => {
    setupState('alignment', 'pm_confirm')
    mocks.mockMessageFindMany.mockResolvedValue([{ role: 'user', rawContent: '做个网站' }])

    await transitionToExecution('sess1', agents, mocks.mockSendEvent, '继续执行')

    expect(mocks.mockHandleExecution).not.toHaveBeenCalled()
    expect(mocks.mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: 'agent',
          agentId: '架构师',
          rawContent: expect.stringContaining('plan-'),
        }),
      }),
    )
    const phaseWrites = mocks.mockSessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))
    expect(phaseWrites).toEqual([{ phase: 'alignment', phaseStep: 'architect_plan' }])
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'awaiting_user_input', content: 'architect_plan' }),
    )
  })

  it('phase 恢复失败：报错并中止，不启动 handleExecution', async () => {
    setupState('alignment', 'architect_plan')
    mocks.mockSessionUpdateMany.mockResolvedValue({ count: 0 }) // transitionPhase CAS 连续失败

    await transitionToExecution('sess1', agents, mocks.mockSendEvent, '继续执行')

    expect(mocks.mockHandleExecution).not.toHaveBeenCalled()
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', content: expect.stringContaining('执行状态恢复失败') })
    )
    expect(mocks.mockSendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'phase_transition' })
    )
  })

  it('未知 phase：fail-closed，不执行', async () => {
    setupState('planning', '')

    const result = await ensureExecutableState('sess1')

    expect(result.ok).toBe(false)
    expect(mocks.mockTaskCreate).not.toHaveBeenCalled()
  })

  it('任务已创建但 align_decompose 推进失败：返回 false，不继续发 plan/done', async () => {
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'idle', phaseStep: '', projectDir: '', permissionMode: 'default' })
    mocks.mockDecomposeTasks.mockResolvedValue([
      { id: 'doc-1', description: '写文档', assignedAgent: '前端工程师', dependencies: [], declaredFiles: ['README.md'], batch: 0 },
    ])
    mocks.mockTaskCreate.mockResolvedValue({})
    mocks.mockSessionUpdateMany.mockResolvedValue({ count: 0 })

    const result = await handleArchitectPlan('写文档', 'sess1', agents, mocks.mockSendEvent)

    expect(result).toBe(false)
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', content: expect.stringContaining('进入对齐状态失败') })
    )
    expect(mocks.mockSendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'phase_transition', content: 'alignment' })
    )
    expect(mocks.mockSendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'awaiting_user_input', content: 'architect_plan' })
    )
  })

  it('任务 + verify 创建失败：整段中止，不推进 phase，不发 plan/done', async () => {
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'alignment', phaseStep: 'pm_confirm', projectDir: '', permissionMode: 'default' })
    mocks.mockTaskFindMany.mockResolvedValue([])
    mocks.mockDecomposeTasks.mockResolvedValue([
      { id: 'task-a', description: '任务 A', assignedAgent: '前端工程师', dependencies: [], declaredFiles: [], batch: 0 },
      { id: 'task-b', description: '任务 B', assignedAgent: '前端工程师', dependencies: [], declaredFiles: [], batch: 0 },
    ])
    mocks.mockTaskCreate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('db down'))

    const result = await handleArchitectPlan('做个网站', 'sess1', agents, mocks.mockSendEvent)

    expect(result).toBe(false)
    expect(mocks.mockSessionUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { phase: 'alignment', phaseStep: 'architect_plan' } })
    )
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', content: expect.stringContaining('任务创建失败') })
    )
    expect(mocks.mockSendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'done', content: 'plan summary' })
    )
  })
})

// ── replan 硬停：连续拆解失败封顶，不再无限烧 LLM ──
// 上限字面量 3 与实现常量同值但不引用——改动上限数字时测试必须变红。
describe('replan 硬停（连续失败封顶转人工）', () => {
  const agents = [
    { id: 'a1', name: '前端工程师', systemPrompt: '', platform: 'claude-code', expertise: '前端', model: '', baseUrl: '', apiKey: '', tools: '' },
  ]
  const U = (rawContent: string) => ({ role: 'user', rawContent })
  const R = (n = '') => ({ role: 'orchestrator', rawContent: `[REPLAN]失败${n}` })
  const lastCreated = () =>
    mocks.mockMessageCreate.mock.calls.map((c) => c[0]?.data?.rawContent).filter(Boolean).pop()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockMessageCreate.mockResolvedValue({})
    // clearAllMocks 不清实现：把行为 mock 全部显式覆盖默认，防止前面用例的残留实现污染
    mocks.mockDecomposeTasks.mockResolvedValue([])
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'idle', phaseStep: '', projectDir: '', permissionMode: 'default' })
    mocks.mockSessionMemberFindUnique.mockResolvedValue(null)
    mocks.mockTaskFindFirst.mockResolvedValue(null)
    mocks.mockTaskCreate.mockResolvedValue({})
    mocks.mockExecuteSingleAgent.mockReset()
  })

  it('计数器：空/成功轮清零/交错user照数/EXHAUSTED断链', () => {
    expect(countConsecutiveReplans([])).toBe(0)
    expect(countConsecutiveReplans([U('做个网站')])).toBe(0)
    expect(countConsecutiveReplans([U('a'), R(), U('b'), R(), U('c'), R()])).toBe(3)
    expect(countConsecutiveReplans([R(), U('b'), { role: 'orchestrator', rawContent: 'plan summary' }])).toBe(0)
    expect(
      countConsecutiveReplans([R(), R(), { role: 'orchestrator', rawContent: '[REPLAN-EXHAUSTED]停' }]),
    ).toBe(0)
  })

  it('3 连败硬停：不调拆解，写 EXHAUSTED 转人工', async () => {
    mocks.mockMessageFindMany.mockResolvedValue([U('a'), R('1'), U('b'), R('2'), U('c'), R('3')])

    const result = await handleArchitectPlan('c', 'sess1', agents, mocks.mockSendEvent)

    expect(result).toBe(false)
    expect(mocks.mockDecomposeTasks).not.toHaveBeenCalled()
    expect(String(lastCreated())).toContain('[REPLAN-EXHAUSTED]')
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', content: expect.stringContaining('连续') }),
    )
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'awaiting_user_input', content: '' }),
    )
  })

  it('2 连败未到顶：继续拆解并记 fresh [REPLAN]', async () => {
    mocks.mockMessageFindMany.mockResolvedValue([U('a'), R('1'), U('b'), R('2'), U('c')])
    mocks.mockDecomposeTasks.mockResolvedValue([])

    const result = await handleArchitectPlan('c', 'sess1', agents, mocks.mockSendEvent)

    expect(result).toBe(false)
    expect(mocks.mockDecomposeTasks).toHaveBeenCalledTimes(1)
    expect(String(lastCreated()).startsWith('[REPLAN]')).toBe(true)
    expect(String(lastCreated())).not.toContain('EXHAUSTED')
  })

  it('超时轮持久化 [REPLAN]（计入计数，且下轮用最新重述）', async () => {
    const archAgents = [
      { id: 'arch1', name: '架构师', systemPrompt: 'sp', platform: 'claude-code', expertise: '架构', model: '', baseUrl: '', apiKey: '', tools: '' },
    ]
    mocks.mockMessageFindMany.mockResolvedValue([])
    mocks.mockExecuteSingleAgent.mockRejectedValue(new TimeoutError(1000, 'test'))

    const result = await handleArchitectPlan('做个网站', 'sess1', archAgents, mocks.mockSendEvent)

    expect(result).toBe(false)
    expect(String(lastCreated()).startsWith('[REPLAN]')).toBe(true)
  })

  it('EXHAUSTED 后用户新输入：计数清零自动恢复尝试', async () => {
    mocks.mockMessageFindMany.mockResolvedValue([
      U('a'), R('1'), U('b'), R('2'), U('c'), R('3'),
      { role: 'orchestrator', rawContent: '[REPLAN-EXHAUSTED]停' },
      U('换个说法再试'),
    ])
    mocks.mockDecomposeTasks.mockResolvedValue([])

    const result = await handleArchitectPlan('换个说法再试', 'sess1', agents, mocks.mockSendEvent)

    expect(result).toBe(false)
    expect(mocks.mockDecomposeTasks).toHaveBeenCalledTimes(1)
    // EXHAUSTED 后复活按重述处理：拆最新输入而非冻结首条
    expect(String(mocks.mockDecomposeTasks.mock.calls[0][0])).toContain('换个说法')
    expect(String(lastCreated()).startsWith('[REPLAN]')).toBe(true)
    expect(String(lastCreated())).not.toContain('EXHAUSTED')
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
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'idle', phaseStep: '', projectDir: '', permissionMode: 'default' })
    mocks.mockMessageFindMany.mockResolvedValue([])
    mocks.mockTaskCreate.mockResolvedValue({})
    mocks.mockTaskFindFirst.mockResolvedValue(null)
    mocks.mockTaskCount.mockResolvedValue(1)
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
    // verify 必须在同一个交互式事务内创建（tx.task.create 包装器记录）
    expect(mocks.mockTxTaskCreates.some(id => id.startsWith('verify-'))).toBe(true)
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

  it('已存在 pending verify 且本轮无新代码任务 → 不重复创建也不更新', async () => {
    mocks.mockDecomposeTasks.mockResolvedValue([codeTask])
    mocks.mockTaskFindFirst.mockResolvedValue({ id: 'verify-existing', status: 'pending', dependencies: '["code-1"]' })

    await handleArchitectPlan('做个网站', 'sess1', agents, mocks.mockSendEvent)

    const verifyCalls = mocks.mockTaskCreate.mock.calls.filter(([arg]) => String(arg.data.id).startsWith('verify-'))
    expect(verifyCalls).toHaveLength(0)
    expect(mocks.mockTaskUpdate).not.toHaveBeenCalled()
  })

  it('无测试工程师时 assignedAgentId 为 null(executeTaskBatch 兜底匹配)', async () => {
    const noTestAgents = agents.filter(a => a.name !== '测试工程师')
    mocks.mockDecomposeTasks.mockResolvedValue([codeTask])

    await handleArchitectPlan('做个网站', 'sess1', noTestAgents, mocks.mockSendEvent)

    const verifyCall = mocks.mockTaskCreate.mock.calls.find(([arg]) => String(arg.data.id).startsWith('verify-'))
    expect(verifyCall).toBeDefined()
    expect(verifyCall![0].data.assignedAgentId).toBeNull()
  })

  // P6 T7: verify 维度实验开关——EXPERIMENT_VERIFY=off 只关 alignment 自动创建(实验 harness),
  // 生产默认未设 env = 零影响。prevEnv 保存/恢复模式参照 tests/chat-router.test.ts:412。
  it('P6: EXPERIMENT_VERIFY=off 不自动创建 verify 任务', async () => {
    const prev = process.env.EXPERIMENT_VERIFY
    process.env.EXPERIMENT_VERIFY = 'off'
    try {
      mocks.mockDecomposeTasks.mockResolvedValue([codeTask])
      await handleArchitectPlan('拆解', 'sess1', agents, mocks.mockSendEvent)
      // 含代码任务但开关 OFF → 无 verify- 前缀 task.create(代码任务本身仍建)
      expect(mocks.mockTaskCreate).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ id: expect.stringMatching(/^verify-/) }) })
      )
    } finally {
      if (prev === undefined) delete process.env.EXPERIMENT_VERIFY
      else process.env.EXPERIMENT_VERIFY = prev
    }
  })

  it('P6: 未设 EXPERIMENT_VERIFY → 默认创建 verify 任务', async () => {
    const prev = process.env.EXPERIMENT_VERIFY
    delete process.env.EXPERIMENT_VERIFY
    try {
      mocks.mockDecomposeTasks.mockResolvedValue([codeTask])
      await handleArchitectPlan('拆解', 'sess1', agents, mocks.mockSendEvent)
      expect(mocks.mockTaskCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ id: expect.stringMatching(/^verify-/) }) })
      )
    } finally {
      if (prev === undefined) delete process.env.EXPERIMENT_VERIFY
      else process.env.EXPERIMENT_VERIFY = prev
    }
  })
})

// ── 多轮对齐 verify 条件式：pending 追加 / 终结新建 ──
describe('多轮对齐 verify 条件式', () => {
  const agents = [
    { id: 'a1', name: '前端工程师', systemPrompt: '', platform: 'claude-code', expertise: '前端', model: '', baseUrl: '', apiKey: '', tools: '' },
    { id: 'a3', name: '测试工程师', systemPrompt: '', platform: 'claude-code', expertise: '测试', model: '', baseUrl: '', apiKey: '', tools: '' },
  ]
  const codeTask2 = { id: 'code-2', description: '实现支付接口', assignedAgent: '后端工程师', dependencies: [], declaredFiles: ['src/api/pay.ts'], outputSchema: undefined, batch: 0 }
  const oldCodeTask = { id: 'code-1', description: '实现登录接口', declaredFiles: '["src/api/login.ts"]' }

  const setup = () => {
    vi.clearAllMocks()
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockSessionFindUnique.mockResolvedValue({ phase: 'idle', phaseStep: '', projectDir: '', permissionMode: 'default' })
    mocks.mockMessageFindMany.mockResolvedValue([])
    mocks.mockMessageCreate.mockResolvedValue({})
    mocks.mockTaskCreate.mockResolvedValue({})
    mocks.mockTaskUpdate.mockResolvedValue({})
    mocks.mockTaskFindMany.mockResolvedValue([oldCodeTask])
    mocks.mockTaskCount.mockResolvedValue(1)
    mocks.mockSessionMemberFindUnique.mockResolvedValue(null)
  }

  it('老 verify pending + 本轮新代码 → UPDATE 追加依赖，不新建', async () => {
    setup()
    mocks.mockDecomposeTasks.mockResolvedValue([codeTask2])
    mocks.mockTaskFindFirst.mockResolvedValue({ id: 'verify-old', status: 'pending', dependencies: '["code-1"]' })

    await handleArchitectPlan('加个支付功能', 'sess1', agents, mocks.mockSendEvent)

    const verifyCalls = mocks.mockTaskCreate.mock.calls.filter(([arg]) => String(arg.data.id).startsWith('verify-'))
    expect(verifyCalls).toHaveLength(0)
    expect(mocks.mockTaskUpdate).toHaveBeenCalledTimes(1)
    const updateArg = mocks.mockTaskUpdate.mock.calls[0][0]
    expect(updateArg.where).toEqual({ id: 'verify-old' })
    expect(updateArg.data.dependencies).toBe(JSON.stringify(['code-1', 'code-2']))
    expect(updateArg.data.description).toContain('实现登录接口')
    expect(updateArg.data.description).toContain('实现支付接口')
    expect(updateArg.data.description).toContain('src/api/pay.ts')
    expect(mocks.mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('扩展') })
    )
  })

  it.each(['completed', 'in_progress', 'failed'])('老 verify %s → 新建本轮 verify，不碰老的', async (st) => {
    setup()
    mocks.mockDecomposeTasks.mockResolvedValue([codeTask2])
    mocks.mockTaskFindFirst.mockResolvedValue({ id: 'verify-old', status: st, dependencies: '["code-1"]' })

    await handleArchitectPlan('加个支付功能', 'sess1', agents, mocks.mockSendEvent)

    expect(mocks.mockTaskUpdate).not.toHaveBeenCalled()
    const verifyCalls = mocks.mockTaskCreate.mock.calls.filter(([arg]) => String(arg.data.id).startsWith('verify-'))
    expect(verifyCalls).toHaveLength(1)
    expect(verifyCalls[0][0].data.dependencies).toBe(JSON.stringify(['code-2']))
    expect(verifyCalls[0][0].data.description).toContain('实现支付接口')
    expect(verifyCalls[0][0].data.description).not.toContain('实现登录接口')
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
