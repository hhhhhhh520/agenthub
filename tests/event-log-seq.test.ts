import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// P2-12: 同一 session 的 seq 必须由同一个进程内分配器统一发放。
// 并发 createEventLogger 不能各自从 DB max 起算，否则 (sessionId, seq)
// 唯一约束冲突后事件会被吞掉。

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

import { createEventLogger } from '@/lib/services/event-log'

beforeEach(() => {
  vi.clearAllMocks()
  mockFindFirst.mockResolvedValue(null)
  mockCreate.mockResolvedValue({})
  mockDeleteMany.mockResolvedValue({ count: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createEventLogger — 单 session seq 分配器（P2-12）', () => {
  it('并发两个 logger 共享一次 DB max 初始化，seq 唯一且单调', async () => {
    mockFindFirst.mockResolvedValue({ seq: 100 })

    const [first, second] = await Promise.all([
      createEventLogger('s-concurrent'),
      createEventLogger('s-concurrent'),
    ])

    // 只能有一个初始化查询；第二个 logger 复用同一个初始化 Promise。
    expect(mockFindFirst).toHaveBeenCalledTimes(1)

    first.sendEvent({ agentId: 'a1', type: 'thinking', content: 'first-1' })
    second.sendEvent({ agentId: 'a1', type: 'thinking', content: 'second-1' })
    first.sendEvent({ agentId: 'a1', type: 'tool_use', content: 'first-2' })

    await Promise.all([first.flush(), second.flush()])

    const seqs = (mockCreate.mock.calls as Array<[{ data: { seq: number; content: string } }]>)
      .map(call => call[0].data.seq)
      .sort((a, b) => a - b)
    expect(seqs).toEqual([101, 102, 103])
    expect(new Set(seqs).size).toBe(3)
    expect(mockCreate).toHaveBeenCalledTimes(3)
  })

  it('写入失败后保留 seq 状态，同 session 新 logger 不复用已发出的 seq', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockCreate.mockRejectedValueOnce(new Error('unique conflict'))

    const first = await createEventLogger('s-poison')
    first.sendEvent({ agentId: 'a1', type: 'thinking', content: 'lost' })
    await first.flush()

    const second = await createEventLogger('s-poison')
    second.sendEvent({ agentId: 'a1', type: 'thinking', content: 'next' })
    await second.flush()

    const seqs = (mockCreate.mock.calls as Array<[{ data: { seq: number } }]>)
      .map(call => call[0].data.seq)
    expect(seqs).toEqual([1, 2])
    // 失败后不能重新查 DB max（否则可能重新发放 1）。
    expect(mockFindFirst).toHaveBeenCalledTimes(1)
    expect(consoleSpy.mock.calls.some(call => String(call[0]).includes('事件未持久化'))).toBe(true)
    consoleSpy.mockRestore()
  })

  it('DB max 初始化失败时并发 logger 也只降级一次，后续 seq 不重复', async () => {
    mockFindFirst.mockRejectedValue(new Error('db down'))
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const [first, second] = await Promise.all([
      createEventLogger('s-init-fail'),
      createEventLogger('s-init-fail'),
    ])
    first.sendEvent({ agentId: 'a1', type: 'thinking', content: 'a' })
    second.sendEvent({ agentId: 'a1', type: 'thinking', content: 'b' })
    await Promise.all([first.flush(), second.flush()])

    expect(mockFindFirst).toHaveBeenCalledTimes(1)
    const seqs = (mockCreate.mock.calls as Array<[{ data: { seq: number } }]>)
      .map(call => call[0].data.seq)
      .sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2])
    const initWarns = consoleSpy.mock.calls.filter(call => String(call[0]).includes('seq 起点查询失败'))
    expect(initWarns).toHaveLength(1)
    consoleSpy.mockRestore()
  })
})
