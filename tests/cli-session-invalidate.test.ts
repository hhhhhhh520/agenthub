import { describe, it, expect, vi, beforeEach } from 'vitest'

// roadmap §2.4: cliSessionId 失效统一入口。
// 单元测试锁定 invalidateCliSession 的三个行为契约：
// 1) task + SessionMember 两表清空必须在同一 $transaction 内（⚠️-C2 语义，防半残）
// 2) 调用方附加字段透传合并，cliSessionId 恒为 null（即使 taskData 携带脏值也被覆盖）
// 3) agentId 为空时只清 Task，不碰 SessionMember（redo 无 assignedAgent 路径）

const { mockTaskUpdate, mockMemberUpdateMany, mockTransaction } = vi.hoisted(() => ({
  mockTaskUpdate: vi.fn(),
  mockMemberUpdateMany: vi.fn(),
  mockTransaction: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: { update: mockTaskUpdate },
    sessionMember: { updateMany: mockMemberUpdateMany },
    $transaction: mockTransaction,
  },
}))

import { invalidateCliSession } from '@/lib/services/cli-session'

beforeEach(() => {
  vi.clearAllMocks()
  mockTaskUpdate.mockResolvedValue({ id: 't1' })
  mockMemberUpdateMany.mockResolvedValue({ count: 1 })
  mockTransaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops))
})

describe('invalidateCliSession — 统一失效入口', () => {
  it('两表清空在同一 $transaction 数组内，且数组元素正是两表操作的返回值', async () => {
    await invalidateCliSession({
      taskId: 't1',
      sessionId: 's1',
      agentId: 'a1',
      taskData: { status: 'failed', trace: '[{"event":"error"}]' },
    })

    expect(mockTaskUpdate).toHaveBeenCalledTimes(1)
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { status: 'failed', trace: '[{"event":"error"}]', cliSessionId: null },
    })
    expect(mockMemberUpdateMany).toHaveBeenCalledTimes(1)
    expect(mockMemberUpdateMany).toHaveBeenCalledWith({
      where: { sessionId: 's1', agentId: 'a1' },
      data: { cliSessionId: null },
    })

    // 接线断言：事务数组必须包含 task.update 与 sessionMember.updateMany 的返回 promise。
    // 防变异——函数体改成顺序 await（不走事务）时，这里会红。
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    const ops = mockTransaction.mock.calls[0][0] as Promise<unknown>[]
    expect(ops).toHaveLength(2)
    expect(ops[0]).toBe(mockTaskUpdate.mock.results[0].value)
    expect(ops[1]).toBe(mockMemberUpdateMany.mock.results[0].value)
  })

  it('taskData 携带 cliSessionId 脏值时仍被强制置 null（spread 顺序兜底）', async () => {
    await invalidateCliSession({
      taskId: 't1',
      sessionId: 's1',
      agentId: 'a1',
      taskData: { cliSessionId: 'dirty-session' },
    })

    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { cliSessionId: null },
    })
  })

  it('taskData 缺省时只清 cliSessionId', async () => {
    await invalidateCliSession({ taskId: 't1', sessionId: 's1', agentId: 'a1' })

    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { cliSessionId: null },
    })
  })

  it('agentId 为 null 时只清 Task，不写 SessionMember（redo 无 assignedAgent 路径）', async () => {
    await invalidateCliSession({
      taskId: 't1',
      sessionId: 's1',
      agentId: null,
      taskData: { status: 'pending' },
    })

    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { status: 'pending', cliSessionId: null },
    })
    expect(mockMemberUpdateMany).not.toHaveBeenCalled()
    const ops = mockTransaction.mock.calls[0][0] as Promise<unknown>[]
    expect(ops).toHaveLength(1)
  })
})
