// contract v1 §1.1: task.result 持久化测试
// 验证三个核心场景：
//   1. task 跑完后 result 字段写入 DB
//   2. 重启 orchestrator 后能从 DB 读到旧 result
//   3. 跨批：batch 1 完成后，batch 2 依赖任务能查到 batch 1 的 result
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma
const {
  mockTaskFindMany,
  mockTaskUpdate,
  mockTaskUpdateMany,
  mockSessionFindUnique,
  mockSessionUpdate,
  mockMessageFindMany,
  mockMessageCreate,
  mockSessionMemberFindMany,
  mockSessionMemberUpdateMany,
} = vi.hoisted(() => ({
  mockTaskFindMany: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskUpdateMany: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockMessageFindMany: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockSessionMemberFindMany: vi.fn(),
  mockSessionMemberUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: {
      findMany: mockTaskFindMany,
      update: mockTaskUpdate,
      updateMany: mockTaskUpdateMany,
    },
    session: {
      findUnique: mockSessionFindUnique,
      update: mockSessionUpdate,
    },
    message: {
      findMany: mockMessageFindMany,
      create: mockMessageCreate,
    },
    sessionMember: {
      findMany: mockSessionMemberFindMany,
      updateMany: mockSessionMemberUpdateMany,
    },
    // F10:execution.ts success 路径用 $transaction 包两表
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}))

vi.mock('@/lib/orchestrator', () => ({
  executeTaskBatch: vi.fn(),
  callLLMForAnalysis: vi.fn(),
  executeSingleAgent: vi.fn().mockResolvedValue({ result: '{}', sessionId: 'cli-orch' }),
  getOrchestratorAgent: vi.fn().mockResolvedValue({ platform: 'claude-code', model: '', baseUrl: '', apiKey: '' }),
}))

vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: vi.fn().mockReturnValue(''),
}))

vi.mock('@/lib/orchestrator/scheduler', () => ({
  enforceFileOverlap: vi.fn(),
}))

vi.mock('@/lib/services/shadow-git', () => ({
  getChangedFiles: vi.fn().mockReturnValue([]),
  getGitSnapshot: vi.fn().mockReturnValue(new Set()),
}))

vi.mock('@/lib/services/context-builder', () => ({
  buildContextFromHistory: vi.fn().mockReturnValue(''),
}))

import { handleExecution } from '@/lib/services/execution'
import { executeTaskBatch } from '@/lib/orchestrator'

describe('contract v1 §1.1: task.result 持久化', () => {
  const mockSendEvent = vi.fn()
  const mockAgents = [
    { id: 'a1', name: 'agent1', systemPrompt: '', platform: 'claude-code', expertise: '', model: '', baseUrl: '', apiKey: '', tools: '[]' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockMessageFindMany.mockResolvedValue([])
    mockMessageCreate.mockResolvedValue({})
    mockSessionUpdate.mockResolvedValue({})
    mockSessionFindUnique.mockResolvedValue({ projectDir: '', permissionMode: 'default' })
    mockSessionMemberFindMany.mockResolvedValue([])
    mockSessionMemberUpdateMany.mockResolvedValue({ count: 0 })
    mockTaskUpdate.mockResolvedValue({})
  })

  it('task 跑完后 result 字段被写入 DB（非空）', async () => {
    const tasks = [
      { id: 't1', description: 'task 1', status: 'pending', assignedAgentId: 'a1', sessionId: 's1', dependencies: '[]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null, result: null },
    ]
    mockTaskFindMany.mockResolvedValueOnce(tasks)
    ;(executeTaskBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: new Map([['t1', { result: 'this is the actual task output', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })

    await handleExecution('msg', 's1', mockAgents, mockSendEvent)

    // 找出 t1 → completed 的 update 调用
    const completedCall = mockTaskUpdate.mock.calls.find(
      (call: any[]) => call[0].where.id === 't1' && call[0].data.status === 'completed'
    )
    expect(completedCall, 'should persist t1 as completed').toBeDefined()
    expect(completedCall![0].data.result).toBe('this is the actual task output')
    expect(completedCall![0].data.result).not.toBeNull()
    expect(completedCall![0].data.result.length).toBeGreaterThan(0)
  })

  it('重启 orchestrator 后能从 DB 读到旧 task 的 result（作为跨批 priorResults 传入）', async () => {
    // 模拟"重启场景"：t1 已 completed（result 在 DB 中），t2 待执行依赖 t1
    const tasks = [
      { id: 't1', description: 'task 1', status: 'completed', assignedAgentId: 'a1', sessionId: 's1', dependencies: '[]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null, result: 'persisted result from previous run' },
      { id: 't2', description: 'task 2', status: 'pending', assignedAgentId: 'a1', sessionId: 's1', dependencies: '["t1"]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null, result: null },
    ]
    mockTaskFindMany.mockResolvedValueOnce(tasks)
    ;(executeTaskBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: new Map([['t2', { result: 't2 output', sessionId: 'cli-2' }]]),
      failedTaskIds: [],
    })

    await handleExecution('msg', 's1', mockAgents, mockSendEvent)

    // 验证 executeTaskBatch 收到了 priorResults，且里面有 t1 的 result
    expect(executeTaskBatch).toHaveBeenCalled()
    const callArgs = (executeTaskBatch as ReturnType<typeof vi.fn>).mock.calls[0]
    // 第 6 个参数（index 5）是 priorResults
    const priorResults = callArgs[5] as Map<string, string>
    expect(priorResults).toBeInstanceOf(Map)
    expect(priorResults.get('t1')).toBe('persisted result from previous run')
  })

  it('跨批场景：batch 1 完成写 DB 后，batch 2 依赖任务能查到 batch 1 的 result', async () => {
    // 第 1 轮：t1 pending → 跑完 → 写 DB
    // 第 2 轮：t2 pending 依赖 t1（已 completed） → priorResults 包含 t1
    const tasks = [
      { id: 't1', description: 'task 1', status: 'pending', assignedAgentId: 'a1', sessionId: 's1', dependencies: '[]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null, result: null },
      { id: 't2', description: 'task 2', status: 'pending', assignedAgentId: 'a1', sessionId: 's1', dependencies: '["t1"]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null, result: null },
    ]
    mockTaskFindMany.mockResolvedValueOnce(tasks)

    // 在每次 executeTaskBatch 调用时快照 priorResults，避免 Map 被后续调用改写造成误判
    const priorResultsSnapshots: Array<Record<string, string>> = []
    ;(executeTaskBatch as ReturnType<typeof vi.fn>).mockImplementationOnce(async (..._args: any[]) => {
      const prior = _args[5] as Map<string, string>
      priorResultsSnapshots.push(Object.fromEntries(prior))
      return {
        results: new Map([['t1', { result: 'batch1 t1 output', sessionId: 'cli-1' }]]),
        failedTaskIds: [],
      }
    })
    ;(executeTaskBatch as ReturnType<typeof vi.fn>).mockImplementationOnce(async (..._args: any[]) => {
      const prior = _args[5] as Map<string, string>
      priorResultsSnapshots.push(Object.fromEntries(prior))
      return {
        results: new Map([['t2', { result: 'batch2 t2 output', sessionId: 'cli-2' }]]),
        failedTaskIds: [],
      }
    })

    await handleExecution('msg', 's1', mockAgents, mockSendEvent)

    // 验证调用了两次 executeTaskBatch
    expect(executeTaskBatch).toHaveBeenCalledTimes(2)

    // 第 1 次：priorResults 为空（t1 待跑、t2 待跑且依赖未完成）
    expect(priorResultsSnapshots[0]).toEqual({})

    // 第 2 次：priorResults 应包含 t1（本进程内 allResults 累积了 t1 的结果）
    expect(priorResultsSnapshots[1].t1).toBe('batch1 t1 output')

    // 同时验证 t1 的 result 被持久化到 DB
    const t1Completed = mockTaskUpdate.mock.calls.find(
      (call: any[]) => call[0].where.id === 't1' && call[0].data.status === 'completed'
    )
    expect(t1Completed![0].data.result).toBe('batch1 t1 output')
  })
})
