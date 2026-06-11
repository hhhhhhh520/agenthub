/**
 * Wall-clock timeout for async generators (adapter.send()).
 *
 * withTimeout wraps an AsyncIterable with a deadline. If the source
 * doesn't complete within timeoutMs, it throws TimeoutError after
 * calling onTimeout for cleanup (e.g. killing the CLI process).
 */

export class TimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly functionName: string,
  ) {
    super(`[${functionName}] 超时 ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'TimeoutError'
  }
}

export async function* withTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  options?: { onTimeout?: () => Promise<void> },
): AsyncIterable<T> {
  const deadline = Date.now() + timeoutMs
  const iterator = source[Symbol.asyncIterator]()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        if (options?.onTimeout) await options.onTimeout()
        throw new TimeoutError(timeoutMs, 'withTimeout')
      }

      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(async () => {
            timedOut = true
            if (options?.onTimeout) await options.onTimeout()
            reject(new TimeoutError(timeoutMs, 'withTimeout'))
          }, remaining)
        }),
      ])

      // 正常完成时清除定时器，避免泄漏
      if (timer) { clearTimeout(timer); timer = undefined }

      if (result.done) return
      yield result.value
    }
  } finally {
    if (timer) clearTimeout(timer)
    // 超时时调用 iterator.return() 让子 generator 的 finally 触发
    // （readRound/readNdjsonRound 的 finally 会移除 stdout listener）
    if (timedOut) await iterator.return?.()
  }
}

/** 超时常量（毫秒） */
export const TIMEOUT = {
  /** 快速 LLM 调用：场景分析、Orchestrator 决策、角色生成、任务拆解 */
  LLM_CALL: 2 * 60 * 1000,
  /** 单个 Agent 任务执行（代码生成、文件编辑） */
  AGENT_TASK: 15 * 60 * 1000,
  /** 讨论每轮每 Agent */
  DISCUSSION: 3 * 60 * 1000,
  /** 监控/审查调用 */
  MONITORING: 2 * 60 * 1000,
} as const
