import { describe, it, expect, vi, beforeEach } from 'vitest'

// P2-12: SSE 增量轮询必须有 in-flight 护栏。慢查询超过 pollMs 时，
// 下一轮不能与上一轮重叠，否则会重复发送/游标竞争。

const { mockSessionFindUnique, mockEventsFindMany } = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockEventsFindMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: mockSessionFindUnique },
    agentProcessEvent: { findMany: mockEventsFindMany },
  },
}))

import { GET } from '@/app/api/sessions/[id]/events/route'

const ROW = (seq: number, type = 'thinking', content = `e${seq}`) => ({
  seq, type, agentId: 'a1', content, data: '{}',
})

function req(overrides: { pollMs?: string; signal?: AbortSignal } = {}) {
  const url = new URL('http://localhost/api/sessions/s1/events')
  if (overrides.pollMs) url.searchParams.set('pollMs', overrides.pollMs)
  return new Request(url, { signal: overrides.signal })
}

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function readAll(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const chunk = await Promise.race([
      reader.read() as Promise<ReadableStreamReadResult<Uint8Array>>,
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), remaining)),
    ])
    if (chunk === 'timeout' || chunk.done) break
    out += decoder.decode(chunk.value, { stream: true })
  }
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSessionFindUnique.mockResolvedValue({ id: 's1' })
  mockEventsFindMany.mockResolvedValue([])
})

describe('GET /api/sessions/[id]/events — 轮询 in-flight 护栏（P2-12）', () => {
  it('上一轮查询未完成时不重叠发起下一轮，完成后继续', async () => {
    let resolveSlow!: (rows: unknown[]) => void
    const slow = new Promise<unknown[]>(resolve => { resolveSlow = resolve })
    mockEventsFindMany
      .mockResolvedValueOnce([])        // 补发存量
      .mockReturnValueOnce(slow)        // 第一次增量轮询：挂起
      .mockResolvedValue([])            // 后续轮询：空

    const ctrl = new AbortController()
    const res = await GET(req({ pollMs: '10', signal: ctrl.signal }), { params: Promise.resolve({ id: 's1' }) })
    const bodyPromise = readAll(res, 300)

    // 多个 poll 周期过去，第一次轮询仍然挂起（100ms 内至少覆盖两个 50ms 周期）。
    await delay(130)
    expect(mockEventsFindMany).toHaveBeenCalledTimes(2)

    resolveSlow([ROW(5)])
    const body = await bodyPromise
    ctrl.abort()

    expect(body).toContain('id: 5')
    expect(body.match(/id: 5/g)).toHaveLength(1)
  })
})
