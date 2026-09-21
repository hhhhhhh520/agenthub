import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── §3.4 monitoring 结构化——execution.ts 接线（roadmap；三梯队第 1 项 A/B 实验的触发层）──
//
// 门控语义（EXPERIMENT_STRUCTURED_MONITOR，严格相等对齐 isSeqgateOn 先例）：
//   on：结构化 verdict=correction 直接触发纠偏（复用 invalidateCliSession 统一入口，
//       expectedFrom='completed'）且 LLM 审查不跑（降级第二道）；verdict=pass → LLM 照跑（漏检率数据）
//   未设（生产默认）：纠偏仍由 LLM 驱动（现状不变），结构化信号命中仍记 Task.trace
//       event:'monitor'（反事实对比数据）
//
// 变异锚点：
//   - 去掉门控接线（on 时仍跑 LLM / 结构化无条件触发）→ 用例 1/3 红
//   - 去掉信号→纠偏复用（expectedFrom 丢失）→ 用例 1 的 where 形状断言红

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
  mockBuildMonitoringPrompt: vi.fn().mockReturnValue('monitor prompt'),
  mockEnforceFileOverlap: vi.fn(),
  mockSessionMemberFindMany: vi.fn().mockResolvedValue([]),
  mockSessionMemberUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    // 双形态 shim：数组式（invalidateCliSession）+ 交互式（success 路径 completed 条件写）
    $transaction: (opsOrFn: unknown) =>
      typeof opsOrFn === 'function'
        ? (opsOrFn as (tx: typeof prisma) => unknown)(prisma)
        : Promise.all(opsOrFn as Promise<unknown>[]),
  }
  return { prisma }
})

vi.mock('@/lib/orchestrator', () => ({
  executeTaskBatch: mocks.mockExecuteTaskBatch,
  callLLMForAnalysis: vi.fn(),
  executeSingleAgent: mocks.mockExecuteSingleAgent,
  getOrchestratorAgent: mocks.mockGetOrchestratorAgent,
}))

vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: mocks.mockBuildMonitoringPrompt,
}))

vi.mock('@/lib/orchestrator/scheduler', () => ({
  enforceFileOverlap: mocks.mockEnforceFileOverlap,
}))

vi.mock('@/lib/services/shadow-git', () => ({
  getChangedFiles: mocks.mockGetChangedFiles,
  getGitSnapshot: mocks.mockGetGitSnapshot,
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

describe('§3.4 结构化监控接线（EXPERIMENT_STRUCTURED_MONITOR）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const prevEnv = process.env.EXPERIMENT_STRUCTURED_MONITOR

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: '', permissionMode: 'default' })
    mocks.mockMessageCreate.mockResolvedValue({})
    mocks.mockTaskUpdate.mockResolvedValue({})
    mocks.mockTaskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.mockTaskFindUnique.mockResolvedValue({ status: 'completed' })
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    if (prevEnv === undefined) delete process.env.EXPERIMENT_STRUCTURED_MONITOR
    else process.env.EXPERIMENT_STRUCTURED_MONITOR = prevEnv
  })

  async function runHandleExecution() {
    const { handleExecution } = await import('@/lib/services/execution')
    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'R', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })
    return { handleExecution, task }
  }

  it('on + S1 命中（声明文件零变更）→ 结构化纠偏，LLM 不跑（降级第二道）', async () => {
    process.env.EXPERIMENT_STRUCTURED_MONITOR = 'on'
    const { handleExecution } = await runHandleExecution()
    // batch diff 非空但不含声明文件 → S1 命中
    mocks.mockGetChangedFiles.mockReturnValue(['src/lib/other.ts'])
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: '{"needsCorrection":false}' })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // LLM 审查不跑（结构化 correction 短路）
    expect(mocks.mockExecuteSingleAgent).not.toHaveBeenCalled()
    // 纠偏走统一入口：invalidateCliSession 条件写 expectedFrom='completed'（变异锚点）
    const invalidateWrite = mocks.mockTaskUpdateMany.mock.calls.find(c => c[0].data?.status === 'pending')
    expect(invalidateWrite).toBeTruthy()
    expect(invalidateWrite![0].where).toEqual({ id: 'task-1', status: { in: ['completed'] } })
    // on 臂信号命中同样记 monitor 埋点（纠偏 trace 以其基串继续，反事实样本两臂同构）
    const monitorWrite = mocks.mockTaskUpdateMany.mock.calls.find(
      c => typeof c[0].data?.trace === 'string' && c[0].data.trace.includes('"event":"monitor"')
    )
    expect(monitorWrite).toBeTruthy()
    // 纠偏消息可见
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', content: expect.stringContaining('纠偏') }))
  })

  it('on + 结构化 pass + LLM needsCorrection → LLM 第二道照常触发纠偏（漏检率数据面）', async () => {
    process.env.EXPERIMENT_STRUCTURED_MONITOR = 'on'
    const { handleExecution } = await runHandleExecution()
    // 声明文件有变更 → S1 pass；无 outputSchema → S2 pass
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx'])
    // 第 1 次 LLM 判纠偏 → 重跑后第 2 次 LLM 判通过（避免纠偏循环跑满）
    mocks.mockExecuteSingleAgent
      .mockResolvedValueOnce({ result: JSON.stringify({ needsCorrection: true, correctionNote: '缺少错误处理' }) })
      .mockResolvedValue({ result: JSON.stringify({ needsCorrection: false }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // LLM 第二道跑了：初跑监控 1 次 + 纠偏重跑后监控 1 次 = 恰 2 次
    expect(mocks.mockExecuteSingleAgent).toHaveBeenCalledTimes(2)
    // 纠偏照常触发（LLM 驱动）
    const invalidateWrite = mocks.mockTaskUpdateMany.mock.calls.find(c => c[0].data?.status === 'pending')
    expect(invalidateWrite).toBeTruthy()
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('缺少错误处理') }))
  })

  it('未设（生产默认）+ S1 命中 + LLM pass → 不纠偏（现状不变），但信号记 monitor trace（反事实数据）', async () => {
    delete process.env.EXPERIMENT_STRUCTURED_MONITOR
    const { handleExecution } = await runHandleExecution()
    mocks.mockGetChangedFiles.mockReturnValue(['src/lib/other.ts'])
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: '{"needsCorrection":false}' })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // LLM 照跑（现状）
    expect(mocks.mockExecuteSingleAgent).toHaveBeenCalledTimes(1)
    // 不纠偏（门控未设，结构化信号只记录）
    const invalidateWrite = mocks.mockTaskUpdateMany.mock.calls.find(c => c[0].data?.status === 'pending')
    expect(invalidateWrite).toBeUndefined()
    // 信号埋点：monitor trace 事件落库（条件写 where status=completed）
    const monitorWrite = mocks.mockTaskUpdateMany.mock.calls.find(
      c => typeof c[0].data?.trace === 'string' && c[0].data.trace.includes('"event":"monitor"')
    )
    expect(monitorWrite).toBeTruthy()
    expect(monitorWrite![0].where).toEqual({ id: 'task-1', status: 'completed' })
    const traceArr = JSON.parse(monitorWrite![0].data.trace)
    expect(traceArr.at(-1).event).toBe('monitor')
    expect(traceArr.at(-1).message).toContain('src/app/page.tsx')
    // 审查收编（⚠️-1 变异锚点）：埋点基串必须是 B2 落库的 successTrace——
    // 退化为内存过期 trace（缺 success 事件）时此断言红
    expect(traceArr.some(e => e.event === 'success')).toBe(true)
  })
})
