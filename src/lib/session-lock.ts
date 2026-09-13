const sessionLocks = new Map<string, Promise<void>>()
const LOCK_TIMEOUT_MS = 60_000

/** 等锁超时：上一持有者仍在跑。本错误带 code，路由层用它回 429（不用 instanceof，便于 mock 测试）。 */
export class SessionBusyError extends Error {
  readonly code = 'SESSION_BUSY' as const
  constructor(sessionId: string) {
    super(`Session ${sessionId} is busy (previous request still running)`)
    this.name = 'SessionBusyError'
  }
}

export async function acquireSessionLock(
  sessionId: string,
  signal?: AbortSignal,
  opts?: { timeoutMs?: number },
): Promise<() => void> {
  const timeoutMs = opts?.timeoutMs ?? LOCK_TIMEOUT_MS
  let release: () => void
  const current = new Promise<void>((r) => {
    release = r
  })
  const prev = sessionLocks.get(sessionId) || Promise.resolve()
  sessionLocks.set(sessionId, current)

  const prevWithTimeout = Promise.race([
    prev,
    new Promise<void>((_, reject) => setTimeout(() => reject(new SessionBusyError(sessionId)), timeoutMs)),
  ])

  const abortHandler = signal
    ? () => {
        release()
        if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId)
      }
    : null
  if (abortHandler && signal) signal.addEventListener('abort', abortHandler, { once: true })

  try {
    await prevWithTimeout
  } catch (err) {
    // 超时 fail-closed：不等了，直接 429，绝不与持有者并发（并发写 phase 是竞态根因）。
    // 把队尾挂回 prev（真正的持有者），后来的等待者继续排在它后面，而不是排在一个永远不 resolve 的死 promise 上。
    if (sessionLocks.get(sessionId) === current) sessionLocks.set(sessionId, prev)
    if (abortHandler && signal) signal.removeEventListener('abort', abortHandler)
    throw err
  }

  return () => {
    release()
    if (abortHandler && signal) signal.removeEventListener('abort', abortHandler)
    if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId)
  }
}
