import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// roadmap §3.1（已拍板修彻底）：四类过程事件（thinking/tool_use/tool_result/
// permission_request + permission_cancel）此前只流式 emit，刷新/断线即丢。
// 本文件锁定 event-log 服务的契约：
// 1) 四类事件持久化，seq 每 session 单调（从 DB max 恢复），其余类型不持久化不占 seq
// 2) thinking 单条 4KB 截断（拍板口径），其余类型不截断
// 3) 写入走异步串行队列，flush() 排空；单条失败吞掉不冒泡、不阻塞后续
// 4) 容量封顶对齐 decisionTrace 模式（500 条/session，触顶删最旧，每 session 首次 warn）
// 5) 持久化与推流解耦：stream 回调同步收含 seq 的完整事件，供 SSE 帧组装

const { mockFindFirst, mockCreate, mockDeleteMany } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockCreate: vi.fn(),
  mockDeleteMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    agentProcessEvent: {
      findFirst: mockFindFirst,
      create: mockCreate,
      deleteMany: mockDeleteMany,
    },
  },
}))

import {
  createEventLogger,
  MAX_EVENTS_PER_SESSION,
  MAX_THINKING_CONTENT_LENGTH,
  PERSISTED_EVENT_TYPES,
  type SequencedEvent,
} from '@/lib/services/event-log'

beforeEach(() => {
  vi.clearAllMocks()
  mockFindFirst.mockResolvedValue(null)
  mockCreate.mockResolvedValue({})
  mockDeleteMany.mockResolvedValue({ count: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createEventLogger — 四类过程事件持久化（§3.1）', () => {
  it('非持久化类型（text/done/status/error 等）不写库、不占 seq，stream 照常回调', async () => {
    const seen: SequencedEvent[] = []
    const logger = await createEventLogger('s1', {
      stream: e => seen.push(e),
    })
    logger.sendEvent({ agentId: 'orchestrator', type: 'text', content: 'hello' })
    logger.sendEvent({ agentId: 'orchestrator', type: 'done', content: 'bye' })
    await logger.flush()

    expect(mockCreate).not.toHaveBeenCalled()
    expect(seen.map(e => e.type)).toEqual(['text', 'done'])
    // 不占 seq：首个持久化事件从 1 开始（后面用例覆盖）
  })

  it('四类事件持久化：seq 单调递增，create 字段完整，stream 收到含 seq 的事件', async () => {
    const seen: SequencedEvent[] = []
    const logger = await createEventLogger('s1', {
      stream: e => seen.push(e),
    })
    logger.sendEvent({ agentId: 'a1', type: 'thinking', content: '思考中' })
    logger.sendEvent({ agentId: 'a1', type: 'tool_use', content: 'read: x', data: { toolName: 'read', toolInput: { file: 'x' } } })
    logger.sendEvent({ agentId: 'a1', type: 'tool_result', content: 'ok' })
    logger.sendEvent({ agentId: 'a1', type: 'permission_request', content: 'Bash', data: { requestId: 'r1' } })
    await logger.flush()

    expect(mockCreate).toHaveBeenCalledTimes(4)
    expect((mockCreate.mock.calls as Array<[{ data: { seq: number } }]>).map(c => c[0].data.seq)).toEqual([1, 2, 3, 4])
    expect(mockCreate.mock.calls[1][0].data).toMatchObject({
      sessionId: 's1', seq: 2, type: 'tool_use', agentId: 'a1',
      data: JSON.stringify({ toolName: 'read', toolInput: { file: 'x' } }),
    })
    // stream 收到的帧带 seq（前端去重 + EventSource id 行的数据源）
    expect(seen.map(e => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('seq 从 DB max 恢复（跨请求单调），max 查询失败时降级从 0 起', async () => {
    mockFindFirst.mockResolvedValueOnce({ seq: 41 })
    const logger1 = await createEventLogger('s1')
    logger1.sendEvent({ agentId: 'a1', type: 'thinking', content: 'x' })
    await logger1.flush()
    expect(mockCreate.mock.calls[0][0].data.seq).toBe(42)

    mockFindFirst.mockRejectedValueOnce(new Error('table missing'))
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger2 = await createEventLogger('s1')
    logger2.sendEvent({ agentId: 'a1', type: 'thinking', content: 'y' })
    await logger2.flush()
    expect(mockCreate.mock.calls[1][0].data.seq).toBe(1)
    consoleSpy.mockRestore()
  })

  it('thinking 超 4KB 截断并带标注；tool_result 等其余类型不截断', async () => {
    const logger = await createEventLogger('s1')
    const longThinking = 'x'.repeat(MAX_THINKING_CONTENT_LENGTH + 100)
    logger.sendEvent({ agentId: 'a1', type: 'thinking', content: longThinking })
    logger.sendEvent({ agentId: 'a1', type: 'tool_result', content: 'y'.repeat(MAX_THINKING_CONTENT_LENGTH + 100) })
    await logger.flush()

    const thinkingRow = mockCreate.mock.calls[0][0].data
    const toolRow = mockCreate.mock.calls[1][0].data
    expect(thinkingRow.content.length).toBeLessThanOrEqual(MAX_THINKING_CONTENT_LENGTH + 50)
    expect(thinkingRow.content).toContain('截断')
    expect(toolRow.content.length).toBe(MAX_THINKING_CONTENT_LENGTH + 100)
  })

  it('串行写队列：flush() 排空全部写入；单条失败吞掉不阻塞后续', async () => {
    const logger = await createEventLogger('s1')
    mockCreate.mockRejectedValueOnce(new Error('db locked'))
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logger.sendEvent({ agentId: 'a1', type: 'thinking', content: 'fail' })
    logger.sendEvent({ agentId: 'a1', type: 'thinking', content: 'ok' })
    await expect(logger.flush()).resolves.toBeUndefined()
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it(`封顶 ${MAX_EVENTS_PER_SESSION} 条：seq 超限后 deleteMany 删最旧，每 session 首次触顶 warn`, async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = await createEventLogger('s1')
    for (let i = 0; i < MAX_EVENTS_PER_SESSION + 2; i++) {
      logger.sendEvent({ agentId: 'a1', type: 'thinking', content: `e${i}` })
    }
    await logger.flush()

    // 每条写入后都有 trim 检查（SQLite 索引删 0~1 行，开销可忽略）
    expect(mockDeleteMany).toHaveBeenCalled()
    const lastTrim = mockDeleteMany.mock.calls[mockDeleteMany.mock.calls.length - 1][0]
    expect(lastTrim.where.seq.lte).toBe(MAX_EVENTS_PER_SESSION + 2 - MAX_EVENTS_PER_SESSION)
    // 首次触顶 warn 恰好一次
    const capWarns = consoleSpy.mock.calls.filter(c => String(c[0]).includes('触顶'))
    expect(capWarns).toHaveLength(1)
    consoleSpy.mockRestore()
  })

  it('PERSISTED_EVENT_TYPES 恰为四类过程事件 + permission_cancel', () => {
    expect([...PERSISTED_EVENT_TYPES].sort()).toEqual([
      'permission_cancel', 'permission_request', 'thinking', 'tool_result', 'tool_use',
    ])
  })
})
