import { prisma } from '@/lib/db'
import { NextResponse } from 'next/server'

const DEFAULT_POLL_INTERVAL_MS = 500

/**
 * roadmap §3.1 SSE 重放端点：GET /api/sessions/[id]/events
 *
 * 游标语义：EventSource 断线重连自动携带 Last-Event-ID 头；首次连接可用
 * ?after= 显式指定。两者都在时 Last-Event-ID 优先（断线重连语义）。
 *
 * 结构：先补发存量（seq > after 按序），再轮询 DB 推增量——状态全在 DB，
 * 多实例共享 dev.db 时同样工作（无进程内 bus 依赖）。帧带 `id: <seq>` 行，
 * EventSource 据此自动维护 Last-Event-ID。
 *
 * ?pollMs= 仅测试注入用（默认 500ms）。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true } })
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const url = new URL(request.url)
  const lastEventId = request.headers.get('last-event-id')
  const cursorFromHeader = lastEventId !== null ? Number.parseInt(lastEventId, 10) : NaN
  const cursorFromQuery = Number.parseInt(url.searchParams.get('after') ?? '', 10)
  // 下界钳制防热轮询（无鉴权端点 + 本机任意进程可达，审查发现）
  const pollMs = Math.max(
    Number.parseInt(url.searchParams.get('pollMs') ?? '', 10) || DEFAULT_POLL_INTERVAL_MS,
    50,
  )

  let cursor = Number.isFinite(cursorFromHeader) && cursorFromHeader >= 0
    ? cursorFromHeader
    : (Number.isFinite(cursorFromQuery) && cursorFromQuery >= 0 ? cursorFromQuery : 0)

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      // 清理监听必须在任何 await 之前注册（审查发现：backlog 期间客户端断开时
      // abort 已派发，后补监听器收不到 → setInterval 泄漏）；abort 先于注册
      // 触发的窗口由下方 signal.aborted 主动检查兜底。
      // timer 装进容器对象：声明与赋值分离且赋值前有读取（cleanup 可先触发），
      // 直接 let 会被 prefer-const 拦（CI 实测）。
      const poll: { timer?: ReturnType<typeof setInterval> } = {}
      const cleanup = () => {
        if (closed) return
        closed = true
        if (poll.timer !== undefined) clearInterval(poll.timer)
        try { controller.close() } catch { /* 已关闭 */ }
      }
      request.signal.addEventListener('abort', cleanup)

      const send = (row: { seq: number; type: string; agentId: string; content: string; data: string }, replay: boolean) => {
        const payload = {
          seq: row.seq,
          type: row.type,
          agentId: row.agentId,
          content: row.content,
          data: safeParse(row.data),
          // 补发帧统一标记（前端据此不重新弹 permission 确认框等交互动作）
          ...(replay ? { replay: true } : {}),
        }
        controller.enqueue(encoder.encode(`id: ${row.seq}\ndata: ${JSON.stringify(payload)}\n\n`))
      }

      // 1. 补发存量（封顶 MAX_EVENTS_PER_SESSION 天然限制补发体量）
      try {
        const backlog = await prisma.agentProcessEvent.findMany({
          where: { sessionId, seq: { gt: cursor } },
          orderBy: { seq: 'asc' },
        })
        for (const row of backlog) {
          send(row, true)
          cursor = row.seq
        }
      } catch (err) {
        console.warn(`[events] 补发查询失败 sessionId=${sessionId}:`, err instanceof Error ? err.message : err)
      }
      if (closed || request.signal.aborted) {
        // 补发期间客户端已断开（含 abort 先于监听注册触发的窗口）
        cleanup()
        return
      }

      // 2. 增量轮询（失败静默，下一轮重试——重放是 best-effort）
      poll.timer = setInterval(async () => {
        if (closed) return
        try {
          const rows = await prisma.agentProcessEvent.findMany({
            where: { sessionId, seq: { gt: cursor } },
            orderBy: { seq: 'asc' },
          })
          for (const row of rows) {
            send(row, false)
            cursor = row.seq
          }
        } catch {
          // 轮询失败静默
        }
      }, pollMs)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}
