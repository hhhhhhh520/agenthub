/**
 * 会话生命周期标记（leaf module，无依赖）。
 *
 * DELETE 从开始取消到 DB 删除完成全程保持 deleting；chat/redo 等执行入口在
 * 拿锁前与拿锁后检查，避免在“锁已释放、记录尚未删除”的窗口启动新执行。
 *
 * 仅进程内状态：多实例/多进程一致性不在 P2-03 范围内。
 */

const deletingSessions = new Set<string>()

export function markSessionDeleting(sessionId: string): void {
  deletingSessions.add(sessionId)
}

export function isSessionDeleting(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return deletingSessions.has(sessionId)
}

/** DELETE 成功或失败收敛后调用；失败时也必须清理，避免会话永久不可重试。 */
export function clearSessionDeleting(sessionId: string): void {
  deletingSessions.delete(sessionId)
}
