import { describe, it, expect, vi, beforeEach } from 'vitest'
import { canonicalCorrect, applyTransition, stateFromSession } from '@/lib/orchestrator/state-machine'

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
