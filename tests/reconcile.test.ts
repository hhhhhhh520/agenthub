import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── §3.3 执行中断恢复语义——启动 reconcile（roadmap；参考 codeg reconcile tick 精神）──
//
// 现状：批次中断（进程崩溃/handler 被杀）后任务永久 in_progress、SessionMember 永久 working，
// 恢复依赖 GET /api/sessions/[id] 的 5 分钟 stuck reset——前端不开会话页就永远不触发。
// 本模块：启动时主动收敛（instrumentation 接线），不依赖锁超时行为，也不依赖前端在线。
//
// 语义契约（本文件锁定）：
//   1. 只收敛"中断残留"：in_progress 任务 → pending（条件写 where 带 status:'in_progress'
//      前置——§3.2 纪律，findMany 与 updateMany 之间的转移不会被打回）；working 成员 → idle
//      （**无条件**——成员残留不必然伴随任务残留，审查 F1）。
//   2. phase 留 execution 不动（ISSUE-011 F2 拍板：便于下次消息继续执行遗留任务）。
//   3. 无任务残留 → 任务零写（启动路径的常态）。
//   4. DB 异常向上抛（instrumentation 的 best-effort 容错负责吞掉——本函数保持单一职责）。
//   5. 恢复动作留可见日志（按会话汇总），恢复后用户续跑经 handleExecution → eventLogger
//      落库 → 前端 EventSource 补发（§3.1 衔接，无需额外事件）。

const { mockTaskFindMany, mockTaskUpdateMany, mockMemberUpdateMany } = vi.hoisted(() => ({
  mockTaskFindMany: vi.fn(),
  mockTaskUpdateMany: vi.fn(),
  mockMemberUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: { findMany: mockTaskFindMany, updateMany: mockTaskUpdateMany },
    sessionMember: { updateMany: mockMemberUpdateMany },
  },
}))

import { reconcileInterruptedSessions } from '@/lib/services/reconcile'

describe('reconcileInterruptedSessions — 启动中断恢复（§3.3）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTaskUpdateMany.mockResolvedValue({ count: 2 })
    mockMemberUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('有 in_progress 残留 → 条件写置 pending（where 带 status 前置）+ working 成员置 idle', async () => {
    mockTaskFindMany.mockResolvedValue([
      { id: 't1', sessionId: 's1' },
      { id: 't2', sessionId: 's1' },
      { id: 't3', sessionId: 's2' },
    ])

    const n = await reconcileInterruptedSessions()

    expect(n).toBe(2) // updateMany count
    // §3.2 纪律：id 限定 + status 前置（findMany 与 updateMany 之间的转移不被打回，变异锚点）
    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['t1', 't2', 't3'] }, status: 'in_progress' },
      data: { status: 'pending' },
    })
    expect(mockMemberUpdateMany).toHaveBeenCalledWith({
      where: { status: 'working' },
      data: { status: 'idle' },
    })
  })

  it('无任务残留（启动常态）→ 任务零写；member 清扫无条件执行（审查 F1：成员残留不必然伴随任务残留）', async () => {
    mockTaskFindMany.mockResolvedValue([])

    const n = await reconcileInterruptedSessions()

    expect(n).toBe(0)
    expect(mockTaskUpdateMany).not.toHaveBeenCalled()
    // F1 修法：member 清扫提到早退之前——对齐期崩溃/GET 恢复后等"零任务残留但 working 残留"场景也能收敛
    expect(mockMemberUpdateMany).toHaveBeenCalledWith({ where: { status: 'working' }, data: { status: 'idle' } })
  })

  it('恢复留痕：按会话汇总 warn 日志（可见性）', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    mockTaskFindMany.mockResolvedValue([
      { id: 't1', sessionId: 's1' },
      { id: 't2', sessionId: 's1' },
      { id: 't3', sessionId: 's2' },
    ])

    await reconcileInterruptedSessions()

    const warns = warnSpy.mock.calls.map(c => String(c[0]))
    expect(warns.some(w => w.includes('s1') && w.includes('2'))).toBe(true)
    expect(warns.some(w => w.includes('s2') && w.includes('1'))).toBe(true)
  })

  it('count=0（残留已被其他写者收敛）→ 返回 0 且不留痕（条件写弃权）', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    mockTaskFindMany.mockResolvedValue([{ id: 't1', sessionId: 's1' }])
    mockTaskUpdateMany.mockResolvedValue({ count: 0 })

    const n = await reconcileInterruptedSessions()

    expect(n).toBe(0)
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('中断恢复'))).toBe(false)
  })

  it('F1 回归守卫：零任务残留 + working 成员残留 → member 清扫仍被调用（不被任务早退门禁锁死）', async () => {
    // 对齐/讨论期崩溃：会话无任何 task，但 member 已被置 working
    mockTaskFindMany.mockResolvedValue([])

    await reconcileInterruptedSessions()

    expect(mockMemberUpdateMany).toHaveBeenCalledTimes(1)
  })
})
