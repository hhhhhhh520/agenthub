/**
 * roadmap §3.1 前端重放游标。
 *
 * POST chat 流（首屏实时）与 GET events SSE 流（断线重连）双通道并存，
 * 同一持久化事件可能两路到达——seq 单调门统一去重。lastSeq 经 sessionStorage
 * 跨刷新恢复，EventSource 以 after=lastSeq 精准补发断线窗口（而非全量历史
 * 回放——历史成品由 Message 表承载，过程事件只补"丢流窗口"）。
 */

/** 每 session 的 lastSeq 存储 key（跨刷新恢复游标） */
export function lastSeqStorageKey(sessionId: string): string {
  return `agenthub:lastSeq:${sessionId}`
}

export interface SeqGate {
  /** seq 缺失的帧（text/done 等非持久化类型）恒放行且不推进游标 */
  accept: (seq?: number) => boolean
  current: () => number
}

/**
 * 单调 seq 门：小于等于已见游标的帧拒绝（双通道去重 + 补发跳过历史）。
 * initial 为跨刷新恢复的 lastSeq（默认 0 = 从头收）。
 */
export function createSeqGate(initial = 0): SeqGate {
  let last = initial
  return {
    accept(seq?: number): boolean {
      if (seq === undefined) return true
      if (seq <= last) return false
      last = seq
      return true
    },
    current: () => last,
  }
}

/**
 * 持久化 lastSeq（跨刷新恢复游标）。多标签页同看一个会话时各自收到不同
 * 进度的帧——取 max 合并防回退。storage 不可用（隐私模式等）静默跳过。
 */
export function recordLastSeq(sessionId: string, seq: number): void {
  try {
    const key = lastSeqStorageKey(sessionId)
    const prev = Number.parseInt(sessionStorage.getItem(key) ?? '', 10)
    const next = Number.isFinite(prev) ? Math.max(prev, seq) : seq
    sessionStorage.setItem(key, String(next))
  } catch {
    // storage 不可用时跳过（刷新后游标归零 → 多补发一次，seq 门去重兜底）
  }
}

/** 读取持久化的 lastSeq（无记录/损坏 → 0） */
export function loadLastSeq(sessionId: string): number {
  try {
    const saved = Number.parseInt(sessionStorage.getItem(lastSeqStorageKey(sessionId)) ?? '', 10)
    return Number.isFinite(saved) && saved >= 0 ? saved : 0
  } catch {
    return 0
  }
}
