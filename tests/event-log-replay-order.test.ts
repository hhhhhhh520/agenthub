import { describe, it, expect, vi, beforeEach } from 'vitest'

// P2-12 / 旧 #19：SSE 以 seq 为游标。若 B 的 3 先于 A 的 2 落库，
// SSE 读到 1、3 后 cursor=3，2 后续成功落库也不会再补发。

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: vi.fn().mockResolvedValue({ id: 's-replay-order' }) },
    agentProcessEvent: h,
  },
}))

import { createEventLogger } from '@/lib/services/event-log'
import { GET } from '@/app/api/sessions/[id]/events/route'

type Row = { sessionId: string; seq: number; type: string; agentId: string; content: string; data: string }

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
  h.findFirst.mockResolvedValue(null)
  h.deleteMany.mockResolvedValue({ count: 0 })
})

describe('event-log + SSE — 跨 logger 写链顺序（P2-12）', () => {
  it('flush 超时后 B 的 3 不能插队；SSE 必须补发 id 2', async () => {
    const rows: Row[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    h.create.mockImplementation(async ({ data }: { data: Row }) => {
      rows.push(data)
      if (data.seq === 1) await firstGate
      return data
    })
    h.findMany.mockImplementation(async ({ where }: { where: { seq: { gt: number } } }) =>
      rows.filter(row => row.seq > where.seq.gt).sort((a, b) => a.seq - b.seq))

    const first = await createEventLogger('s-replay-order')
    first.sendEvent({ agentId: 'a', type: 'thinking', content: 'one' })
    first.sendEvent({ agentId: 'a', type: 'tool_use', content: 'two' })
    await first.flush({ timeoutMs: 5 })

    const second = await createEventLogger('s-replay-order')
    second.sendEvent({ agentId: 'b', type: 'thinking', content: 'three' })
    await delay(10)
    expect(rows.map(row => row.seq)).toEqual([1])

    const ctrl = new AbortController()
    const res = await GET(
      new Request('http://localhost/api/sessions/s-replay-order/events?pollMs=50', { signal: ctrl.signal }),
      { params: Promise.resolve({ id: 's-replay-order' }) },
    )
    const bodyPromise = readAll(res, 300)
    // 让补发先处理完 rows=[1]，cursor 停在 1；然后再放行 2、3。
    await delay(60)

    releaseFirst()
    await Promise.all([first.flush(), second.flush()])
    const body = await bodyPromise
    ctrl.abort()

    expect(rows.map(row => row.seq)).toEqual([1, 2, 3])
    expect(body).toContain('id: 1\n')
    expect(body).toContain('id: 2\n')
    expect(body).toContain('id: 3\n')
  })
})
