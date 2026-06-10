import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock declarations ──────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockTaskFindMany: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskCount: vi.fn(),
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockMessageCreate: vi.fn(),
  mockExecuteTaskBatch: vi.fn(),
  mockCallLLMForAnalysis: vi.fn(),
  mockGetChangedFiles: vi.fn().mockReturnValue([]),
  mockGetGitSnapshot: vi.fn().mockReturnValue(new Set()),
  mockBuildMonitoringPrompt: vi.fn().mockReturnValue('monitor prompt'),
  mockBuildContextFromHistory: vi.fn().mockReturnValue(''),
  mockEnforceFileOverlap: vi.fn(),
  mockSessionMemberFindMany: vi.fn().mockResolvedValue([]),
  mockSessionMemberUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: mocks.mockSessionFindUnique, update: mocks.mockSessionUpdate },
    task: { findMany: mocks.mockTaskFindMany, update: mocks.mockTaskUpdate, count: mocks.mockTaskCount },
    message: { findMany: mocks.mockMessageFindMany, create: mocks.mockMessageCreate },
    sessionMember: { findMany: mocks.mockSessionMemberFindMany, updateMany: mocks.mockSessionMemberUpdateMany },
  },
}))

vi.mock('@/lib/orchestrator', () => ({
  executeTaskBatch: mocks.mockExecuteTaskBatch,
  callLLMForAnalysis: mocks.mockCallLLMForAnalysis,
}))

vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: mocks.mockBuildMonitoringPrompt,
}))

vi.mock('@/lib/orchestrator/scheduler', () => ({
  enforceFileOverlap: mocks.mockEnforceFileOverlap,
}))

vi.mock('@/lib/services/git-utils', () => ({
  getChangedFiles: mocks.mockGetChangedFiles,
  getGitSnapshot: mocks.mockGetGitSnapshot,
}))

vi.mock('@/lib/services/context-builder', () => ({
  buildContextFromHistory: mocks.mockBuildContextFromHistory,
}))

const AGENTS = [
  { id: 'a1', name: '前端工程师', systemPrompt: 'sp1', platform: 'claude-code', expertise: 'React', model: 'claude-sonnet-4-6', baseUrl: '', apiKey: 'key1', tools: '[]' },
  { id: 'a2', name: '后端工程师', systemPrompt: 'sp2', platform: 'claude-code', expertise: 'Node.js', model: 'claude-sonnet-4-6', baseUrl: '', apiKey: 'key2', tools: '[]' },
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
    createdAt: new Date(),
    updatedAt: new Date(),
    sessionId: 'sess-1',
    ...overrides,
  }
}

describe('Execution — correction retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: '', permissionMode: 'default' })
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockMessageCreate.mockResolvedValue({})
  })

  it('retries task with correction note when monitoring detects issue', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])

    // First call: task succeeds, monitoring says needs correction
    // Second call: task retried and succeeds
    let callCount = 0
    mocks.mockExecuteTaskBatch.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { results: new Map([['task-1', { result: 'output v1', sessionId: 'cli-s1' }]]), failedTaskIds: [] }
      }
      return { results: new Map([['task-1', { result: 'output v2', sessionId: 'cli-s2' }]]), failedTaskIds: [] }
    })

    // Monitoring: first call needs correction, second is good
    mocks.mockCallLLMForAnalysis.mockResolvedValueOnce(JSON.stringify({
      needsCorrection: true,
      correctionNote: '缺少错误处理',
      quality: 'poor',
    })).mockResolvedValueOnce(JSON.stringify({
      needsCorrection: false,
      quality: 'good',
    }))

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // Should have executed twice (initial + retry)
    expect(mocks.mockExecuteTaskBatch).toHaveBeenCalledTimes(2)
    // Task should end as completed
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_status', content: expect.stringContaining('"completed"') })
    )
  })

  it('stops retrying after 2 corrections (熔断器)', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ correctionCount: 2 }) // Already at limit
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'output', sessionId: 'cli-s1' }]]),
      failedTaskIds: [],
    })
    // Monitoring says needs correction but count is at limit
    mocks.mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({
      needsCorrection: true,
      correctionNote: '还是有问题',
      quality: 'poor',
    }))

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // Should NOT retry (correctionCount already 2)
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('纠偏重试已达上限') })
    )
  })

  it('injects previous correction note into retried task description', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const traceWithCorrection = JSON.stringify([
      { ts: '2026-06-07T00:00:00Z', event: 'start', agent: '前端工程师' },
      { ts: '2026-06-07T00:01:00Z', event: 'correction', message: '缺少响应式布局', attempt: 1 },
    ])
    const task = makeTask({ status: 'pending', correctionCount: 1, trace: traceWithCorrection })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'fixed output', sessionId: 'cli-s1' }]]),
      failedTaskIds: [],
    })
    mocks.mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({
      needsCorrection: false, quality: 'good',
    }))

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // executeTaskBatch should receive task description with correction note prepended
    const batchCall = mocks.mockExecuteTaskBatch.mock.calls[0]
    const taskDesc = batchCall[0][0].description
    expect(taskDesc).toContain('[上次问题]')
    expect(taskDesc).toContain('缺少响应式布局')
  })
})

describe('Execution — blocked task cascading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: '', permissionMode: 'default' })
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockMessageCreate.mockResolvedValue({})
  })

  it('marks downstream tasks as blocked when dependency fails', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const tasks = [
      makeTask({ id: 'task-1', status: 'pending', dependencies: '[]', assignedAgentId: 'a1' }),
      makeTask({ id: 'task-2', status: 'pending', dependencies: '["task-1"]', assignedAgentId: 'a2' }),
    ]
    mocks.mockTaskFindMany.mockResolvedValue(tasks)

    // task-1 fails, task-2 should be blocked
    mocks.mockExecuteTaskBatch.mockRejectedValue(new Error('Agent crashed'))

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // task-1 should be failed
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task_status',
        content: expect.stringContaining('"failed"'),
      })
    )
  })

  it('does not block tasks with independent dependencies', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const tasks = [
      makeTask({ id: 'task-1', status: 'pending', dependencies: '[]', assignedAgentId: 'a1' }),
      makeTask({ id: 'task-2', status: 'pending', dependencies: '[]', assignedAgentId: 'a2' }),
      makeTask({ id: 'task-3', status: 'pending', dependencies: '["task-2"]', assignedAgentId: 'a1' }),
    ]
    mocks.mockTaskFindMany.mockResolvedValue(tasks)

    // task-1 fails, task-2 succeeds, task-3 should proceed (depends on task-2, not task-1)
    let batchCall = 0
    mocks.mockExecuteTaskBatch.mockImplementation(async () => {
      batchCall++
      if (batchCall === 1) {
        // First batch: task-1 and task-2 both ready
        // task-1 fails, task-2 succeeds
        return {
          results: new Map([['task-2', { result: 'ok', sessionId: 's2' }]]),
          failedTaskIds: ['task-1'],
        }
      }
      // Second batch: task-3 ready (task-2 completed)
      return {
        results: new Map([['task-3', { result: 'ok', sessionId: 's3' }]]),
        failedTaskIds: [],
      }
    })

    mocks.mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({
      needsCorrection: false, quality: 'good',
    }))

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // task-3 should have been executed (not blocked)
    expect(mocks.mockExecuteTaskBatch).toHaveBeenCalledTimes(2)
  })
})

describe('Execution — safety limits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: '', permissionMode: 'default' })
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockMessageCreate.mockResolvedValue({})
  })

  it('handles empty task list gracefully', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    mocks.mockTaskFindMany.mockResolvedValue([])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', content: expect.stringContaining('没有待执行的任务') })
    )
  })

  it('sets session phase to done when all tasks completed', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'done', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({
      needsCorrection: false, quality: 'good',
    }))

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    expect(mocks.mockSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { phase: 'done', phaseStep: '' } })
    )
  })
})

describe('Execution — git diff boundary detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: '/test/project', permissionMode: 'default' })
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockMessageCreate.mockResolvedValue({})
  })

  it('detects undeclared file modifications and sends warning', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '["src/app/page.tsx"]' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'done', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({
      needsCorrection: false, quality: 'good',
    }))
    // Agent modified undeclared file
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx', 'src/lib/utils.ts'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // Should send warning about undeclared modification
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text',
        content: expect.stringContaining('越界修改'),
      })
    )
  })

  it('no warning when only declared files are modified', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '["src/app/page.tsx"]' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'done', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockCallLLMForAnalysis.mockResolvedValue(JSON.stringify({
      needsCorrection: false, quality: 'good',
    }))
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // Should NOT contain "越界修改"
    const allCalls = sendEvent.mock.calls.map(c => c[0].content)
    expect(allCalls.some(c => c.includes('越界修改'))).toBe(false)
  })
})
