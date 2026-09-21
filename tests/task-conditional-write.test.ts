import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── §3.2 B1-B7: Task 批次状态前置条件写（roadmap "generation CAS 统一状态写入" 批次侧）──
//
// 竞态窗口（docs/design/phase2-3.2-write-points.md §2）：
//   - SSE 60min 超时 / abort 提前释放锁后 handler 后台续跑（僵尸流），用户重发产生新流：
//     两流对同一任务双标记 in_progress → 双执行 → 双写 completed/failed/result。
//   - GET stuck reset（无锁，5min 阈值）与执行流竞态：reset 置 pending 后执行流仍无条件写
//     completed 覆盖；僵尸流晚到的纠偏写（completed→pending）覆盖新流推进。
//
// 条件写语义（本文件锁定的行为契约）：
//   B1 标记 pending→in_progress 必须条件写 where status='pending'；count=0 → 重读同步内存 +
//      剔除出批（不调 agent）+ 可见 warn —— 这是"重复执行结构性不可能"的互斥闸门
//   B2 completed 条件写 where status='in_progress'；count=0 → 弃权：不写 result、不触发
//      monitoring、SessionMember 不写（防"任务被拒但 member 记了新 session"的脏 fallback）
//   B3/B4/B5 同理带前置 status 条件
//   B6 invalidateCliSession 加 expectedFrom 前置条件，返回 { applied }；条件不匹配 → 任务不被重置
//
// 变异验证锚点：任一写点去掉条件 where / 退回无条件 task.update → 对应用例精确红。

const mocks = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockTaskFindMany: vi.fn(),
  mockTaskFindUnique: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskUpdateMany: vi.fn(),
  mockTaskCount: vi.fn(),
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockMessageCreate: vi.fn(),
  mockExecuteTaskBatch: vi.fn(),
  mockExecuteSingleAgent: vi.fn(),
  mockGetOrchestratorAgent: vi.fn().mockResolvedValue({ platform: 'claude-code', model: 'test', baseUrl: '', apiKey: 'sk' }),
  mockGetChangedFiles: vi.fn().mockReturnValue([]),
  mockGetGitSnapshot: vi.fn().mockReturnValue(new Set()),
  mockEnforceFileOverlap: vi.fn(),
  mockSessionMemberFindMany: vi.fn().mockResolvedValue([]),
  mockSessionMemberUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  mockBuildContextFromHistory: vi.fn().mockReturnValue(''),
}))

vi.mock('@/lib/db', () => {
  const prisma = {
    session: { findUnique: mocks.mockSessionFindUnique },
    task: {
      findMany: mocks.mockTaskFindMany,
      findUnique: mocks.mockTaskFindUnique,
      update: mocks.mockTaskUpdate,
      updateMany: mocks.mockTaskUpdateMany,
      count: mocks.mockTaskCount,
    },
    message: { findMany: mocks.mockMessageFindMany, create: mocks.mockMessageCreate },
    sessionMember: { findMany: mocks.mockSessionMemberFindMany, updateMany: mocks.mockSessionMemberUpdateMany },
    // 双形态 shim：数组式（既有调用方）+ 交互式（§3.2 B2 success 路径——tx 即 prisma mock 本身）
    $transaction: (opsOrFn: unknown) =>
      typeof opsOrFn === 'function'
        ? (opsOrFn as (tx: typeof prisma) => unknown)(prisma)
        : Promise.all(opsOrFn as Promise<unknown>[]),
  }
  return { prisma }
})

vi.mock('@/lib/orchestrator', () => ({
  executeTaskBatch: mocks.mockExecuteTaskBatch,
  executeSingleAgent: mocks.mockExecuteSingleAgent,
  getOrchestratorAgent: mocks.mockGetOrchestratorAgent,
}))

vi.mock('@/lib/orchestrator/scheduler', () => ({
  enforceFileOverlap: mocks.mockEnforceFileOverlap,
}))

vi.mock('@/lib/services/shadow-git', () => ({
  getChangedFiles: mocks.mockGetChangedFiles,
  getGitSnapshot: mocks.mockGetGitSnapshot,
}))

vi.mock('@/lib/services/context-builder', () => ({
  buildContextFromHistory: mocks.mockBuildContextFromHistory,
}))

const AGENTS = [
  { id: 'a1', name: '前端工程师', systemPrompt: 'sp1', platform: 'claude-code', expertise: 'React', model: '', baseUrl: '', apiKey: 'key1', tools: '[]' },
]

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    description: '实现前端页面',
    status: 'pending',
    assignedAgentId: 'a1',
    dependencies: '[]',
    declaredFiles: '["src/app/page.tsx"]',
    cliSessionId: null,
    correctionCount: 0,
    trace: '[]',
    result: null,
    outputSchema: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    sessionId: 'sess-1',
    ...overrides,
  }
}

describe('Task 批次状态条件写（§3.2 B1-B7）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: '', permissionMode: 'default' })
    mocks.mockMessageCreate.mockResolvedValue({})
    mocks.mockTaskUpdate.mockResolvedValue({})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('B1 互斥闸门：标记条件写 count=0（另一流先赢）→ 任务剔除出批，不调 agent，重读同步', async () => {
    const { handleExecution } = await import('@/lib/services/execution')
    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])
    // 另一流已赢下 pending→in_progress 标记：条件写 count=0
    mocks.mockTaskUpdateMany.mockResolvedValue({ count: 0 })
    // 重读同步：DB 真值 = in_progress（另一流正在执行）
    mocks.mockTaskFindUnique.mockResolvedValue({ status: 'in_progress' })
    mocks.mockExecuteTaskBatch.mockResolvedValue({ results: new Map(), failedTaskIds: [] })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 任务不得进入本批执行（现状：无条件标记成功 → executeTaskBatch 收到任务 → 红）
    expect(mocks.mockExecuteTaskBatch).not.toHaveBeenCalled()
    // 重读同步内存：后续 allDone 统计不再误判
    expect(mocks.mockTaskFindUnique).toHaveBeenCalledWith({ where: { id: 'task-1' }, select: { status: true } })
    expect(task.status).toBe('in_progress')
    // 可见性：弃权必须有 warn（含任务 id）
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('task-1'))
  })

  it('B1 正常路径：条件写成功（count=1）→ 任务照常执行，且标记必须带 status 前置条件', async () => {
    const { handleExecution } = await import('@/lib/services/execution')
    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockTaskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'R', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFiles.mockReturnValue([])
    mocks.mockTaskFindUnique.mockResolvedValue({ status: 'completed' })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    expect(mocks.mockExecuteTaskBatch).toHaveBeenCalledTimes(1)
    const sent = mocks.mockExecuteTaskBatch.mock.calls[0][0] as Array<{ id: string }>
    expect(sent.map(t => t.id)).toEqual(['task-1'])
    // 标记必须是条件写（where 带 status: 'pending'）——变异锚点：去掉条件必红
    const markCall = mocks.mockTaskUpdateMany.mock.calls.find(
      c => c[0].data?.status === 'in_progress'
    )
    expect(markCall).toBeTruthy()
    expect(markCall![0].where).toEqual({ id: 'task-1', status: 'pending' })
  })

  it('B2 完成弃权：completed 条件写 count=0（任务已被 GET reset 置回 pending）→ 不写 result/member，不触发 monitoring', async () => {
    const { handleExecution } = await import('@/lib/services/execution')
    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'R', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFiles.mockReturnValue([])
    // 标记成功；completed 条件写 count=0（模拟 reset 已把任务置回 pending）
    mocks.mockTaskUpdateMany.mockImplementation(async ({ data }: { data: { status?: string } }) =>
      data?.status === 'completed' ? { count: 0 } : { count: 1 }
    )
    mocks.mockTaskFindUnique.mockResolvedValue({ status: 'pending' })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 监控不跑（现状：completed 无条件写成功 → monitoring 执行 → 红）
    expect(mocks.mockExecuteSingleAgent).not.toHaveBeenCalled()
    // SessionMember 不写新 cliSessionId（现状：事务内 member 写执行 → 红）
    expect(mocks.mockSessionMemberUpdateMany).not.toHaveBeenCalled()
    // 弃权可见
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('task-1'))
    // 内存同步到 DB 真值
    expect(task.status).toBe('pending')
    // completed 写必须带 status:'in_progress' 前置条件（变异锚点：去掉条件必红）
    const completedWrite = mocks.mockTaskUpdateMany.mock.calls.find(c => c[0].data?.status === 'completed')
    expect(completedWrite).toBeTruthy()
    expect(completedWrite![0].where).toEqual({ id: 'task-1', status: 'in_progress' })
  })

  it('B6 invalidateCliSession：expectedFrom 不匹配 → applied:false，条件写带 status 前置', async () => {
    const { invalidateCliSession } = await import('@/lib/services/cli-session')
    // 任务已被新流推进为 in_progress（不再是 completed）→ 僵尸流纠偏条件写不匹配
    mocks.mockTaskUpdateMany.mockResolvedValue({ count: 0 })

    const res = await invalidateCliSession({
      taskId: 'task-1',
      sessionId: 'sess-1',
      agentId: 'a1',
      expectedFrom: 'completed',
    })

    // 现状：无 expectedFrom 参数、无条件 task.update、返回 void（undefined）→ 全红
    expect(res).toEqual({ applied: false })
    const call = mocks.mockTaskUpdateMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'task-1', status: { in: ['completed'] } })
    expect(call.data.cliSessionId).toBeNull()
  })

  it('B6 invalidateCliSession：expectedFrom 匹配 → applied:true，两表照常清理', async () => {
    const { invalidateCliSession } = await import('@/lib/services/cli-session')
    mocks.mockTaskUpdateMany.mockResolvedValue({ count: 1 })

    const res = await invalidateCliSession({
      taskId: 'task-1',
      sessionId: 'sess-1',
      agentId: 'a1',
      expectedFrom: 'completed',
      taskData: { status: 'pending' },
    })

    expect(res).toEqual({ applied: true })
    expect(mocks.mockSessionMemberUpdateMany).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1', agentId: 'a1' },
      data: { cliSessionId: null },
    })
  })

  it('B3 failed 条件写必须带 status 前置（batchFailedIds 路径，变异锚点）', async () => {
    const { handleExecution } = await import('@/lib/services/execution')
    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map(),
      failedTaskIds: ['task-1'],
      failedTaskReasons: { 'task-1': 'boom' },
    })
    mocks.mockTaskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.mockTaskFindUnique.mockResolvedValue({ status: 'completed' })

    await handleExecution('test', 'sess-1', AGENTS, vi.fn())

    const failedWrite = mocks.mockTaskUpdateMany.mock.calls.find(c => c[0].data?.status === 'failed')
    expect(failedWrite).toBeTruthy()
    expect(failedWrite![0].where).toEqual({ id: 'task-1', status: 'in_progress' })
  })

  it('B5 blocked 复活条件写必须带 status 前置（变异锚点）', async () => {
    const { handleExecution } = await import('@/lib/services/execution')
    const blocked = makeTask({ id: 'task-1', status: 'blocked', dependencies: '["task-0"]' })
    const done = makeTask({ id: 'task-0', status: 'completed', declaredFiles: '[]' })
    mocks.mockTaskFindMany.mockResolvedValue([blocked, done])
    mocks.mockTaskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.mockExecuteTaskBatch.mockResolvedValue({ results: new Map(), failedTaskIds: [] })
    mocks.mockTaskFindUnique.mockResolvedValue({ status: 'completed' })

    await handleExecution('test', 'sess-1', AGENTS, vi.fn())

    // 复活写（blocked→pending）必须携带 blocked 前置；invalidate 类 pending 写（where.id=task-1）不在本用例场景
    const reviveWrite = mocks.mockTaskUpdateMany.mock.calls.find(
      c => c[0].data?.status === 'pending' && c[0].where?.id === 'task-1' && Object.keys(c[0].data ?? {}).length === 1
    )
    expect(reviveWrite).toBeTruthy()
    expect(reviveWrite![0].where).toEqual({ id: 'task-1', status: 'blocked' })
  })

  it('B4 blocked 级联条件写 count=0（pending 已被他人转移）→ 不级联置 blocked', async () => {
    const { handleExecution } = await import('@/lib/services/execution')
    const failed = makeTask({ id: 'task-1', description: 'D' })
    const downstream = makeTask({ id: 'task-2', dependencies: '["task-1"]' })
    mocks.mockTaskFindMany.mockResolvedValue([failed, downstream])
    // 执行失败：batch 报 task-1 failed
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map(),
      failedTaskIds: ['task-1'],
      failedTaskReasons: { 'task-1': 'boom' },
    })
    // 条件写语义：task-1 的 failed 写成功（它在本流 in_progress 内），
    // task-2 的 blocked 级联条件写 count=0（task-2 已被他人标 in_progress）
    mocks.mockTaskUpdateMany.mockImplementation(async ({ where, data }: { where: { id: string; status?: string }; data: { status?: string } }) => {
      if (where.id === 'task-2' && data?.status === 'blocked') return { count: 0 }
      return { count: 1 }
    })
    mocks.mockTaskFindUnique.mockResolvedValue({ status: 'in_progress' })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // task-2 不被置 blocked（现状：无条件写成功并发出 blocked 事件 → 红）
    const blockedEvent = sendEvent.mock.calls.find(
      c => c[0]?.type === 'task_status' && String(c[0]?.content).includes('task-2') && String(c[0]?.content).includes('blocked')
    )
    expect(blockedEvent).toBeUndefined()
    // 级联条件写必须带 status:'pending' 前置（变异锚点）
    const blockedWrite = mocks.mockTaskUpdateMany.mock.calls.find(c => c[0].data?.status === 'blocked')
    expect(blockedWrite).toBeTruthy()
    expect(blockedWrite![0].where).toEqual({ id: 'task-2', status: 'pending' })
  })
})
