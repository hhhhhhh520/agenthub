/**
 * 任务板轮询节奏计算（纯函数，便于单测）
 *
 * 背景（ISSUE-002 改造）：
 * - 连续失败达到阈值后不再永久停摆，转为低频探测（成功一次即恢复原节奏）
 * - 常规轮询一次无变化即空闲降频（10s），有变化立即恢复活跃节奏
 * - redo 轮询保持快速档
 */

export const POLL_INTERVALS = {
  redoFast: 1_000,
  active: 3_000,
  idle: 10_000,
  errorProbe: 30_000,
} as const

/** 连续失败达到该次数后进入低频探测 */
export const ERROR_PROBE_THRESHOLD = 5

export interface PollState {
  /** 连续失败次数（成功一次归零） */
  errorCount: number
  /** 上一次成功轮询相比再上一次是否有任务变化 */
  changedSinceLastPoll: boolean
  /** redo 进行中的快速档 */
  redoFast: boolean
}

export function computePollInterval({ errorCount, changedSinceLastPoll, redoFast }: PollState): number {
  if (errorCount >= ERROR_PROBE_THRESHOLD) return POLL_INTERVALS.errorProbe
  if (redoFast) return POLL_INTERVALS.redoFast
  return changedSinceLastPoll ? POLL_INTERVALS.active : POLL_INTERVALS.idle
}
