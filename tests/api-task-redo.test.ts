import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockTaskFindUnique, mockTaskUpdate, mockTaskFindMany,
  mockSessionFindUnique, mockSessionUpdate, mockMessageFindMany, mockAgentFindMany,
  mockSessionMemberUpdateMany, mockHandleExecution,
} = vi.hoisted(() => ({
  mockTaskFindUnique: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskFindMany: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockAgentFindMany: vi.fn().mockResolvedValue([]),
  mockSessionMemberUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockHandleExecution: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: { findUnique: mockTaskFindUnique, update: mockTaskUpdate, findMany: mockTaskFindMany },
    session: { findUnique: mockSessionFindUnique, update: mockSessionUpdate },
    message: { findMany: mockMessageFindMany },
    agent: { findMany: mockAgentFindMany },
    sessionMember: { updateMany: mockSessionMemberUpdateMany },
    // F3 修复:redo 用 $transaction 包两表更新
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}))

// ❌-2 修复:redo 改调 handleExecution(不再调 executeSingleAgent)
vi.mock('@/lib/services/execution', () => ({
  handleExecution: mockHandleExecution,
}))

vi.mock('@/lib/session-lock', () => ({
  acquireSessionLock: vi.fn().mockResolvedValue(() => {}),
}))

import { POST } from '@/app/api/sessions/[id]/tasks/[taskId]/redo/route'

function makeReq(body: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/sessions/s1/tasks/t1/redo', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

const params = { params: Promise.resolve({ id: 's1', taskId: 't1' }) }

const FAKE_AGENT = {
  id: 'a1', name: '前端', systemPrompt: 'sp', platform: 'claude-code',
  model: 'm', baseUrl: '', apiKey: 'k', tools: '[]',
}

beforeEach(() => {
  vi.clearAllMocks()
  // 默认会话存在且 exec 态(镜像生产):闸门放行、transitionPhase 成功;对齐/异常态用例用 once 覆盖
  mockSessionFindUnique.mockResolvedValue({ phase: 'execution', phaseStep: '' })
  mockSessionUpdate.mockResolvedValue({})
  mockMessageFindMany.mockResolvedValue([])
  mockAgentFindMany.mockResolvedValue([{
    id: 'a1', name: '前端', systemPrompt: 'sp', platform: 'claude-code',
    model: 'm', baseUrl: '', apiKey: 'k', tools: '[]', expertise: 'ui',
  }])
  mockSessionMemberUpdateMany.mockResolvedValue({ count: 0 })
  mockHandleExecution.mockResolvedValue(undefined)
})

describe('POST /api/sessions/[id]/tasks/[taskId]/redo', () => {
  it('returns 404 when task not found', async () => {
    mockTaskFindUnique.mockResolvedValue(null)
    const res = await POST(makeReq(), params)
    expect(res.status).toBe(404)
  })

  it('returns 403 when task belongs to different session', async () => {
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 'other-session', status: 'failed',
    })
    const res = await POST(makeReq(), params)
    expect(res.status).toBe(403)
  })

  it('returns 400 when task status is not redoable', async () => {
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 's1', status: 'completed', assignedAgent: null,
    })
    const res = await POST(makeReq(), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Cannot redo')
  })

  it('[❌-2] resets failed task to pending and clears cliSessionId before calling handleExecution', async () => {
    mockTaskFindUnique
      .mockResolvedValueOnce({  // 首次:redo handler 内
        id: 't1', sessionId: 's1', status: 'failed', description: '实现页面',
        assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]',
      })
      .mockResolvedValueOnce({  // 第二次:return 时查 final status
        id: 't1', status: 'completed',
      })
    mockTaskFindMany.mockResolvedValue([])
    mockTaskUpdate.mockResolvedValue({})

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('completed')

    // ❌-2 关键断言 1:task 重置时 cliSessionId 清空
    const resetCall = mockTaskUpdate.mock.calls.find(
      c => c[0].where.id === 't1' && c[0].data.status === 'pending'
    )
    expect(resetCall).toBeDefined()
    expect(resetCall[0].data.cliSessionId).toBeNull()
    expect(resetCall[0].data.correctionCount).toBe(0)

    // ❌-2 关键断言 2:SessionMember.cliSessionId 也被清
    expect(mockSessionMemberUpdateMany).toHaveBeenCalledWith({
      where: { sessionId: 's1', agentId: 'a1' },
      data: { cliSessionId: null },
    })

    // ❌-2 关键断言 3:调了 handleExecution(走主链路,享受 contract 全部保护)
    expect(mockHandleExecution).toHaveBeenCalled()
    const [msg, sessId, agents] = mockHandleExecution.mock.calls[0]
    expect(sessId).toBe('s1')
    expect(Array.isArray(agents)).toBe(true)
  })

  it('[❌-2] allows updating task description on redo', async () => {
    mockTaskFindUnique
      .mockResolvedValueOnce({
        id: 't1', sessionId: 's1', status: 'blocked', description: '原始描述',
        assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]',
      })
      .mockResolvedValueOnce({ id: 't1', status: 'completed' })
    mockTaskFindMany.mockResolvedValue([])
    mockTaskUpdate.mockResolvedValue({})

    const res = await POST(makeReq({ description: '新描述' }), params)
    expect(res.status).toBe(200)

    // 验证 description 被更新
    const resetCall = mockTaskUpdate.mock.calls.find(
      c => c[0].where.id === 't1' && c[0].data.status === 'pending'
    )
    expect(resetCall[0].data.description).toBe('新描述')
  })

  it('[❌-2] returns 500 when handleExecution throws', async () => {
    mockTaskFindUnique.mockResolvedValueOnce({
      id: 't1', sessionId: 's1', status: 'failed', description: 'x',
      assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]',
    })
    mockTaskFindMany.mockResolvedValue([])
    mockTaskUpdate.mockResolvedValue({})
    mockHandleExecution.mockRejectedValue(new Error('orchestrator 崩了'))

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.status).toBe('failed')
    expect(body.error).toContain('崩了')
  })

  it('[❌-2] no assignedAgent → 仅重置 pending,不调 handleExecution', async () => {
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 's1', status: 'failed', description: 'x',
      assignedAgent: null, assignedAgentId: null, dependencies: '[]',
    })
    mockTaskFindMany.mockResolvedValue([])
    mockTaskUpdate.mockResolvedValue({})

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('pending')
    expect(mockHandleExecution).not.toHaveBeenCalled()
  })

  it('[❌-2] unblocks downstream tasks whose deps now all complete', async () => {
    mockTaskFindUnique
      .mockResolvedValueOnce({
        id: 't1', sessionId: 's1', status: 'failed', description: 'x',
        assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]',
      })
      .mockResolvedValueOnce({ id: 't1', status: 'completed' })
    // 下游 task t2 blocked,依赖 t1
    mockTaskFindMany.mockResolvedValue([
      { id: 't2', status: 'blocked', dependencies: '["t1"]' },
    ])
    mockTaskUpdate.mockResolvedValue({})

    await POST(makeReq(), params)

    // t2 应被解锁回 pending
    const unblock = mockTaskUpdate.mock.calls.find(
      c => c[0].where.id === 't2' && c[0].data.status === 'pending'
    )
    expect(unblock).toBeDefined()
  })

  it('P2 回归守卫 T4: redo 在 align_pm(需求确认)阶段 → 400 拒绝,不调 handleExecution', async () => {
    mockTaskFindUnique.mockResolvedValueOnce({
      id: 't1', sessionId: 's1', status: 'failed', description: 'x',
      assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]',
    })
    mockSessionFindUnique.mockResolvedValueOnce({ phase: 'alignment', phaseStep: 'pm_confirm' })
    mockTaskFindMany.mockResolvedValue([])
    mockTaskUpdate.mockResolvedValue({})

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('需求确认')
    // 旧代码: 不查 phase,直接跑 handleExecution;新代码: 闸门拒绝
    expect(mockHandleExecution).not.toHaveBeenCalled()
  })

  it('P2 T4: redo 在合法 phase(exec) → 先 transitionPhase 进 exec,再调 handleExecution', async () => {
    mockTaskFindUnique
      .mockResolvedValueOnce({
        id: 't1', sessionId: 's1', status: 'failed', description: 'x',
        assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]',
      })
      .mockResolvedValueOnce({ id: 't1', status: 'completed' })
    // 持久 mock: gate 与 transitionPhase 各读一次 session
    mockSessionFindUnique.mockResolvedValue({ phase: 'execution', phaseStep: '' })
    mockSessionUpdate.mockResolvedValue({})
    mockTaskFindMany.mockResolvedValue([])
    mockTaskUpdate.mockResolvedValue({})

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(200)
    // transitionPhase('execute') 写了 exec 态,确保 handleExecution 结束的 done 转移合法
    expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { phase: 'execution', phaseStep: '' } })
    expect(mockHandleExecution).toHaveBeenCalled()
  })

  it('P2 T4: transitionPhase 失败(fail-closed) → 500 拒绝,不调 handleExecution', async () => {
    mockTaskFindUnique.mockResolvedValueOnce({
      id: 't1', sessionId: 's1', status: 'failed', description: 'x',
      assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]',
    })
    // gate 读到 exec 放行,transitionPhase 再读时 session 丢失(模拟并发窗口/DB 异常)
    mockSessionFindUnique
      .mockResolvedValueOnce({ phase: 'execution', phaseStep: '' })
      .mockResolvedValueOnce(null)
    mockTaskFindMany.mockResolvedValue([])
    mockTaskUpdate.mockResolvedValue({})

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(500)
    expect(mockHandleExecution).not.toHaveBeenCalled()
  })

  it('P2 回归守卫 T4: 未知/脏 phase 不兜底放行 → 400 状态异常,不调 handleExecution', async () => {
    mockTaskFindUnique.mockResolvedValueOnce({
      id: 't1', sessionId: 's1', status: 'failed', description: 'x',
      assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]',
    })
    // alignment + 未知 step(漂移,如尾部空白):旧代码 stateFromSession 兜底 idle 会放行
    mockSessionFindUnique.mockResolvedValueOnce({ phase: 'alignment', phaseStep: 'pm_confirm ' })
    mockTaskFindMany.mockResolvedValue([])
    mockTaskUpdate.mockResolvedValue({})

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('状态异常')
    expect(mockHandleExecution).not.toHaveBeenCalled()
  })

  it('P2 T4: 5 个合法态 idle/align_arch/align_qa/exec/done 的 redo 均放行并执行', async () => {
    const legalStates = [
      { phase: 'idle', phaseStep: '' },
      { phase: 'alignment', phaseStep: 'architect_plan' },
      { phase: 'alignment', phaseStep: 'agent_qa' },
      { phase: 'execution', phaseStep: '' },
      { phase: 'done', phaseStep: '' },
    ]
    for (const s of legalStates) {
      mockHandleExecution.mockClear()
      mockTaskFindUnique
        .mockReset()
        .mockResolvedValueOnce({ id: 't1', sessionId: 's1', status: 'failed', description: 'x', assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]' })
        .mockResolvedValueOnce({ id: 't1', status: 'completed' })
      mockSessionFindUnique.mockReset().mockResolvedValue(s)
      mockSessionUpdate.mockReset()
      mockTaskFindMany.mockReset().mockResolvedValue([])
      mockTaskUpdate.mockReset().mockResolvedValue({})

      const res = await POST(makeReq(), params)
      expect(res.status).toBe(200)
      expect(mockHandleExecution).toHaveBeenCalledTimes(1)
    }
  })
})
