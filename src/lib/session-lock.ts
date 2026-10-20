/**
 * 会话级互斥锁（显式等待队列）。
 *
 * 旧实现用 Map<sessionId, Promise> 链式排队：每个等待者都把自己的 promise 写进
 * Map，超时者只在自己仍是队尾时才把 Map 挂回 prev。A 持锁、B/C 同时等待时，
 * B 超时后 C 仍在等 B 的 promise（永远不会 resolve），A 释放后 C 仍会超时。
 *
 * 本实现改为显式 waiter 队列：
 * - 等待者超时/取消时从队列移除自己，不留下死 promise；
 * - 释放时直接把锁交给队首（handoff），队尾断链结构性不可能；
 * - 持有者 abort 不释放锁：HTTP 断开不等于后台执行结束，锁必须由调用方的
 *   finally 释放（chat route 的 stream finally）。
 */

const LOCK_TIMEOUT_MS = 60_000

/** 等锁超时：上一持有者仍在跑。本错误带 code，路由层用它回 429（不用 instanceof，便于 mock 测试）。 */
export class SessionBusyError extends Error {
  readonly code = 'SESSION_BUSY' as const
  constructor(sessionId: string) {
    super(`Session ${sessionId} is busy (previous request still running)`)
    this.name = 'SessionBusyError'
  }
}

interface Waiter {
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
  signal: AbortSignal | undefined
  abortHandler: (() => void) | undefined
  settled: boolean
}

interface SessionMutex {
  locked: boolean
  waiters: Waiter[]
}

const sessionMutexes = new Map<string, SessionMutex>()

function getMutex(sessionId: string): SessionMutex {
  let mutex = sessionMutexes.get(sessionId)
  if (!mutex) {
    mutex = { locked: false, waiters: [] }
    sessionMutexes.set(sessionId, mutex)
  }
  return mutex
}

function abortError(): Error {
  const err = new Error('Lock wait aborted')
  err.name = 'AbortError'
  return err
}

function removeWaiter(mutex: SessionMutex, waiter: Waiter): void {
  const idx = mutex.waiters.indexOf(waiter)
  if (idx >= 0) mutex.waiters.splice(idx, 1)
}

/** 清除等待者的定时器/abort 监听；只在 waiter 尚未被授予锁时调用。 */
function cleanupWaiter(waiter: Waiter): void {
  if (waiter.timer !== undefined) {
    clearTimeout(waiter.timer)
    waiter.timer = undefined
  }
  if (waiter.signal && waiter.abortHandler) {
    waiter.signal.removeEventListener('abort', waiter.abortHandler)
    waiter.abortHandler = undefined
  }
}

/**
 * 创建一次性的 release 函数。释放时把锁 handoff 给队首，或清空 locked。
 * 同一个 release 重复调用幂等（防止路由 finally 与 stream finally 双释放）。
 */
function makeRelease(sessionId: string, mutex: SessionMutex): () => void {
  let released = false
  return () => {
    if (released) return
    released = true

    const next = mutex.waiters.shift()
    if (next) {
      next.settled = true
      cleanupWaiter(next)
      next.resolve(makeRelease(sessionId, mutex))
      return
    }

    mutex.locked = false
    if (sessionMutexes.get(sessionId) === mutex) {
      sessionMutexes.delete(sessionId)
    }
  }
}

export async function acquireSessionLock(
  sessionId: string,
  signal?: AbortSignal,
  opts?: { timeoutMs?: number },
): Promise<() => void> {
  const timeoutMs = opts?.timeoutMs ?? LOCK_TIMEOUT_MS

  // 请求在拿锁前已经取消：不要占用锁，也不要启动后台执行。
  if (signal?.aborted) throw abortError()

  const mutex = getMutex(sessionId)
  if (!mutex.locked) {
    mutex.locked = true
    return makeRelease(sessionId, mutex)
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: undefined,
      signal,
      abortHandler: undefined,
      settled: false,
    }

    const fail = (err: Error) => {
      if (waiter.settled) return
      waiter.settled = true
      cleanupWaiter(waiter)
      removeWaiter(mutex, waiter)
      reject(err)
    }

    waiter.timer = setTimeout(() => fail(new SessionBusyError(sessionId)), timeoutMs)

    if (signal) {
      waiter.abortHandler = () => fail(abortError())
      signal.addEventListener('abort', waiter.abortHandler, { once: true })
    }

    mutex.waiters.push(waiter)
  })
}
