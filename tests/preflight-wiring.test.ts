import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── §3.4 S3：preflight 命令红绿灯——execution.ts 接线（1A/2A/3A 拍板）──
//
// 接线语义：
//   门控 EXPERIMENT_PREFLIGHT_VERIFY=on（生产默认未设，roadmap §6）+ 任务仍 completed →
//   detectVerifyCommands(projectRoot) → runVerifyCommands → Task.trace 追加 event:'preflight'
//   （条件写 where {id, status:'completed'}，B2 纪律——纠偏/转移后弃权，任务重做会有新 completion）
//   3A：outcome 全红也不纠偏（无 status pending 写）；门控未设 → 检测/执行零调用
//
// 变异锚点：
//   - 去掉门控 → 用例 2 红
//   - 去掉 status:'completed' 前置 → 用例 1 的 where 形状断言红
//   - 把 S3 提到纠偏决策之前 → 用例 4 红（correction 路径会白跑 npm）

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
  mockDetectVerifyCommands: vi.fn().mockResolvedValue([]),
  mockRunVerifyCommands: vi.fn().mockResolvedValue([]),
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

// preflight-verify 全 mock：门控函数按 env 镜像真实语义，检测/执行为可控桩
vi.mock('@/lib/services/preflight-verify', () => ({
  isPreflightVerifyOn: () => process.env.EXPERIMENT_PREFLIGHT_VERIFY === 'on',
  detectVerifyCommands: mocks.mockDetectVerifyCommands,
  runVerifyCommands: mocks.mockRunVerifyCommands,
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

describe('preflight 命令红绿灯接线（EXPERIMENT_PREFLIGHT_VERIFY）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let tmpDir: string
  const prevMonitor = process.env.EXPERIMENT_STRUCTURED_MONITOR

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'pf-wiring-'))
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: tmpDir, permissionMode: 'default' })
    mocks.mockMessageCreate.mockResolvedValue({})
    mocks.mockTaskUpdate.mockResolvedValue({})
    mocks.mockTaskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.mockTaskFindUnique.mockResolvedValue({ status: 'completed' })
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.EXPERIMENT_PREFLIGHT_VERIFY
  })

  afterEach(() => {
    warnSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.EXPERIMENT_PREFLIGHT_VERIFY
    if (prevMonitor === undefined) delete process.env.EXPERIMENT_STRUCTURED_MONITOR
    else process.env.EXPERIMENT_STRUCTURED_MONITOR = prevMonitor
  })

  async function runHandleExecution() {
    const { handleExecution } = await import('@/lib/services/execution')
    mocks.mockTaskFindMany.mockResolvedValue([makeTask()])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'R', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: '{"needsCorrection":false}' })
    await handleExecution('test', 'sess-1', AGENTS, vi.fn())
  }

  function preflightWrite() {
    return mocks.mockTaskUpdateMany.mock.calls.find(
      c => typeof c[0].data?.trace === 'string' && c[0].data.trace.includes('"event":"preflight"'),
    )
  }

  it('门控 on + 检测到脚本 → npm run 执行 + preflight trace 条件写（where status=completed）', async () => {
    process.env.EXPERIMENT_PREFLIGHT_VERIFY = 'on'
    mocks.mockDetectVerifyCommands.mockResolvedValue(['test'])
    mocks.mockRunVerifyCommands.mockResolvedValue([
      { key: 'test', status: 'fail', exitCode: 1, durationMs: 1200 },
    ])
    await runHandleExecution()

    expect(mocks.mockDetectVerifyCommands).toHaveBeenCalledWith(tmpDir)
    expect(mocks.mockRunVerifyCommands).toHaveBeenCalledWith(tmpDir, ['test'])
    const w = preflightWrite()
    expect(w).toBeTruthy()
    // B2 纪律：条件写 where 带 status 前置（变异锚点——去掉前置此断言红）
    expect(w![0].where).toEqual({ id: 'task-1', status: 'completed' })
    // 3A：outcome 进 trace 供聚合（红也只记录）
    expect(w![0].data.trace).toContain('npm run test')
    expect(w![0].data.trace).toContain('fail')
  })

  it('门控未设（生产默认）→ 检测/执行零调用、零 preflight 写', async () => {
    delete process.env.EXPERIMENT_PREFLIGHT_VERIFY
    await runHandleExecution()
    expect(mocks.mockDetectVerifyCommands).not.toHaveBeenCalled()
    expect(mocks.mockRunVerifyCommands).not.toHaveBeenCalled()
    expect(preflightWrite()).toBeUndefined()
  })

  it('无匹配脚本（detect []）→ 不执行不写', async () => {
    process.env.EXPERIMENT_PREFLIGHT_VERIFY = 'on'
    mocks.mockDetectVerifyCommands.mockResolvedValue([])
    await runHandleExecution()
    expect(mocks.mockRunVerifyCommands).not.toHaveBeenCalled()
    expect(preflightWrite()).toBeUndefined()
  })

  it('纠偏 cycle 跳过 npm——仅收敛后的最终 completion 采数（重试上限 3 → 恰 1 次）', async () => {
    process.env.EXPERIMENT_PREFLIGHT_VERIFY = 'on'
    process.env.EXPERIMENT_STRUCTURED_MONITOR = 'on' // 结构化纠偏先行 → S1 命中即纠偏
    mocks.mockGetChangedFiles.mockReturnValue(['src/lib/other.ts']) // S1：声明文件未动
    mocks.mockDetectVerifyCommands.mockResolvedValue(['test'])
    await runHandleExecution()

    // 纠偏循环走满：3 次置 pending（MAX_CORRECTION_RETRIES），第 4 次 completion 收敛保持 completed
    const pendingWrites = mocks.mockTaskUpdateMany.mock.calls.filter(c => c[0].data?.status === 'pending')
    expect(pendingWrites.length).toBe(3)
    // 纠偏中的 cycle 全部跳过 S3（变异锚点：把 S3 提到纠偏决策前 → 每次 completion 都跑 → 此断言红）
    expect(mocks.mockRunVerifyCommands).toHaveBeenCalledTimes(1)
    // 采数落在收敛后的最终 completion 上
    expect(preflightWrite()).toBeTruthy()
  })

  it('outcome 全红也只记录不纠偏（3A：无 status pending 写）', async () => {
    process.env.EXPERIMENT_PREFLIGHT_VERIFY = 'on'
    mocks.mockDetectVerifyCommands.mockResolvedValue(['test', 'build'])
    mocks.mockRunVerifyCommands.mockResolvedValue([
      { key: 'test', status: 'fail', exitCode: 1, durationMs: 100 },
      { key: 'build', status: 'fail', exitCode: 2, durationMs: 200 },
    ])
    await runHandleExecution()

    expect(preflightWrite()).toBeTruthy()
    const pendingWrite = mocks.mockTaskUpdateMany.mock.calls.find(c => c[0].data?.status === 'pending')
    expect(pendingWrite).toBeUndefined()
  })
})
