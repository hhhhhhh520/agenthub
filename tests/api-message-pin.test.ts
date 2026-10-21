import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    message: {
      findFirst: mocks.findFirst,
      count: mocks.count,
      update: mocks.update,
    },
    $transaction: mocks.transaction,
  },
}))

import { PATCH } from '@/app/api/sessions/[id]/messages/[messageId]/route'

const params = (messageId: string) => ({ params: Promise.resolve({ id: 's1', messageId }) })

function patchReq(isPinned: boolean) {
  return new Request('http://localhost/api/sessions/s1/messages/m', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPinned }),
  })
}

let pinnedCount = 0
let inTransaction = false
let queue: Promise<void> = Promise.resolve()

beforeEach(() => {
  vi.clearAllMocks()
  pinnedCount = 0
  inTransaction = false
  queue = Promise.resolve()

  mocks.findFirst.mockImplementation(async ({ where }: { where: { id: string; sessionId: string } }) => ({
    id: where.id,
    sessionId: where.sessionId,
    isPinned: false,
  }))
  mocks.count.mockImplementation(async () => {
    // 旧实现 count 在事务外：所有并发请求都读到 0。
    // 修复后 count 在串行事务内：读到前一笔更新后的真实计数。
    return inTransaction ? pinnedCount : 0
  })
  mocks.update.mockImplementation(async ({ where, data }: {
    where: { id: string; sessionId: string }
    data: { isPinned: boolean }
  }) => {
    pinnedCount += data.isPinned ? 1 : -1
    return { id: where.id, sessionId: where.sessionId, isPinned: data.isPinned }
  })
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      message: {
        findFirst: mocks.findFirst,
        count: mocks.count,
        update: mocks.update,
      },
    }
    const run = queue.then(async () => {
      inTransaction = true
      try {
        return await fn(tx)
      } finally {
        inTransaction = false
      }
    })
    queue = run.then(() => undefined, () => undefined)
    return run
  })
})

describe('PATCH /api/sessions/[id]/messages/[messageId] — P3 #18 Pin 上限', () => {
  it('11 个并发 Pin 请求最多成功 10 个，第 11 个返回 400', async () => {
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, i) => PATCH(patchReq(true), params(`m-${i}`))),
    )

    const ok = responses.filter(r => r.status === 200)
    const rejected = responses.filter(r => r.status === 400)
    expect(ok).toHaveLength(10)
    expect(rejected).toHaveLength(1)
    expect(pinnedCount).toBe(10)
  })

  it('已达上限时仍允许取消 Pin', async () => {
    pinnedCount = 10
    const res = await PATCH(patchReq(false), params('m-unpin'))

    expect(res.status).toBe(200)
    expect(pinnedCount).toBe(9)
  })

  it('消息不存在返回 404', async () => {
    mocks.findFirst.mockResolvedValueOnce(null)
    const res = await PATCH(patchReq(true), params('missing'))

    expect(res.status).toBe(404)
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
