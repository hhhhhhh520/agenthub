/**
 * Wall-clock timeout for async generators (adapter.send()).
 *
 * withTimeout wraps an AsyncIterable with a deadline. If the source
 * doesn't complete within timeoutMs, it throws TimeoutError after
 * calling onTimeout for cleanup (e.g. killing the CLI process).
 */

/** 清理回调自身的硬上限：onTimeout 里的 kill/wait 再慢，也不能让超时语义无限挂起。 */
export const CLEANUP_TIMEOUT_MS = 10_000

async function runCleanupBounded(
  fn: () => Promise<void>,
  timeoutMs: number,
  label = 'cleanup',
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fn(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[withTimeout] ${label} exceeded ${timeoutMs}ms; timeout still wins`)
          resolve()
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
  options?: { onTimeout?: () => Promise<void>; cleanupTimeoutMs?: number },
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
        // 清理失败不能吞掉 TimeoutError：超时语义必须始终兑现（否则调用方会永久挂起）。
        try {
          if (options?.onTimeout) {
            await runCleanupBounded(
              options.onTimeout,
              options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
              'onTimeout cleanup',
            )
          }
        } catch (err) {
          console.warn('[withTimeout] onTimeout cleanup failed:', err instanceof Error ? err.message : err)
        }
        throw new TimeoutError(timeoutMs, 'withTimeout')
      }

      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            // R1: 超时必须先于 next 的迟到结果胜出。onTimeout 只启动有界清理，
            // 不能 await 它——否则清理期间 next(done) 会先完成并吞掉 TimeoutError。
            if (options?.onTimeout) {
              void runCleanupBounded(
                options.onTimeout,
                options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
                'onTimeout cleanup',
              ).catch((err) => {
                console.warn('[withTimeout] onTimeout cleanup failed:', err instanceof Error ? err.message : err)
              })
            }
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
    // （readRound/readNdjsonRound 的 finally 会移除 stdout listener）。
    // P2-01: 非合作 generator 的 return() 可能永不 settle；必须与 onTimeout 一样有界。
    // wrapper 只能保证自身有界返回，不能强制停掉底层 generator——超时后它迟到的
    // 写入不会再被 yield，也不会覆盖已经抛出的 TimeoutError。
    if (timedOut && iterator.return) {
      try {
        await runCleanupBounded(
          async () => { await iterator.return!() },
          options?.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
          'iterator.return cleanup',
        )
      } catch (err) {
        console.warn('[withTimeout] iterator.return cleanup failed:', err instanceof Error ? err.message : err)
      }
    }
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
