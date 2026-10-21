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
 * - 写入时序：seq 由进程内 per-session 分配器同步分配，多 logger 共享同一
 *   起点与计数器；实际落库异步进行，调用方在流关闭前 flush() 排空。
 * - 只持久化四类过程事件 + permission_cancel：text/error 等成品已由
 *   Message 表承载（ISSUE-011 F1 失败原因也落 Message），重放不重复。
 * - 容量封顶对齐 decisionTrace 模式（防无界增长，roadmap §9#5）。
 * - 隐私口径（2026-09-21 拍板）：thinking 单条截断 4KB 入库。
 */

export const MAX_EVENTS_PER_SESSION = 500
export const MAX_THINKING_CONTENT_LENGTH = 4 * 1024
/** flush 硬上限：DB 写队列卡住时不能让 chat stream finally / 会话锁无限等待。 */
export const FLUSH_TIMEOUT_MS = 5_000

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

interface SessionSeqState {
  currentSeq: number
  /** 首次 DB max 查询；并发 createEventLogger 共享，避免各自从同一 max 起算。 */
  init: Promise<void>
  /** 当前持有该 session 分配器的 logger 数；最后一个 flush 后释放。 */
  refs: number
  /** 初始化降级或写入失败后保留状态，避免复用已经流式发出的 seq。 */
  poisoned: boolean
}

/** 进程内 per-session seq 分配器。跨实例一致性不在本项范围内。 */
const sessionSeqStates = new Map<string, SessionSeqState>()

async function loadInitialSeq(sessionId: string, state: SessionSeqState): Promise<void> {
  try {
    const last = await prisma.agentProcessEvent.findFirst({
      where: { sessionId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    state.currentSeq = last?.seq ?? 0
  } catch (err) {
    // 查询失败降级从 0 起；同一 session 的并发 logger 仍共享这个降级结果。
    console.warn(`[event-log] seq 起点查询失败，降级从 0 起 sessionId=${sessionId}:`, err instanceof Error ? err.message : err)
  }
}

function acquireSeqState(sessionId: string): SessionSeqState {
  const existing = sessionSeqStates.get(sessionId)
  if (existing) {
    existing.refs += 1
    return existing
  }

  let resolveInit!: () => void
  const init = new Promise<void>((resolve) => { resolveInit = resolve })
  const state: SessionSeqState = { currentSeq: 0, init, refs: 1, poisoned: false }
  // 先入 Map 再启动查询：并发 createEventLogger 在首个 await 前拿到同一个 state。
  sessionSeqStates.set(sessionId, state)
  void loadInitialSeq(sessionId, state).finally(resolveInit)
  return state
}

function releaseSeqState(sessionId: string, state: SessionSeqState): void {
  state.refs -= 1
  if (state.refs > 0) return
  // 只有完整落库且没有失败/超时才释放；否则保留计数器，宁可多占内存也不复用 seq。
  if (!state.poisoned && sessionSeqStates.get(sessionId) === state) {
    sessionSeqStates.delete(sessionId)
  }
}

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
  /** 排空写队列（流关闭前调用，保证断线补发不缺尾部）。有硬上限，超时只警告不阻塞锁释放。 */
  flush: (opts?: { timeoutMs?: number }) => Promise<void>
}

export async function createEventLogger(
  sessionId: string,
  opts?: { stream?: (event: SequencedEvent) => void },
): Promise<EventLogger> {
  // seq 由 per-session 分配器统一发放：并发 logger 共享一次 DB max 初始化，
  // 之后同步递增，避免两个 logger 从同一 max 各自起算导致唯一约束冲突。
  const seqState = acquireSeqState(sessionId)
  await seqState.init
  let released = false

  // 异步串行写队列：链式 promise 保证写入按 seq 顺序落库；单条失败不击穿
  // 执行主流程，但必须留告警并保留 seq 状态，不能静默复用已发出的 seq。
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
      seqState.poisoned = true
      console.warn(`[event-log] 事件落库失败（事件未持久化，继续后续写入）seq=${event.seq}:`, err instanceof Error ? err.message : err)
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
      const event: SequencedEvent = { ...data, seq: seqState.currentSeq + 1 }
      seqState.currentSeq = event.seq
      enqueueWrite(event)
      opts?.stream?.(event)
    },
    async flush(opts) {
      const timeoutMs = opts?.timeoutMs ?? FLUSH_TIMEOUT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        await Promise.race([
          writeChain,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true
              console.warn(`[event-log] flush 超过 ${timeoutMs}ms，放弃等待（流关闭/锁释放优先）sessionId=${sessionId}`)
              resolve()
            }, timeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
        if (timedOut || writeError !== null) seqState.poisoned = true
        if (!released) {
          released = true
          releaseSeqState(sessionId, seqState)
        }
      }
      // writeError 仅为调试留痕（每条失败已在 catch 里 warn），flush 恒 resolve
      void writeError
    },
  }
}
