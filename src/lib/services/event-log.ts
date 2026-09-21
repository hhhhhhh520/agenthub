import { prisma } from '@/lib/db'

/**
 * roadmap §3.1（已拍板修彻底）：四类过程事件持久化 + SSE 重放。
 * 此前 thinking/tool_use/tool_result/permission_request 只流式 emit 不落库，
 * 刷新/断线即丢、"从 Message 表补发"覆盖不了它们（roadmap 附录 A 已核实）。
 *
 * 设计要点（拍板记录见 roadmap §3.1 / §8#2）：
 * - 持久化与推流解耦：sendEvent 同步签名不变（全仓调用方零改动），内部把
 *   持久化排入异步串行队列；streamClosed 后仍落库、只是不推流——这是
 *   刷新后按 seq 补发的前提。
 * - 写入时序：seq 同步分配（锁纪律保证同 session 执行串行，无竞态），
 *   实际落库异步进行，调用方在流关闭前 flush() 排空。
 * - 只持久化四类过程事件 + permission_cancel：text/error 等成品已由
 *   Message 表承载（ISSUE-011 F1 失败原因也落 Message），重放不重复。
 * - 容量封顶对齐 decisionTrace 模式（防无界增长，roadmap §9#5）。
 * - 隐私口径（2026-09-21 拍板）：thinking 单条截断 4KB 入库。
 */

export const MAX_EVENTS_PER_SESSION = 500
export const MAX_THINKING_CONTENT_LENGTH = 4 * 1024

/** 四类过程事件 + permission_cancel（同族交互事件，重放后前端只渲染历史不重新弹窗） */
export const PERSISTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'thinking',
  'tool_use',
  'tool_result',
  'permission_request',
  'permission_cancel',
])

/** 已就触顶告警过的 session（对齐 decision-trace 的 warnedCappedSessions 模式） */
const warnedCappedSessions = new Set<string>()

export interface PersistableEvent {
  agentId: string
  type: string
  content: string
  /** 仅 done（regenerate）帧携带；非持久化类型，透传给 stream */
  messageId?: string
  data?: { requestId?: string; toolName?: string; toolInput?: Record<string, unknown>; quality?: string }
}

/** 带重放游标的事件（stream 回调与 SSE 帧的载荷） */
export interface SequencedEvent extends PersistableEvent {
  seq: number
}

function truncateThinking(content: string): string {
  if (content.length <= MAX_THINKING_CONTENT_LENGTH) return content
  return `${content.slice(0, MAX_THINKING_CONTENT_LENGTH)}\n[...thinking 已截断（拍板口径 4KB），原文 ${content.length} 字符]`
}

export interface EventLogger {
  /** 同步签名与全仓 SendEvent 兼容；持久化类型分配 seq 并入队落库 */
  sendEvent: (data: PersistableEvent) => void
  /** 排空写队列（流关闭前调用，保证断线补发不缺尾部） */
  flush: () => Promise<void>
}

export async function createEventLogger(
  sessionId: string,
  opts?: { stream?: (event: SequencedEvent) => void },
): Promise<EventLogger> {
  // seq 起点：从 DB max 恢复（跨请求单调）。查询失败降级从 0 起（重放游标
  // 回退最多造成一次重复补发，前端 seq 去重兜底，不击穿主流程）。
  let seq = 0
  try {
    const last = await prisma.agentProcessEvent.findFirst({
      where: { sessionId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    seq = last?.seq ?? 0
  } catch (err) {
    console.warn(`[event-log] seq 起点查询失败，降级从 0 起 sessionId=${sessionId}:`, err instanceof Error ? err.message : err)
  }

  // 异步串行写队列：链式 promise 保证写入按 seq 顺序落库；单条失败吞掉
  // （重放是 best-effort，不击穿执行主流程）。
  let writeChain: Promise<void> = Promise.resolve()
  let writeError: unknown = null

  const enqueueWrite = (event: SequencedEvent) => {
    writeChain = writeChain.then(async () => {
      // 容量封顶：每条写入后 trim（seq 索引命中，删除 0~1 行，开销可忽略），
      // 保留最近 MAX_EVENTS_PER_SESSION 条；每 session 首次触顶 warn 一次。
      if (event.seq > MAX_EVENTS_PER_SESSION) {
        await prisma.agentProcessEvent.deleteMany({
          where: { sessionId, seq: { lte: event.seq - MAX_EVENTS_PER_SESSION } },
        })
        if (!warnedCappedSessions.has(sessionId)) {
          warnedCappedSessions.add(sessionId)
          console.warn(`[event-log] 过程事件触顶(${MAX_EVENTS_PER_SESSION}条),丢弃最旧 sessionId=${sessionId}`)
        }
      }
      await prisma.agentProcessEvent.create({
        data: {
          sessionId,
          seq: event.seq,
          type: event.type,
          agentId: event.agentId,
          content: event.type === 'thinking' ? truncateThinking(event.content) : event.content,
          data: JSON.stringify(event.data ?? {}),
        },
      })
    }).catch(err => {
      writeError = err
      console.warn(`[event-log] 事件落库失败（继续后续写入）seq=${event.seq}:`, err instanceof Error ? err.message : err)
    })
  }

  return {
    sendEvent(data) {
      if (!PERSISTED_EVENT_TYPES.has(data.type)) {
        // 非持久化类型不占 seq：text/error 等成品由 Message 表承载，
        // 保持重放游标只覆盖事件表语义
        opts?.stream?.(data as SequencedEvent)
        return
      }
      const event: SequencedEvent = { ...data, seq: ++seq }
      enqueueWrite(event)
      opts?.stream?.(event)
    },
    async flush() {
      await writeChain
      // writeError 仅为调试留痕（每条失败已在 catch 里 warn），flush 恒 resolve
      void writeError
    },
  }
}
