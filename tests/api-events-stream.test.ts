import { describe, it, expect, vi, beforeEach } from 'vitest'

// roadmap §3.1 重放端点：GET /api/sessions/[id]/events（SSE）。
// ① 补发存量（seq > after，按序）② EventSource 断线重连自动带 Last-Event-ID
// ③ 增量轮询 DB 推流（状态全在 DB，多实例安全）④ 帧格式 id: seq + data JSON 含 seq

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

beforeEach(() => {
  vi.clearAllMocks()
  mockSessionFindUnique.mockResolvedValue({ id: 's1' })
  mockEventsFindMany.mockResolvedValue([])
})

function req(overrides: { lastEventId?: string; after?: string; pollMs?: string; signal?: AbortSignal } = {}) {
  const url = new URL('http://localhost/api/sessions/s1/events')
  if (overrides.after) url.searchParams.set('after', overrides.after)
  if (overrides.pollMs) url.searchParams.set('pollMs', overrides.pollMs)
  return new Request(url, {
    headers: overrides.lastEventId ? { 'Last-Event-ID': overrides.lastEventId } : {},
    signal: overrides.signal,
  })
}

/** 读流到 deadline（SSE 流不会自然 done，用 race 防挂死） */
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

describe('GET /api/sessions/[id]/events — SSE 重放端点（§3.1）', () => {
  it('session 不存在 → 404，不建立流', async () => {
    mockSessionFindUnique.mockResolvedValue(null)
    const res = await GET(req(), { params: Promise.resolve({ id: 'nope' }) })
    expect(res.status).toBe(404)
    expect(mockEventsFindMany).not.toHaveBeenCalled()
  })

  it('补发存量：seq > after 按序全推，帧含 id: 行 + data JSON 带 seq + replay 标记', async () => {
    mockEventsFindMany
      .mockResolvedValueOnce([ROW(1), ROW(2, 'tool_use', 'read'), ROW(3, 'permission_request', 'Bash')])
    const ctrl = new AbortController()
    const res = await GET(req({ after: '0', signal: ctrl.signal }), { params: Promise.resolve({ id: 's1' }) })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await readAll(res, 300)
    ctrl.abort()

    // findMany 只在补发阶段被调一次（after 过滤下推 DB）
    expect(mockEventsFindMany).toHaveBeenCalledWith({
      where: { sessionId: 's1', seq: { gt: 0 } },
      orderBy: { seq: 'asc' },
    })
    expect(body).toContain('id: 1')
    expect(body).toContain('id: 2')
    expect(body).toContain('id: 3')
    expect(body).toContain('"seq":2')
    expect(body).toContain('"type":"tool_use"')
    expect(body).toContain('"type":"permission_request"')
    // 补发帧统一带 replay 标记（前端据此不重新弹 permission 确认框）
    expect(body.match(/"replay":true/g)?.length).toBe(3)
  })

  it('Last-Event-ID 头优先于 ?after=（EventSource 断线重连语义）', async () => {
    mockEventsFindMany.mockResolvedValueOnce([])
    const ctrl = new AbortController()
    await GET(req({ lastEventId: '41', after: '99', signal: ctrl.signal }), { params: Promise.resolve({ id: 's1' }) })
    expect(mockEventsFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: 's1', seq: { gt: 41 } } }),
    )
    ctrl.abort()
  })

  it('增量轮询：补发后新落库的事件在后续轮询中被推出', async () => {
    // 第 1 次（补发）空；第 2 次（轮询）返回新事件
    mockEventsFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW(9, 'tool_result', 'done-work')])
    const ctrl = new AbortController()
    const res = await GET(req({ pollMs: '10', signal: ctrl.signal }), { params: Promise.resolve({ id: 's1' }) })
    const body = await readAll(res, 400)
    ctrl.abort()
    expect(body).toContain('id: 9')
    expect(body).toContain('"type":"tool_result"')
    // 轮询增量帧是实时事件：不带 replay 标记
    expect(body).not.toContain('"replay":true')
    // 游标推进：第 2 次 findMany 的 where 用 cursor=0（补发为空）
    expect(mockEventsFindMany).toHaveBeenNthCalledWith(
      2, expect.objectContaining({ where: { sessionId: 's1', seq: { gt: 0 } } }),
    )
  })

  it('轮询失败静默（不关闭流），下一轮继续', async () => {
    mockEventsFindMany.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('db busy')).mockResolvedValueOnce([ROW(5)])
    const ctrl = new AbortController()
    const res = await GET(req({ pollMs: '10', signal: ctrl.signal }), { params: Promise.resolve({ id: 's1' }) })
    const body = await readAll(res, 400)
    ctrl.abort()
    expect(body).toContain('id: 5')
  })

  it('补发期间客户端断开（abort 先于监听注册触发的窗口）→ 流关闭、timer 不泄漏', async () => {
    // 审查发现 🔴：cleanup 监听若在 backlog await 之后注册，补发期间断开时
    // abort 已派发、监听器收不到 → setInterval 每 500ms 轮询直到进程重启
    // （React StrictMode 双挂载可稳定触发）。修复：监听在 start 顶部注册 +
    // 建 timer 前主动检查 signal.aborted。
    mockEventsFindMany.mockReturnValueOnce(new Promise(() => { /* backlog 挂起 */ }))
    const ctrl = new AbortController()
    const res = await GET(req({ after: '0', signal: ctrl.signal }), { params: Promise.resolve({ id: 's1' }) })
    const reader = res.body!.getReader()
    // 给 start() 时间跑到 backlog await，然后断开
    await new Promise(r => setTimeout(r, 50))
    ctrl.abort()
    const first = await Promise.race([
      reader.read() as Promise<ReadableStreamReadResult<Uint8Array>>,
      new Promise<'hang'>(r => setTimeout(() => r('hang'), 300)),
    ])
    // 修复后：abort → cleanup → controller.close() → read 立即 done（而非挂死）
    expect(first).toEqual({ done: true, value: undefined })
  })
})
