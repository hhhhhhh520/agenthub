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
})