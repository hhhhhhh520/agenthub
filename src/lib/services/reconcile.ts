/**
 * §3.3 执行中断恢复语义——启动 reconcile（roadmap；参考 codeg reconcile 精神：
 * 以可验证的残留状态为裁决主动收敛，而非依赖锁超时行为或前端在线触发）。
 *
 * 现状缺口：批次中断（进程崩溃 / handler 被杀）后任务永久 in_progress、SessionMember
 * 永久 working——既有恢复路径只有 GET /api/sessions/[id] 的 5 分钟 stuck reset，
 * 前端不开会话页就永不触发。本模块由 instrumentation 在启动时调用（单实例启动时刻
 * 必无活跃执行流，in_progress 即"未完成"的可信证据）。
 *
 * 语义：
 *   1. 只收敛"中断残留"：in_progress → pending（条件写 where 带 status 前置——§3.2 纪律，
 *      findMany 与 updateMany 之间的转移不会被打回）；working 成员 → idle（状态圆点残留）。
 *   2. phase 留 execution 不动（ISSUE-011 F2 拍板：便于下次消息继续执行遗留任务）。
 *   3. 半成品文件不做清理（拍板）：AgentHub 无每任务 git 边界（codeg 依赖其 landed commit
 *      结构），无法可靠区分半成品与有效产出；恢复语义 = 置 pending 重跑、由 agent 覆盖产出。
 *   4. 恢复后用户续跑走 handleExecution → createEventLogger 落库 → 前端 EventSource 补发
 *      （§3.1 衔接，恢复动作本身发生在启动期、无 SSE 连接，留日志即可）。
 *
 * DB 异常向上抛：instrumentation 的 best-effort 容错负责吞掉，本函数保持单一职责。
 */

import { prisma } from '@/lib/db'

/** 启动收敛：返回实际重置的任务数（count=0 表示残留已被其他写者收敛，弃权不留痕） */
export async function reconcileInterruptedSessions(): Promise<number> {
  // working 状态圆点残留无条件收敛（UI 可见的"假工作中"）——成员残留与任务残留不必然
  // 共存（对齐/讨论期崩溃零任务、GET stuck reset 恢复过的会话只清任务、两次写之间崩溃），
  // 不能被任务残留的早退门禁锁死（审查 F1）。启动期单实例无活跃流，置 idle 恒安全。
  await prisma.sessionMember.updateMany({
    where: { status: 'working' },
    data: { status: 'idle' },
  })

  const stuck = await prisma.task.findMany({
    where: { status: 'in_progress' },
    select: { id: true, sessionId: true },
  })
  if (stuck.length === 0) return 0

  // §3.2 纪律：id 限定 + status 前置——findMany 与 updateMany 之间被推进的任务不打回
  const res = await prisma.task.updateMany({
    where: { id: { in: stuck.map(t => t.id) }, status: 'in_progress' },
    data: { status: 'pending' },
  })
  if (res.count === 0) return 0

  // 恢复留痕：按会话汇总（可见性——哪些会话有中断、规模多大）
  const bySession = new Map<string, number>()
  for (const t of stuck) bySession.set(t.sessionId, (bySession.get(t.sessionId) ?? 0) + 1)
  for (const [sessionId, n] of bySession) {
    console.warn(`[startup] 中断恢复：会话 ${sessionId} 的 ${n} 个 in_progress 任务已重置为 pending，下次执行时继续`)
  }
  return res.count
}
