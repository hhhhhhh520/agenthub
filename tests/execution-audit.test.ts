import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Batch 1: 审计三态 + 批次级归责 + 审计通过前禁止成功 ──
//
// 核心契约：
// - 批次开始快照失败 → 本批不执行，任务 failed + trace audit_unavailable；
// - 批次结束 diff 失败 → 本批任务 failed，不写 result/completed，不跑监控/不 done；
// - 敏感路径按“本批 declaredFiles 并集”归责，未声明的敏感文件 → 整批失败；
// - 普通未声明文件只告警，共享 projectDir 绝不自动删除；
// - 审计通过前不写 Task.result / completed。

const mocks = vi.hoisted(() => {
  const mockTaskUpdate = vi.fn()
  const mockTaskUpdateMany = vi.fn().mockImplementation(async ({ where, data }: { where?: { id?: string }; data?: Record<string, unknown> }) => {
    mockTaskUpdate({ where: { id: where?.id }, data })
    return { count: 1 }
  })
  return {
    mockSessionFindUnique: vi.fn(),
    mockSessionUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
    mockTaskFindMany: vi.fn(),
    mockTaskFindUnique: vi.fn(),
    mockTaskUpdate,
    mockTaskUpdateMany,
    mockMessageCreate: vi.fn().mockResolvedValue({}),
    mockSessionMemberFindMany: vi.fn().mockResolvedValue([]),
    mockSessionMemberUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
    mockExecuteTaskBatch: vi.fn(),
    mockExecuteSingleAgent: vi.fn().mockResolvedValue({ result: '{"needsCorrection":false}' }),
    mockGetOrchestratorAgent: vi.fn().mockResolvedValue({ platform: 'claude-code', model: 'test', baseUrl: '', apiKey: 'sk' }),
    mockGetChangedFilesDetailed: vi.fn(),
    mockGetGitSnapshotDetailed: vi.fn(),
    mockBuildMonitoringPrompt: vi.fn().mockReturnValue('monitor prompt'),
    mockEnforceFileOverlap: vi.fn(),
  }
})

vi.mock('@/lib/db', () => {
  const prisma = {
    session: { findUnique: mocks.mockSessionFindUnique, updateMany: mocks.mockSessionUpdateMany },
    task: {
      findMany: mocks.mockTaskFindMany,
      findUnique: mocks.mockTaskFindUnique,
      update: mocks.mockTaskUpdate,
      updateMany: mocks.mockTaskUpdateMany,
    },
    message: { create: mocks.mockMessageCreate },
    sessionMember: {
      findMany: mocks.mockSessionMemberFindMany,
      updateMany: mocks.mockSessionMemberUpdateMany,
    },
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

vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: mocks.mockBuildMonitoringPrompt,
}))

vi.mock('@/lib/orchestrator/scheduler', () => ({
  enforceFileOverlap: mocks.mockEnforceFileOverlap,
}))

vi.mock('@/lib/services/shadow-git', () => ({
  getGitSnapshotDetailed: mocks.mockGetGitSnapshotDetailed,
  getChangedFilesDetailed: mocks.mockGetChangedFilesDetailed,
}))

const AGENTS = [
  { id: 'a1', name: '前端工程师', systemPrompt: 'sp', platform: 'claude-code', expertise: 'React', model: '', baseUrl: '', apiKey: 'key1', tools: '[]' },
]

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    description: '实现功能',
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

const completedWrites = () => mocks.mockTaskUpdate.mock.calls.filter(
  c => c[0]?.data?.status === 'completed'
)
const failedWrites = () => mocks.mockTaskUpdate.mock.calls.filter(
  c => c[0]?.data?.status === 'failed'
)

describe('execution batch audit — tri-state / attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({
      id: 'sess-1', projectDir: '', permissionMode: 'default', phase: 'execution', phaseStep: '',
    })
    mocks.mockSessionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.mockTaskUpdate.mockResolvedValue({})
    mocks.mockMessageCreate.mockResolvedValue({})
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: '{"needsCorrection":false}' })
    mocks.mockGetGitSnapshotDetailed.mockReturnValue({ ok: true, files: new Set() })
    mocks.mockGetChangedFilesDetailed.mockReturnValue({ ok: true, files: [] })
  })

  it('P1-02: 主批次映射保留 Agent tools 白名单', async () => {
    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'ok', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })
    mocks.mockGetGitSnapshotDetailed.mockReturnValue({ ok: true, files: new Set(), evidence: new Map() })
    mocks.mockGetChangedFilesDetailed.mockReturnValue({ ok: true, files: [] })

    const agents = [{ ...AGENTS[0], tools: '["Read","Grep"]' }]
    const { handleExecution } = await import('@/lib/services/execution')
    await handleExecution('test', 'sess-1', agents, vi.fn())

    const batchAgents = mocks.mockExecuteTaskBatch.mock.calls[0][1] as Array<{ tools?: string }>
    expect(batchAgents[0].tools).toBe('["Read","Grep"]')
  })

  it('批次审计把内容证据 Map 传给 diff（不是旧路径 Set）', async () => {
    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'ok', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })
    const evidence = new Map<string, string | null>([['src/app/page.tsx', 'hash-before']])
    mocks.mockGetGitSnapshotDetailed.mockReturnValue({ ok: true, files: new Set(), evidence })
    mocks.mockGetChangedFilesDetailed.mockReturnValue({ ok: true, files: [] })

    const { handleExecution } = await import('@/lib/services/execution')
    await handleExecution('test', 'sess-1', AGENTS, vi.fn())

    const auditCall = mocks.mockGetChangedFilesDetailed.mock.calls[0]
    expect(auditCall[2]).toBeInstanceOf(Map)
    expect((auditCall[2] as Map<string, string | null>).get('src/app/page.tsx')).toBe('hash-before')
  })

  it('批次开始快照失败 → 不执行本批，任务 failed + audit_unavailable，下游 blocked', async () => {
    const upstream = makeTask({ id: 'task-1', description: '上游' })
    const downstream = makeTask({ id: 'task-2', description: '下游', dependencies: '["task-1"]' })
    mocks.mockTaskFindMany.mockResolvedValue([upstream, downstream])
    mocks.mockGetGitSnapshotDetailed.mockReturnValue({ ok: false, reason: 'git executable missing' })

    const sendEvent = vi.fn()
    const { handleExecution } = await import('@/lib/services/execution')
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    expect(mocks.mockExecuteTaskBatch).not.toHaveBeenCalled()
    expect(completedWrites()).toHaveLength(0)
    const upstreamFail = mocks.mockTaskUpdate.mock.calls.find(c => c[0]?.where?.id === 'task-1' && c[0]?.data?.status === 'failed')
    expect(upstreamFail).toBeDefined()
    expect(String(upstreamFail![0].data.trace)).toContain('audit_unavailable')
    const downstreamBlocked = mocks.mockTaskUpdate.mock.calls.find(c => c[0]?.where?.id === 'task-2' && c[0]?.data?.status === 'blocked')
    expect(downstreamBlocked).toBeDefined()
    expect(sendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_status', content: expect.stringContaining('"completed"') })
    )
  })

  it('批次结束 diff 失败 → 执行过也不发布成功：无 result/completed，下游 blocked', async () => {
    const t1 = makeTask({ id: 'task-1', description: '任务一' })
    const t2 = makeTask({ id: 'task-2', description: '任务二' })
    const downstream = makeTask({ id: 'task-3', description: '下游', dependencies: '["task-1"]' })
    mocks.mockTaskFindMany.mockResolvedValue([t1, t2, downstream])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([
        ['task-1', { result: 'output-1', sessionId: 'cli-1' }],
        ['task-2', { result: 'output-2', sessionId: 'cli-2' }],
      ]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFilesDetailed.mockReturnValue({ ok: false, reason: 'git diff timed out' })

    const sendEvent = vi.fn()
    const { handleExecution } = await import('@/lib/services/execution')
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    expect(mocks.mockExecuteTaskBatch).toHaveBeenCalledTimes(1)
    expect(completedWrites()).toHaveLength(0)
    expect(mocks.mockTaskUpdate.mock.calls.some(c => c[0]?.data && Object.hasOwn(c[0].data, 'result'))).toBe(false)
    const failed = failedWrites()
    expect(failed.some(c => c[0]?.where?.id === 'task-1')).toBe(true)
    expect(failed.some(c => c[0]?.where?.id === 'task-2')).toBe(true)
    expect(failed.every(c => String(c[0].data.trace).includes('audit_unavailable'))).toBe(true)
    const downstreamBlocked = mocks.mockTaskUpdate.mock.calls.find(c => c[0]?.where?.id === 'task-3' && c[0]?.data?.status === 'blocked')
    expect(downstreamBlocked).toBeDefined()
    expect(mocks.mockExecuteSingleAgent).not.toHaveBeenCalled() // 审计失败不跑 monitoring
    expect(mocks.mockSessionUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { phase: 'done', phaseStep: '' } })
    )
  })

  it('批次级归责：A 声明 package.json、B 声明 foo.ts → 不把 A 的文件误判成 B 的敏感越界', async () => {
    const t1 = makeTask({ id: 'task-1', description: '改依赖', declaredFiles: '["package.json"]' })
    const t2 = makeTask({ id: 'task-2', description: '改页面', declaredFiles: '["foo.ts"]' })
    mocks.mockTaskFindMany.mockResolvedValue([t1, t2])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([
        ['task-1', { result: 'dep done', sessionId: 'cli-1' }],
        ['task-2', { result: 'page done', sessionId: 'cli-2' }],
      ]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFilesDetailed.mockReturnValue({ ok: true, files: ['package.json', 'foo.ts'] })

    const { handleExecution } = await import('@/lib/services/execution')
    await handleExecution('test', 'sess-1', AGENTS, vi.fn())

    expect(failedWrites()).toHaveLength(0)
    const completed = completedWrites()
    expect(completed.some(c => c[0]?.where?.id === 'task-1')).toBe(true)
    expect(completed.some(c => c[0]?.where?.id === 'task-2')).toBe(true)
  })

  it('批次级敏感越界：未声明 .env → 整批 failed，不写 result/completed', async () => {
    const t1 = makeTask({ id: 'task-1', description: '改依赖', declaredFiles: '["package.json"]' })
    const t2 = makeTask({ id: 'task-2', description: '改页面', declaredFiles: '["foo.ts"]' })
    mocks.mockTaskFindMany.mockResolvedValue([t1, t2])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([
        ['task-1', { result: 'dep done', sessionId: 'cli-1' }],
        ['task-2', { result: 'page done', sessionId: 'cli-2' }],
      ]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFilesDetailed.mockReturnValue({ ok: true, files: ['package.json', 'foo.ts', '.env'] })

    const sendEvent = vi.fn()
    const { handleExecution } = await import('@/lib/services/execution')
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    expect(completedWrites()).toHaveLength(0)
    expect(mocks.mockTaskUpdate.mock.calls.some(c => c[0]?.data && Object.hasOwn(c[0].data, 'result'))).toBe(false)
    const failed = failedWrites()
    expect(failed.some(c => c[0]?.where?.id === 'task-1')).toBe(true)
    expect(failed.some(c => c[0]?.where?.id === 'task-2')).toBe(true)
    expect(failed.every(c => String(c[0].data.trace).includes('敏感路径越界'))).toBe(true)
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('敏感路径越界') })
    )
    expect(sendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_status', content: expect.stringContaining('"completed"') })
    )
    expect(mocks.mockExecuteSingleAgent).not.toHaveBeenCalled() // 敏感越界不跑 monitoring
    expect(mocks.mockSessionUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { phase: 'done', phaseStep: '' } })
    )
  })
})
