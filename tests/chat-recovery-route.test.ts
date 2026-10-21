import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  sessionUpdateMany: vi.fn(),
  taskFindMany: vi.fn(),
  taskCount: vi.fn(),
  taskFindFirst: vi.fn(),
  messageFindMany: vi.fn(),
  messageCreate: vi.fn(),
  messageFindUnique: vi.fn(),
  messageUpdate: vi.fn(),
  sessionMemberFindMany: vi.fn(),
  sessionMemberFindUnique: vi.fn(),
  attachmentFindMany: vi.fn(),
  acquireSessionLock: vi.fn(),
  releaseLock: vi.fn(),
  createEventLogger: vi.fn(),
  handleExecution: vi.fn(),
  getOrchestratorDecision: vi.fn(),
  executeSingleAgent: vi.fn(),
  callLLMForAnalysis: vi.fn(),
  analyzeScene: vi.fn(),
  generateRoles: vi.fn(),
  decomposeTasks: vi.fn(),
  formatArchitectPlan: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: mocks.sessionFindUnique, updateMany: mocks.sessionUpdateMany, update: vi.fn() },
    task: {
      findMany: mocks.taskFindMany,
      count: mocks.taskCount,
      findFirst: mocks.taskFindFirst,
    },
    message: {
      findMany: mocks.messageFindMany,
      create: mocks.messageCreate,
      findUnique: mocks.messageFindUnique,
      update: mocks.messageUpdate,
    },
    sessionMember: {
      findMany: mocks.sessionMemberFindMany,
      findUnique: mocks.sessionMemberFindUnique,
    },
    attachment: { findMany: mocks.attachmentFindMany },
    agent: { findFirst: vi.fn() },
  },
}))

vi.mock('@/lib/session-lock', () => ({
  acquireSessionLock: mocks.acquireSessionLock,
}))

vi.mock('@/lib/services/event-log', () => ({
  createEventLogger: mocks.createEventLogger,
}))

vi.mock('@/lib/services/execution', () => ({
  handleExecution: mocks.handleExecution,
}))

vi.mock('@/lib/services/agent-factory', () => ({
  handleCreateAgent: vi.fn(),
}))

vi.mock('@/lib/services/review', () => ({
  reviewResult: vi.fn(),
  delegateToAgent: vi.fn(),
  runMultiAgentDiscussion: vi.fn(),
}))

vi.mock('@/lib/orchestrator', () => ({
  getOrchestratorDecision: mocks.getOrchestratorDecision,
  executeSingleAgent: mocks.executeSingleAgent,
  getOrchestratorAgent: vi.fn(),
  callLLMForAnalysis: mocks.callLLMForAnalysis,
  analyzeScene: mocks.analyzeScene,
  generateRoles: mocks.generateRoles,
  decomposeTasks: mocks.decomposeTasks,
  parseJSON: vi.fn(),
  formatArchitectPlan: mocks.formatArchitectPlan,
}))

import { POST } from '@/app/api/sessions/[id]/chat/route'
import { buildPlanId } from '@/lib/services/alignment'

const params = { params: Promise.resolve({ id: 's1' }) }
const session = {
  id: 's1',
  type: 'group',
  permissionMode: 'default',
  projectDir: '',
  phase: 'alignment',
  phaseStep: 'architect_plan',
  decisionTrace: '[]',
}
const task = {
  id: 't1',
  description: '实现登录',
  assignedAgentId: 'a1',
  dependencies: '[]',
  declaredFiles: '[]',
  outputSchema: null,
}
const userMessage = { id: 'u1', role: 'user', rawContent: '执行', agentId: null }

function makeReq() {
  return new Request('http://localhost/api/sessions/s1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '执行' }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sessionFindUnique.mockResolvedValue(session)
  mocks.sessionUpdateMany.mockResolvedValue({ count: 1 })
  mocks.taskFindMany.mockResolvedValue([task])
  mocks.taskCount.mockResolvedValue(1)
  mocks.taskFindFirst.mockResolvedValue(null)
  mocks.messageFindMany.mockResolvedValue([userMessage])
  mocks.messageCreate.mockResolvedValue({ id: 'm1' })
  mocks.messageFindUnique.mockResolvedValue(null)
  mocks.messageUpdate.mockResolvedValue({})
  mocks.sessionMemberFindMany.mockResolvedValue([{
    agent: {
      id: 'a1', name: '前端工程师', systemPrompt: '', expertise: '前端',
      platform: 'claude-code', model: '', baseUrl: '', apiKey: '', tools: '',
      isOrchestrator: false,
    },
  }])
  mocks.sessionMemberFindUnique.mockResolvedValue(null)
  mocks.attachmentFindMany.mockResolvedValue([])
  mocks.acquireSessionLock.mockResolvedValue(mocks.releaseLock)
  mocks.createEventLogger.mockResolvedValue({
    sendEvent: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })
  mocks.getOrchestratorDecision.mockResolvedValue({
    decision: { action: 'execute', message: '', reason: '用户确认执行' },
    sessionId: 'orch',
  })
  mocks.formatArchitectPlan.mockReturnValue('plan summary')
})

describe('chat recovery route — P2-04 未获批计划不得自动执行', () => {
  it('align_arch + 任务已建 + 无计划消息 → 重新展示计划并等待确认，不调用 handleExecution', async () => {
    const res = await POST(makeReq(), params)
    await res.text()

    expect(res.status).toBe(200)
    expect(mocks.handleExecution).not.toHaveBeenCalled()

    const phaseWrites = mocks.sessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))
    expect(phaseWrites).toHaveLength(0)

    const planMessage = mocks.messageCreate.mock.calls
      .map(c => c[0]?.data)
      .find(d => d?.agentId === '架构师' && typeof d?.rawContent === 'string')
    expect(planMessage?.rawContent).toContain('计划编号：plan-')
  })

  it('P1: done + 新任务但计划未展示，拒绝执行并重呈计划', async () => {
    mocks.sessionFindUnique.mockResolvedValue({ ...session, phase: 'done', phaseStep: '' })
    mocks.messageFindMany.mockResolvedValue([{ role: 'user', rawContent: '不同意，先不要执行' }])

    const request = new Request('http://localhost/api/sessions/s1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '不同意，先不要执行' }),
    })
    const res = await POST(request, params)
    await res.text()

    expect(mocks.handleExecution).not.toHaveBeenCalled()
    const planMessage = mocks.messageCreate.mock.calls
      .map(c => c[0]?.data)
      .find(d => d?.agentId === '架构师' && typeof d?.rawContent === 'string')
    expect(planMessage?.rawContent).toContain('计划编号：plan-')
  })

  it('F2: 明确确认执行写入结构化批准记录并放行', async () => {
    const planId = buildPlanId(['t1'])
    const rows: Array<{ role: string; agentId?: string | null; rawContent: string }> = [
      { role: 'user', rawContent: '做一个功能', agentId: null },
      { role: 'agent', agentId: '架构师', rawContent: `plan summary\n\n> 计划编号：plan-${planId}` },
    ]
    mocks.messageFindMany.mockImplementation(async () => [...rows])
    mocks.messageCreate.mockImplementation(async ({ data }: { data: { role: string; agentId?: string | null; rawContent: string } }) => {
      rows.push({ role: data.role, agentId: data.agentId ?? null, rawContent: data.rawContent })
      return { id: 'm1' }
    })

    const request = new Request('http://localhost/api/sessions/s1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '确认执行' }),
    })
    const res = await POST(request, params)
    await res.text()

    expect(mocks.handleExecution).toHaveBeenCalledTimes(1)
    expect(rows.some(r => r.role === 'system' && r.rawContent === `[PLAN_APPROVED]plan-${planId}`)).toBe(true)
  })

  it('F2: 计划后的明确拒绝不能当作批准，不启动执行', async () => {
    const refusal = '不同意，先不要执行，我要修改方案'
    const planId = buildPlanId(['t1'])
    mocks.messageFindMany.mockResolvedValue([
      { role: 'user', rawContent: '做一个功能' },
      { role: 'agent', agentId: '架构师', rawContent: `plan summary\n\n> 计划编号：plan-${planId}` },
      { role: 'user', rawContent: refusal },
    ])
    mocks.getOrchestratorDecision.mockResolvedValue({
      decision: { action: 'execute', message: '', reason: '模型误提执行' },
      sessionId: 'orch',
    })

    const request = new Request('http://localhost/api/sessions/s1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: refusal }),
    })
    const res = await POST(request, params)
    await res.text()

    expect(mocks.handleExecution).not.toHaveBeenCalled()
    expect(mocks.messageCreate.mock.calls.some(([arg]) =>
      arg?.data?.role === 'system' && String(arg.data.rawContent).startsWith('[PLAN_APPROVED]')
    )).toBe(false)
  })

  it('F3: 任务已提交、phase 停在 align_pm，真实 POST 能重呈计划', async () => {
    mocks.sessionFindUnique.mockResolvedValue({ ...session, phaseStep: 'pm_confirm' })
    mocks.messageFindMany.mockResolvedValue([{ role: 'user', rawContent: '执行' }])

    const res = await POST(makeReq(), params)
    await res.text()

    expect(res.status).toBe(200)
    expect(mocks.handleExecution).not.toHaveBeenCalled()
    const planMessage = mocks.messageCreate.mock.calls
      .map(c => c[0]?.data)
      .find(d => d?.agentId === '架构师' && typeof d?.rawContent === 'string')
    expect(planMessage?.rawContent).toContain('计划编号：plan-')
  })

  it('F3: align_pm + 无任务仍按非法 execute 拒绝，不进入恢复入口', async () => {
    mocks.sessionFindUnique.mockResolvedValue({ ...session, phaseStep: 'pm_confirm' })
    mocks.taskCount.mockResolvedValue(0)
    mocks.taskFindMany.mockResolvedValue([])

    const res = await POST(makeReq(), params)
    await res.text()

    expect(mocks.handleExecution).not.toHaveBeenCalled()
    expect(mocks.messageCreate.mock.calls.some(([arg]) => arg?.data?.agentId === '架构师')).toBe(false)
    expect(mocks.sessionUpdateMany.mock.calls
      .map(c => c[0]?.data)
      .filter(d => d && Object.hasOwn(d, 'phase'))).toHaveLength(0)
  })
})