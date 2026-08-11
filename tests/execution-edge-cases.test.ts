import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

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
  mockExecuteSingleAgent: vi.fn(),
  mockGetOrchestratorAgent: vi.fn().mockResolvedValue({ platform: 'claude-code', model: 'test', baseUrl: '', apiKey: 'sk' }),
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
    // ⚠️-C2 修复:$transaction 接 promise 数组,逐项 await
    // mock prisma 不能用 prisma.task.update(...) 形式拿"延迟 promise",
    // 因为 .update() 已经立即 invoke mockTaskUpdate 了。
    // 所以测试里调用 prisma.$transaction([prisma.task.update(...), ...])
    // 等价于"逐项调 fn,收集 promise,然后 await all"——这正是 mock 行为
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}))

vi.mock('@/lib/orchestrator', () => ({
  executeTaskBatch: mocks.mockExecuteTaskBatch,
  callLLMForAnalysis: mocks.mockCallLLMForAnalysis,
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
    mocks.mockExecuteSingleAgent.mockResolvedValueOnce({ result: JSON.stringify({
      needsCorrection: true,
      correctionNote: '缺少错误处理',
      quality: 'poor',
    }) }).mockResolvedValueOnce({ result: JSON.stringify({
      needsCorrection: false,
      quality: 'good',
    }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // Should have executed twice (initial + retry)
    expect(mocks.mockExecuteTaskBatch).toHaveBeenCalledTimes(2)
    // Task should end as completed
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_status', content: expect.stringContaining('"completed"') })
    )
  })

  it('stops retrying after 3 corrections (熔断器, P2 合一 max 3)', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ correctionCount: 3 }) // Already at limit (max 3)
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'output', sessionId: 'cli-s1' }]]),
      failedTaskIds: [],
    })
    // Monitoring says needs correction but count is at limit
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
      needsCorrection: true,
      correctionNote: '还是有问题',
      quality: 'poor',
    }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // Should NOT retry (correctionCount already 3)
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('纠偏重试已达上限') })
    )
  })

  it('P2 回归守卫: correctionCount=2 时第 3 次仍会重试（上限从 2 合一为 3）', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ correctionCount: 2 }) // 已用 2 次，max 3 下应继续第 3 次
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'output', sessionId: 'cli-s1' }]]),
      failedTaskIds: [],
    })
    // Monitoring 判 needsCorrection → 应置 pending 重试(attempt 3)，不是已达上限
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
      needsCorrection: true,
      correctionNote: '还是有问题',
      quality: 'poor',
    }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 应发出 pending 重试事件且 retryCount=3
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_status', content: expect.stringContaining('"status":"pending"') })
    )
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_status', content: expect.stringContaining('"retryCount":3') })
    )
  })

  it('P2 回归守卫: 单任务连续 needsCorrection 4 轮后熔断为 completed（MAX_ITERATIONS 随 max 3 联动）', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ correctionCount: 0 }) // 从 0 自然增长：初跑 + 3 次纠偏 = 4 轮
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'output', sessionId: 'cli-s1' }]]),
      failedTaskIds: [],
    })
    // Monitoring 每次都 needsCorrection，走完 count 0→1→2→3，第 4 轮熔断
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
      needsCorrection: true,
      correctionNote: '还是要重写',
      quality: 'poor',
    }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 第 4 轮应收到熔断消息（旧 MAX_ITERATIONS=*3 会在第 3 轮截断，收不到）
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('纠偏重试已达上限') })
    )
    // 任务最终 completed，不滞留 pending 等下次调用再烧一次执行
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_status', content: expect.stringContaining('"status":"completed"') })
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
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
      needsCorrection: false, quality: 'good',
    }) })

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

    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
      needsCorrection: false, quality: 'good',
    }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // task-3 should have been executed (not blocked)
    expect(mocks.mockExecuteTaskBatch).toHaveBeenCalledTimes(2)
  })

  it('ISSUE-011 F1: propagates real batch failure reason to trace and SSE', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])

    // 批内失败(非整体 throw):failedTaskIds + 平行原因映射
    const realReason = 'CLI exited with code=1, stderr='
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map(),
      failedTaskIds: ['task-1'],
      failedTaskReasons: { 'task-1': realReason },
    })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 1. trace 里 error 事件带真实原因,而不是通用串
    const failCall = mocks.mockTaskUpdate.mock.calls.find((c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'failed')
    expect(failCall, 'should have a failed update for task-1').toBeDefined()
    const failTrace = JSON.parse(failCall![0].data.trace)
    const errorEvent = failTrace.find((e: any) => e.event === 'error')
    expect(errorEvent.message).toBe(realReason)
    expect(errorEvent.message).not.toBe('Task failed in batch execution')

    // 2. SSE 也收到真实原因
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text',
        content: expect.stringContaining(realReason),
      })
    )

    // 3. 失败原因持久化进聊天历史(不被结尾 done 事件刷掉)
    expect(mocks.mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: 'orchestrator',
          rawContent: expect.stringContaining(realReason),
        }),
      })
    )
  })

  it('ISSUE-011 F2: partial failure sends redo hint and truthful done event', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    // task-1 fails, task-2 blocked (dep task-1), task-3 stays pending (dep task-2)
    const tasks = [
      makeTask({ id: 'task-1', status: 'pending', dependencies: '[]', assignedAgentId: 'a1' }),
      makeTask({ id: 'task-2', status: 'pending', dependencies: '["task-1"]', assignedAgentId: 'a2' }),
      makeTask({ id: 'task-3', status: 'pending', dependencies: '["task-2"]', assignedAgentId: 'a1' }),
    ]
    mocks.mockTaskFindMany.mockResolvedValue(tasks)
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map(),
      failedTaskIds: ['task-1'],
      failedTaskReasons: { 'task-1': 'CLI crash' },
    })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    const textContents = sendEvent.mock.calls.map(c => c[0].content).filter((c: string) => typeof c === 'string')
    // 1. 收尾消息含失败统计 + redo 提示(此前静默停在 execution 无提示)
    expect(textContents.some(c => c.includes('1 个任务失败') && c.includes('可点击 redo 重试'))).toBe(true)
    // 2. pending 遗留合并为"未完成",不报误导性的"执行中"(中断后无东西在执行)
    expect(textContents.some(c => c.includes('1 个任务未完成'))).toBe(true)
    expect(textContents.some(c => c.includes('执行中'))).toBe(false)
    // 3. done 事件不谎报"所有任务已完成"
    expect(textContents.some(c => c === '所有任务已完成')).toBe(false)
    const doneEvent = sendEvent.mock.calls.map(c => c[0]).find(e => e.type === 'done')
    expect(doneEvent?.content).toContain('1 个失败')
  })
})

describe('Execution — safety limits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: '', permissionMode: 'default' })
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockMessageCreate.mockResolvedValue({})
  })

  it('breaks loop and sends error when globalDeadline exceeded', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask()
    mocks.mockTaskFindMany.mockResolvedValue([task])

    // executeTaskBatch should not be called if deadline is already passed
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'done', sessionId: 's1' }]]),
      failedTaskIds: [],
    })

    const sendEvent = vi.fn()
    // Pass a deadline that's already in the past
    await handleExecution('test', 'sess-1', AGENTS, sendEvent, undefined, Date.now() - 1000)

    // Should send timeout error
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        content: expect.stringContaining('超时'),
      })
    )

    // Should NOT call executeTaskBatch (deadline already passed)
    expect(mocks.mockExecuteTaskBatch).not.toHaveBeenCalled()
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
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
      needsCorrection: false, quality: 'good',
    }) })

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

  it('detects undeclared file modifications and cleans up', async () => {
    // 创建临时目录和越界文件
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-test-'))
    const orphanFile = path.join(tmpDir, 'src', 'lib', 'utils.ts')
    fs.mkdirSync(path.dirname(orphanFile), { recursive: true })
    fs.writeFileSync(orphanFile, '// orphan file')

    try {
      const { handleExecution } = await import('@/lib/services/execution')

      // 使用临时目录作为 projectDir
      mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: tmpDir, permissionMode: 'default' })

      const task = makeTask({ declaredFiles: '["src/app/page.tsx"]' })
      mocks.mockTaskFindMany.mockResolvedValue([task])
      mocks.mockExecuteTaskBatch.mockResolvedValue({
        results: new Map([['task-1', { result: 'done', sessionId: 's1' }]]),
        failedTaskIds: [],
      })
      mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
        needsCorrection: false, quality: 'good',
      }) })
      // Agent modified declared file + undeclared file
      mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx', 'src/lib/utils.ts'])

      const sendEvent = vi.fn()
      await handleExecution('test', 'sess-1', AGENTS, sendEvent)

      // 越界文件应被清理
      expect(fs.existsSync(orphanFile)).toBe(false)

      // 应发送越界警告（包含清理信息）
      const allTextEvents = sendEvent.mock.calls.map(c => c[0].content).filter(Boolean)
      expect(allTextEvents.some(c => typeof c === 'string' && c.includes('越界警告'))).toBe(true)
      // 不应发送敏感路径越界（因为 utils.ts 不是敏感文件）
      expect(allTextEvents.some(c => typeof c === 'string' && c.includes('敏感路径越界'))).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('no warning when only declared files are modified', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '["src/app/page.tsx"]' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'done', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
      needsCorrection: false, quality: 'good',
    }) })
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // Should NOT contain "越界修改"
    const allCalls = sendEvent.mock.calls.map(c => c[0].content)
    expect(allCalls.some(c => c.includes('越界修改'))).toBe(false)
    // ISSUE-011 F3: 声明∩变更的文件仍应列出(不过度抑制)
    expect(allCalls.some(c => c.includes('修改了 src/app/page.tsx'))).toBe(true)
  })

  it('ISSUE-011 F3: completion message does not misattribute sibling batch files', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    // PRD/文档类任务:无声明文件(declaredFiles=[])→跳过文件校验,此前 completion
    // 消息会把 batch 级 changedFiles(含同批其他任务的文件)串报成自己的
    const task = makeTask({ id: 'task-1', status: 'pending', declaredFiles: '[]', assignedAgentId: 'a1' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'PRD done', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
      needsCorrection: false, quality: 'good',
    }) })
    // batch 级 changedFiles:含同批其他任务(存储层)的文件——这正是实测"PRD 任务报 src/store.ts"的来源
    mocks.mockGetChangedFiles.mockReturnValue(['src/store.ts', 'src/types.ts'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    const completionMsgs = sendEvent.mock.calls
      .map(c => c[0].content)
      .filter((c: string) => typeof c === 'string' && c.includes('任务 task-1 完成'))
    expect(completionMsgs.length).toBeGreaterThan(0)
    // 无声明文件的任务完成消息不得列同批其他任务的文件
    expect(completionMsgs.join(' ')).not.toContain('src/store.ts')
    expect(completionMsgs.join(' ')).not.toContain('src/types.ts')
  })

  // ─── contract v1 §1.2 b 动作 6: declaredFiles 分级校验 ───
  it('[动作 6] 敏感路径越界(.env)→ 任务硬失败,状态写 failed,不写 result', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '["src/app/page.tsx"]' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'agent output', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    // Agent 偷偷改了 .env
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx', '.env'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 应该 update 为 failed 状态(不是 completed)
    const failedUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'failed'
    )
    expect(failedUpdate).toBeDefined()
    // failed update 里不应该写 result(避免污染下游 priorResults)
    expect(failedUpdate![0].data.result).toBeUndefined()
    // 不应该有 completed update
    const completedUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'completed'
    )
    expect(completedUpdate).toBeUndefined()

    // sendEvent 应该报告敏感越界
    const allTextEvents = sendEvent.mock.calls.map(c => c[0].content).filter(Boolean)
    expect(allTextEvents.some(c => typeof c === 'string' && c.includes('敏感路径越界'))).toBe(true)
    expect(allTextEvents.some(c => typeof c === 'string' && c.includes('.env'))).toBe(true)
  })

  it('[动作 6] 敏感路径越界(package.json)→ 任务硬失败', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '["src/app/page.tsx"]' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'done', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx', 'package.json'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    const failedUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'failed'
    )
    expect(failedUpdate).toBeDefined()
  })

  it('[动作 6] 普通越界(非敏感)→ 任务仍 completed + 越界清理', async () => {
    // 创建临时目录和越界文件
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-test-'))
    const orphanFile = path.join(tmpDir, 'src', 'lib', 'utils.ts')
    fs.mkdirSync(path.dirname(orphanFile), { recursive: true })
    fs.writeFileSync(orphanFile, '// orphan file')

    try {
      const { handleExecution } = await import('@/lib/services/execution')

      // 使用临时目录作为 projectDir
      mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: tmpDir, permissionMode: 'default' })

      const task = makeTask({ declaredFiles: '["src/app/page.tsx"]' })
      mocks.mockTaskFindMany.mockResolvedValue([task])
      mocks.mockExecuteTaskBatch.mockResolvedValue({
        results: new Map([['task-1', { result: 'done', sessionId: 's1' }]]),
        failedTaskIds: [],
      })
      mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
        needsCorrection: false, quality: 'good',
      }) })
      // 越界但都不是敏感路径
      mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx', 'src/lib/utils.ts'])

      const sendEvent = vi.fn()
      await handleExecution('test', 'sess-1', AGENTS, sendEvent)

      // 任务仍标 completed
      const completedUpdate = mocks.mockTaskUpdate.mock.calls.find(
        (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'completed'
      )
      expect(completedUpdate).toBeDefined()
      expect(completedUpdate![0].data.result).toBe('done')

      // 越界文件应被清理
      expect(fs.existsSync(orphanFile)).toBe(false)

      // 应发送越界警告（包含清理信息）
      const allTextEvents = sendEvent.mock.calls.map(c => c[0].content).filter(Boolean)
      expect(allTextEvents.some(c => typeof c === 'string' && c.includes('越界警告'))).toBe(true)
      // 不应发送敏感路径越界
      expect(allTextEvents.some(c => typeof c === 'string' && c.includes('敏感路径越界'))).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('[动作 6] declaredFiles 为空 → 跳过文件校验,任务 completed,无越界报警', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    // declaredFiles 为空(纯讨论任务)
    const task = makeTask({ declaredFiles: '[]' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'analysis done', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({
      needsCorrection: false, quality: 'good',
    }) })
    // Agent 即便没改文件也行;给一个改了的场景也不应报警
    mocks.mockGetChangedFiles.mockReturnValue(['some/random/file.ts'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 任务 completed
    const completedUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'completed'
    )
    expect(completedUpdate).toBeDefined()

    // declaredFiles 为空 → 不应有任何越界报警(普通或敏感)
    const allTextEvents = sendEvent.mock.calls.map(c => c[0].content).filter(Boolean)
    expect(allTextEvents.some(c => typeof c === 'string' && c.includes('越界'))).toBe(false)
  })

  it('[动作 6] 敏感越界失败后,依赖该 task 的下游应 blocked', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const upstream = makeTask({ id: 'task-1', description: '上游', declaredFiles: '["src/a.ts"]' })
    const downstream = makeTask({ id: 'task-2', description: '下游', dependencies: '["task-1"]', declaredFiles: '["src/b.ts"]' })
    mocks.mockTaskFindMany.mockResolvedValue([upstream, downstream])

    // 上游跑完,但偷偷改了 .env
    mocks.mockExecuteTaskBatch.mockResolvedValueOnce({
      results: new Map([['task-1', { result: 'upstream output', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFiles.mockReturnValue(['src/a.ts', '.env'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 上游 → failed
    const upstreamFailed = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'failed'
    )
    expect(upstreamFailed).toBeDefined()

    // 下游 → blocked(由现有的依赖失败检测代码处理)
    const downstreamBlocked = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-2' && c[0].data.status === 'blocked'
    )
    expect(downstreamBlocked).toBeDefined()
  })

  // ─── contract v1 §1.2 a 动作 5: outputSchema 软校验 ───
  it('[动作 5] outputSchema 缺字段 → 发警告,但任务仍 completed', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({
      declaredFiles: '["src/app/page.tsx"]',
      outputSchema: JSON.stringify(['component_path:string - 路径', 'exports:string[] - 符号']),
    })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    // Agent 输出缺 exports 字段
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: '我做完了。\n```json\n{"component_path":"src/app/page.tsx"}\n```', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false, quality: 'good' }) })
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 任务仍 completed(不影响状态)
    const completedUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'completed'
    )
    expect(completedUpdate).toBeDefined()

    // schema 警告应当发送
    const allTextEvents = sendEvent.mock.calls.map(c => c[0].content).filter(Boolean)
    expect(allTextEvents.some(c => typeof c === 'string' && c.includes('schema 警告'))).toBe(true)
    expect(allTextEvents.some(c => typeof c === 'string' && c.includes('exports'))).toBe(true)
  })

  it('[动作 5] outputSchema 没设 → 不发 schema 警告', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({
      declaredFiles: '["src/app/page.tsx"]',
      // outputSchema 字段不存在
    })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: '任意输出无 JSON', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false, quality: 'good' }) })
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    const allTextEvents = sendEvent.mock.calls.map(c => c[0].content).filter(Boolean)
    expect(allTextEvents.some(c => typeof c === 'string' && c.includes('schema 警告'))).toBe(false)
  })

  it('[动作 5] outputSchema 完整满足 → 不发警告', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({
      declaredFiles: '["src/app/page.tsx"]',
      outputSchema: JSON.stringify(['name:string - 名字']),
    })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: '完成。\n```json\n{"name":"foo"}\n```', sessionId: 's1' }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false, quality: 'good' }) })
    mocks.mockGetChangedFiles.mockReturnValue(['src/app/page.tsx'])

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    const allTextEvents = sendEvent.mock.calls.map(c => c[0].content).filter(Boolean)
    expect(allTextEvents.some(c => typeof c === 'string' && c.includes('schema 警告'))).toBe(false)
  })

  // ─── contract v1 §1.3 P0 动作 7: cliSessionId invalidate ───
  it('[动作 7] 敏感越界硬失败 → task.cliSessionId 和 SessionMember.cliSessionId 同时清空', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({
      declaredFiles: '["src/app/page.tsx"]',
      cliSessionId: 'cli-sess-old',
    })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'done', sessionId: 'cli-sess-new' }]]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFiles.mockReturnValue(['.env'])  // 敏感越界

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // task 标 failed 时 cliSessionId 必须为 null(即使本批跑出了新 sessionId)
    const failedUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'failed'
    )
    expect(failedUpdate).toBeDefined()
    expect(failedUpdate[0].data.cliSessionId).toBeNull()

    // SessionMember.cliSessionId 也被清
    const memberClear = mocks.mockSessionMemberUpdateMany.mock.calls.find(
      (c: any[]) => c[0].where.sessionId === 'sess-1' && c[0].where.agentId === 'a1' && c[0].data.cliSessionId === null
    )
    expect(memberClear).toBeDefined()
  })

  it('[动作 7] monitoring 纠偏退回 pending → task.cliSessionId 和 SessionMember.cliSessionId 同时清空', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '[]', cliSessionId: null })  // 跳过文件校验
    mocks.mockTaskFindMany.mockResolvedValue([task])

    // 第一批:任务跑完,monitoring 说 needsCorrection;第二批:重试通过
    let callCount = 0
    mocks.mockExecuteTaskBatch.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          results: new Map([['task-1', { result: '初次产出', sessionId: 'cli-sess-first' }]]),
          failedTaskIds: [],
        }
      }
      return {
        results: new Map([['task-1', { result: '重试产出', sessionId: 'cli-sess-retry' }]]),
        failedTaskIds: [],
      }
    })

    // monitoring 第一次说要纠偏,第二次说不用
    let monCall = 0
    mocks.mockExecuteSingleAgent.mockImplementation(async () => {
      monCall++
      if (monCall === 1) return { result: JSON.stringify({ needsCorrection: true, correctionNote: '请重写' }) }
      return { result: JSON.stringify({ needsCorrection: false }) }
    })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 纠偏发生时:task 被退回 pending,cliSessionId 必须被显式置 null
    const correctionUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'pending' && c[0].data.correctionCount === 1
    )
    expect(correctionUpdate).toBeDefined()
    expect(correctionUpdate[0].data.cliSessionId).toBeNull()

    // SessionMember.cliSessionId 也在纠偏路径被清
    const memberClear = mocks.mockSessionMemberUpdateMany.mock.calls.find(
      (c: any[]) => c[0].where.sessionId === 'sess-1' && c[0].where.agentId === 'a1' && c[0].data.cliSessionId === null
    )
    expect(memberClear).toBeDefined()
  })

  it('[动作 7] 任务正常完成(无纠偏)→ cliSessionId 保留,不 invalidate', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '[]', cliSessionId: null })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: '产出', sessionId: 'cli-sess-keep' }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 任务标 completed 时 cliSessionId 保留(传新值,不为 null)
    const completedUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'completed'
    )
    expect(completedUpdate).toBeDefined()
    expect(completedUpdate[0].data.cliSessionId).toBe('cli-sess-keep')

    // SessionMember 被更新为新值,不为 null
    const memberUpdate = mocks.mockSessionMemberUpdateMany.mock.calls.find(
      (c: any[]) => c[0].where.sessionId === 'sess-1' && c[0].where.agentId === 'a1'
    )
    expect(memberUpdate).toBeDefined()
    expect(memberUpdate[0].data.cliSessionId).toBe('cli-sess-keep')
  })

  // ─── ⚠️-C3 修复:正常完成时,本批没返回 sessionId 不覆盖旧值 ───
  it('[C3] 正常完成 + 本批 CLI 没吐 sessionId → task.cliSessionId 字段不被设置(保留旧值)', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '[]', cliSessionId: 'cli-keep-me' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      // 关键:result 有,但 sessionId 是 undefined(本批 CLI 没吐 session chunk)
      results: new Map([['task-1', { result: '产出', sessionId: undefined }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // task 标 completed 时 data 里**不应**含 cliSessionId 字段(用 ...spread 跳过)
    // 这样 prisma 不会用 null 覆盖旧值,DB 中 cliSessionId 保留 'cli-keep-me'
    const completedUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'completed'
    )
    expect(completedUpdate).toBeDefined()
    expect(completedUpdate[0].data).not.toHaveProperty('cliSessionId')
    // result 仍写入
    expect(completedUpdate[0].data.result).toBe('产出')
  })

  it('[C3] 正常完成 + 本批 CLI 吐了新 sessionId → task.cliSessionId 写入新值', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '[]', cliSessionId: 'cli-old' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: '产出', sessionId: 'cli-new' }]]),
      failedTaskIds: [],
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    const completedUpdate = mocks.mockTaskUpdate.mock.calls.find(
      (c: any[]) => c[0].where.id === 'task-1' && c[0].data.status === 'completed'
    )
    expect(completedUpdate).toBeDefined()
    expect(completedUpdate[0].data.cliSessionId).toBe('cli-new')
  })

  // ─── ⚠️-C2 修复:cliSessionId 跨表更新加事务 ───
  it('[C2] 敏感越界硬失败时 task.update + sessionMember.updateMany 走 $transaction(原子性)', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({
      declaredFiles: '["src/x.ts"]',
      cliSessionId: 'cli-old',
    })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([['task-1', { result: 'done', sessionId: 'new' }]]),
      failedTaskIds: [],
    })
    mocks.mockGetChangedFiles.mockReturnValue(['.env'])  // 触发敏感越界

    // 拦截 $transaction:验证传入的 ops 数组包含 task.update + sessionMember.updateMany
    // (普通 prisma.task.update 调用走的不是这条路径,只有事务内的才能拦到 ops 结构)
    let txOps: unknown[] | null = null
    const dbMod = await import('@/lib/db') as unknown as { prisma: { $transaction: (ops: Promise<unknown>[]) => Promise<unknown[]> } }
    const originalTx = dbMod.prisma.$transaction
    dbMod.prisma.$transaction = vi.fn(async (ops: Promise<unknown>[]) => {
      txOps = ops
      return Promise.all(ops)
    })

    try {
      const sendEvent = vi.fn()
      await handleExecution('test', 'sess-1', AGENTS, sendEvent)

      // 验证 $transaction 至少被调一次,且包 task.update + sessionMember.updateMany
      expect(dbMod.prisma.$transaction).toHaveBeenCalled()
      expect(txOps).not.toBeNull()
      expect(Array.isArray(txOps)).toBe(true)
      // 事务内应至少有 2 个操作(task.update + sessionMember.updateMany)
      expect((txOps as unknown[]).length).toBeGreaterThanOrEqual(2)
    } finally {
      dbMod.prisma.$transaction = originalTx
    }
  })

  it('[C2] 纠偏退回 pending 时 task.update + sessionMember.updateMany 走 $transaction', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    const task = makeTask({ declaredFiles: '[]', cliSessionId: 'cli-old' })
    mocks.mockTaskFindMany.mockResolvedValue([task])
    let callCount = 0
    mocks.mockExecuteTaskBatch.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { results: new Map([['task-1', { result: 'first', sessionId: 's1' }]]), failedTaskIds: [] }
      }
      return { results: new Map([['task-1', { result: 'second', sessionId: 's2' }]]), failedTaskIds: [] }
    })
    // monitoring 第一次说要纠偏,第二次说没问题
    let monitorCount = 0
    mocks.mockExecuteSingleAgent.mockImplementation(async () => {
      monitorCount++
      return { result: JSON.stringify(
        monitorCount === 1
          ? { needsCorrection: true, correctionNote: '需要改进' }
          : { needsCorrection: false }
      ) }
    })

    let txCallCount = 0
    const dbMod = await import('@/lib/db') as unknown as { prisma: { $transaction: (ops: Promise<unknown>[]) => Promise<unknown[]> } }
    const originalTx = dbMod.prisma.$transaction
    dbMod.prisma.$transaction = vi.fn(async (ops: Promise<unknown>[]) => {
      txCallCount++
      return Promise.all(ops)
    })

    try {
      const sendEvent = vi.fn()
      await handleExecution('test', 'sess-1', AGENTS, sendEvent)
      // 纠偏路径触发了 $transaction
      expect(txCallCount).toBeGreaterThanOrEqual(1)
    } finally {
      dbMod.prisma.$transaction = originalTx
    }
  })
})

describe('ISSUE-008 审查整改 — blocked 任务依赖补齐自动复活', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: '', permissionMode: 'default' })
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockMessageCreate.mockResolvedValue({})
  })

  it('链式依赖 redo 后: blocked 下游任务依赖全 completed 时复活并执行(修 verify 滞留)', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    // 模拟 redo task-1 之后的 DB 状态: task-1 被 redo 重置为 pending,
    // task-2(依赖 task-1)仍是上一轮失败遗留的 blocked。
    // 修复前: task-1 完成后 task-2 永久滞留 blocked(readyTasks 只认 pending,blocked 循环单向)。
    // 修复后: 复活机制每轮重查,task-1 completed 即把 task-2 blocked→pending 并执行。
    const task1 = makeTask({ id: 'task-1', description: 'code a', declaredFiles: '[]', dependencies: '[]', assignedAgentId: 'a1', status: 'pending' })
    const task2 = makeTask({ id: 'task-2', description: 'code b', declaredFiles: '[]', dependencies: '["task-1"]', assignedAgentId: 'a2', status: 'blocked' })
    mocks.mockTaskFindMany.mockResolvedValue([task1, task2])

    mocks.mockExecuteTaskBatch.mockImplementation(async (batchTasks: Array<{ id: string }>) => {
      const results = new Map<string, { result: string; sessionId?: string }>()
      for (const t of batchTasks) results.set(t.id, { result: `done-${t.id}` })
      return { results, failedTaskIds: [], failedTaskReasons: {} }
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false, quality: 'good' }) })

    const sendEvent = vi.fn()
    await handleExecution('[redo]', 'sess-1', AGENTS, sendEvent)

    const statusEvents = sendEvent.mock.calls.map(c => c[0]).filter((e: any) => e.type === 'task_status')
    const task2Completed = statusEvents.some((e: any) => e.content.includes('"taskId":"task-2"') && e.content.includes('"completed"'))
    expect(task2Completed).toBe(true)
  })

  it('依赖仍 failed 的 blocked 任务不被复活(不过度复活)', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    // task-1 pending 会失败, task-2 blocked 依赖 task-1 → task-1 失败后 task-2 不应被复活
    const task1 = makeTask({ id: 'task-1', description: 'code a', declaredFiles: '[]', dependencies: '[]', assignedAgentId: 'a1', status: 'pending' })
    const task2 = makeTask({ id: 'task-2', description: 'code b', declaredFiles: '[]', dependencies: '["task-1"]', assignedAgentId: 'a2', status: 'blocked' })
    mocks.mockTaskFindMany.mockResolvedValue([task1, task2])

    // task-1 失败
    mocks.mockExecuteTaskBatch.mockResolvedValue({ results: new Map(), failedTaskIds: ['task-1'], failedTaskReasons: { 'task-1': 'boom' } })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // task-2 保持 blocked(依赖失败),不应出现 task-2 completed/pending 复活事件
    const statusEvents = sendEvent.mock.calls.map(c => c[0]).filter((e: any) => e.type === 'task_status')
    const task2Revived = statusEvents.some((e: any) => e.content.includes('"taskId":"task-2"') && (e.content.includes('"completed"') || e.content.includes('"pending"')))
    expect(task2Revived).toBe(false)
  })
})

describe('Execution — P0 重放 bug(已完成任务不重跑 success 处理)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSessionFindUnique.mockResolvedValue({ id: 'sess-1', projectDir: '', permissionMode: 'default' })
    mocks.mockSessionUpdate.mockResolvedValue({})
    mocks.mockMessageCreate.mockResolvedValue({})
  })

  it('P0: 预装的历史任务被跳过,不重跑 monitoring LLM 不重复发完成事件', async () => {
    const { handleExecution } = await import('@/lib/services/execution')

    // 场景: redo/续跑/多批执行——task-a 已完成(预装历史),task-b 待执行。
    // allResults 预装 task-a 的 result → executeTaskBatch 把它标记为 preloaded
    const taskA = makeTask({ id: 'task-a', status: 'completed', result: 'A 已完成', declaredFiles: '[]' })
    const taskB = makeTask({ id: 'task-b', status: 'pending', declaredFiles: '[]' })
    mocks.mockTaskFindMany.mockResolvedValue([taskA, taskB])

    // executeTaskBatch 返回: 预装 task-a(历史) + 本批新执行 task-b,preloadedIds 标记历史
    mocks.mockExecuteTaskBatch.mockResolvedValue({
      results: new Map([
        ['task-a', { result: 'A 已完成' }],
        ['task-b', { result: 'B 新结果' }],
      ]),
      preloadedIds: ['task-a'],
      failedTaskIds: [],
      failedTaskReasons: {},
    })
    mocks.mockExecuteSingleAgent.mockResolvedValue({ result: JSON.stringify({ needsCorrection: false, quality: 'good' }) })

    const sendEvent = vi.fn()
    await handleExecution('test', 'sess-1', AGENTS, sendEvent)

    // 真回归守卫: 旧代码无 preloadedIds 跳过,会对 task-a 也跑 monitoring LLM → 2 次;
    // 新代码只审本批新执行 task-b → 1 次
    expect(mocks.mockExecuteSingleAgent).toHaveBeenCalledTimes(1)
    // 旧代码会重复发 "任务 task-a 完成";新代码跳过预装历史 → 不发
    expect(sendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: '任务 task-a 完成' })
    )
  })
})
