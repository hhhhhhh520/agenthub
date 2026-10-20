/**
 * 会话取消源（leaf module，无依赖）。
 *
 * 语义边界：
 * - 客户端 HTTP 断开 ≠ 取消：断开只影响连接，后台执行继续，锁由调用方 finally 释放；
 * - 用户 stop / delete 才调用 requestSessionCancel；
 * - 取消是幂等的：重复 request 不会产生第二个 controller；
 * - clearSessionCancel 只应在执行已收敛（进程退出 + 锁释放）后调用，否则可能
 *   让仍在跑的旧执行重新 spawn。
 */

const controls = new Map<string, AbortController>()

export class SessionCancelledError extends Error {
  readonly code = 'SESSION_CANCELLED' as const
  constructor(sessionId: string) {
    super(`Session ${sessionId} cancelled`)
    this.name = 'SessionCancelledError'
  }
}

/** 请求取消；返回该 session 的 AbortSignal（同一 session 始终同一个 controller）。 */
export function requestSessionCancel(sessionId: string): AbortSignal {
  let controller = controls.get(sessionId)
  if (!controller) {
    controller = new AbortController()
    controls.set(sessionId, controller)
  }
  if (!controller.signal.aborted) controller.abort()
  return controller.signal
}

export function isSessionCancelled(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return controls.get(sessionId)?.signal.aborted === true
}

export function getSessionCancelSignal(sessionId: string | null | undefined): AbortSignal | undefined {
  if (!sessionId) return undefined
  return controls.get(sessionId)?.signal
}

/** 执行已收敛后清除取消标记，允许用户再次执行。 */
export function clearSessionCancel(sessionId: string): void {
  controls.delete(sessionId)
}

/** 执行/决策边界统一使用的 fail-fast 检查。 */
export function throwIfSessionCancelled(sessionId: string | null | undefined): void {
  if (sessionId && isSessionCancelled(sessionId)) {
    throw new SessionCancelledError(sessionId)
  }
}
