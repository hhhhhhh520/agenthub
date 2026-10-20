import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { processRegistry } from '@/lib/adapter/process-registry'
import { requestSessionCancel, clearSessionCancel } from '@/lib/cancellation'
import { waitForSessionUnlock } from '@/lib/session-lock'

/**
 * 用户主动停止当前执行（不删除会话）。
 *
 * 与 HTTP 断开的区别：断开只影响连接，后台继续；stop 才真正取消执行并杀进程。
 * 不拿会话锁——要停的正是持锁的执行流；拿锁会等到执行结束，失去停止语义。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params

  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true } })
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // 1) 置取消标记：新执行/重试/进程重建立即被拒。
  requestSessionCancel(sessionId)

  // 2) 终止该会话所有归属进程，等待真实退出（内部有界：5s 优雅 + 5s 强制）。
  const kill = await processRegistry.cancelByOwnerSession(sessionId, { graceMs: 5_000, forceMs: 5_000 })

  // 3) 等待业务 finally 收敛（当前 chat/redo 持锁流退出后释放）。
  const unlocked = await waitForSessionUnlock(sessionId, 15_000)

  const stopped = kill.unconfirmed.length === 0 && unlocked
  // 只有确认进程全退出且业务锁释放后才清除取消标记，允许用户再次执行。
  // 未确认时保留标记，避免旧进程被杀期间又被新请求重建。
  if (stopped) clearSessionCancel(sessionId)

  return NextResponse.json(
    {
      stopped,
      unlocked,
      total: kill.total,
      exited: kill.exited,
      unconfirmed: kill.unconfirmed,
    },
    { status: stopped ? 200 : 202 },
  )
}
