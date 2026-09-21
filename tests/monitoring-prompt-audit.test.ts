import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 监控 prompt 审计诚实性——buildMonitoringPrompt 的 audit.declared 必须是"真实交集"──
//
// 缺陷（2026-09-21 monitor A/B 实验安全审查发现）：execution.ts 监控分支传
// { declared: declaredFiles, undeclared }——"实际修改的声明文件"一栏填的是声明清单本身
// 而非 declared∩changed 真实交集。ghost 场景（声明文件未动、只写了杂散文件）下，
// 审查 LLM 被 prompt 谎报"声明文件已全部修改"，系统性压低其对 S1 类缺陷的检出，
// 使结构化 vs LLM 的 A/B 比较带偏置（偏向结构化）。
//
// 修法：声明交集（attributed，与完成消息同源计算）提升作用域后传入 audit.declared。
//
// 变异锚点：把传参退化回 declaredFiles（声明清单）→ 用例 1 红。

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

describe('监控 prompt 审计诚实性（audit.declared = 真实交集）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const prevEnv = process.env.EXPERIMENT_STRUCTURED_MONITOR
  // fs 隔离（审查建议）：projectDir 用临时目录——projectDir:'' 会触发 cwd 回退，
  // cleanupUndeclared 的真实 unlink 将落在"cwd 下恰好不存在同名文件"的隐式依赖上
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'mon-audit-'))
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: tmpDir, permissionMode: 'default' })
    mocks.mockMessageCreate.mockResolvedValue({})
    mocks.mockTaskUpdate.mockResolvedValue({})
    mocks.mockTaskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.mockTaskFindUnique.mockResolvedValue({ status: 'completed' })
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.EXPERIMENT_STRUCTURED_MONITOR
    else process.env.EXPERIMENT_STRUCTURED_MONITOR = prevEnv
  })

  async function runGhostScenario(changedFiles: string[]) {
    delete process.env.EXPERIMENT_STRUCTURED_MONITOR // 生产默认臂：LLM 审照跑，prompt 必被构建
    const { handleExecution } = await import('@/lib/services/execution')
    mocks.mockTaskFindMany.mockResolvedValue([makeTask()])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'R', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFiles.mockReturnValue(changedFiles)
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: '{"needsCorrection":false}' })
    await handleExecution('test', 'sess-1', AGENTS, vi.fn())
    expect(mocks.mockBuildMonitoringPrompt).toHaveBeenCalled()
    return mocks.mockBuildMonitoringPrompt.mock.calls[0][3] as { declared: string[]; undeclared: string[] }
  }

  it('ghost 场景（声明文件未动，只写杂散文件）→ audit.declared 为空（不谎报声明已修改）', async () => {
    const audit = await runGhostScenario(['src/lib/other.ts'])
    // undeclared 为空是既有设计（cleanupUndeclared 先于审查 splice 清空，execution.ts:51-52——
    // 越界文件已清理，不喂给审查防纠偏重试）；谎言只在 declared 一栏
    expect(audit.undeclared).toEqual([])
    // 缺陷现状：declared = ['src/app/page.tsx']（声明清单）→ 谎报"实际修改" → 此断言红
    expect(audit.declared).toEqual([])
  })

  it('命中场景（声明文件确实修改）→ audit.declared 为真实交集', async () => {
    const audit = await runGhostScenario(['src/app/page.tsx'])
    expect(audit.declared).toEqual(['src/app/page.tsx'])
    expect(audit.undeclared).toEqual([])
  })

  it('部分命中（声明 2 文件只动了 1 个）→ audit.declared 只含真实触达的', async () => {
    const { handleExecution } = await import('@/lib/services/execution')
    delete process.env.EXPERIMENT_STRUCTURED_MONITOR
    mocks.mockTaskFindMany.mockResolvedValue([
      makeTask({ declaredFiles: '["src/app/page.tsx","src/app/layout.tsx"]' }),
    ])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'R', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx'])
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: '{"needsCorrection":false}' })
    await handleExecution('test', 'sess-1', AGENTS, vi.fn())
    expect(mocks.mockBuildMonitoringPrompt).toHaveBeenCalled()
    const audit = mocks.mockBuildMonitoringPrompt.mock.calls[0][3] as { declared: string[] }
    expect(audit.declared).toEqual(['src/app/page.tsx'])
  })
})
