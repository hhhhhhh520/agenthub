import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { cleanupAttachmentFiles } from '@/lib/attachment-cleanup'
import { cleanupShadowGit } from '@/lib/services/shadow-git'
import { requestSessionCancel, clearSessionCancel } from '@/lib/cancellation'
import { markSessionDeleting, clearSessionDeleting, isSessionDeleting } from '@/lib/session-lifecycle'
import { waitForSessionUnlock } from '@/lib/session-lock'
import { isPermissionMode } from '@/lib/permission-mode'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await prisma.session.findUnique({
    where: { id },
    // P4 T5: decisionTrace 是内部 analytics（决策审计），不回给客户端——前端不需要，且挖掘数据
    // 将由 /api/sessions/[id]/process 端点提供（P4 T4 落地）。GET 是前端轮询端点，外泄审计数据无益。
    omit: { decisionTrace: true },
    include: {
      members: {
        include: {
          agent: {
            select: { id:true, name:true, expertise:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true, status:true },
          },
        },
      },
      tasks: true,
      // [PLAN_APPROVED] 等内部审批记录只供服务端 gate 使用，不回给聊天 UI。
      messages: { where: { role: { not: 'system' } }, orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // 断点续跑：重置超过 5 分钟未更新的 in_progress 任务（避免与活跃 Agent 竞态）
  const STUCK_THRESHOLD_MS = 5 * 60 * 1000
  const stuckTasks = await prisma.task.findMany({
    where: {
      sessionId: id,
      status: 'in_progress',
      updatedAt: { lt: new Date(Date.now() - STUCK_THRESHOLD_MS) },
    },
    select: { id: true },
  })
  if (stuckTasks.length > 0) {
    const stuckIds = stuckTasks.map(t => t.id)
    await prisma.task.updateMany({
      // §3.2: status 前置条件——findMany 与 updateMany 之间执行流可能已把任务写 completed，
      // 无条件重置会丢结果 + 造成 DB pending / 内存 completed 漂移（审查抓出）
      where: { id: { in: stuckIds }, status: 'in_progress' },
      data: { status: 'pending' },
    })
    for (const task of session.tasks) {
      if (stuckIds.includes(task.id)) task.status = 'pending'
    }
  }

  // decisionTrace 已由 findUnique omit 排除（P4 T5 审查整改: 同 class 泄漏面全收敛——GET/PUT/list 三处）
  return NextResponse.json({ ...session, recoveredTaskCount: stuckTasks.length })
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()
  const { title, projectDir, permissionMode, isPinned, isArchived } = body
  if (permissionMode !== undefined && !isPermissionMode(permissionMode)) {
    return NextResponse.json({ error: 'permissionMode must be default or auto' }, { status: 400 })
  }
  const data: Record<string, unknown> = {}
  if (title !== undefined) data.title = title
  if (projectDir !== undefined) data.projectDir = projectDir
  if (permissionMode !== undefined) data.permissionMode = permissionMode
  if (isPinned !== undefined) data.isPinned = isPinned
  if (isArchived !== undefined) data.isArchived = isArchived
  const session = await prisma.session.update({
    where: { id },
    data,
    // P4 T5 审查整改: PUT 返回体同样排除 decisionTrace（前端 PUT 调用方不消费响应体,泄漏无益）
    omit: { decisionTrace: true },
  })
  return NextResponse.json(session)
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // ❌-3 修复:删 session 前先查 projectDir,以便清理影子 git 目录
  // 防止 .agenthub/shadow-git/{sessionId}/ 在用户 projectRoot 下永久驻留
  const sess = await prisma.session.findUnique({
    where: { id },
    select: { projectDir: true },
  })
  if (!sess) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // 删除 = 标记 deleting → 取消 → 阻止重建 → 杀并等待真实退出 → 等业务 finally → 再删数据。
  // 任一步未确认都返回 409/500，不删 DB，避免“进程还在写、记录已消失”。
  // deleting 必须在取消前建立，并保持到 DB 删除完成；失败路径由 finally 清理以便重试。
  // F5: 同一 session 的并发 DELETE 只允许第一个持有 deleting。第二个若继续走并失败，
  // 其 finally 会清掉第一个的公共标记，随后 stop 会误清取消标记并放行新执行。
  if (isSessionDeleting(id)) {
    return NextResponse.json({ error: '会话正在删除中，请稍后重试' }, { status: 409 })
  }
  markSessionDeleting(id)
  try {
    requestSessionCancel(id)
    const { processRegistry } = await import('@/lib/adapter/process-registry')
    const kill = await processRegistry.cancelByOwnerSession(id, { graceMs: 5_000, forceMs: 5_000 })
    const unlocked = await waitForSessionUnlock(id, 30_000)
    if (kill.unconfirmed.length > 0 || !unlocked) {
      return NextResponse.json(
        {
          error: '会话仍在停止中，未删除',
          total: kill.total,
          exited: kill.exited,
          unconfirmed: kill.unconfirmed,
          unlocked,
        },
        { status: 409 },
      )
    }

    // Clean up attachment files before deleting session (cascade deletes DB records)
    const attachments = await prisma.attachment.findMany({
      where: { sessionId: id },
      select: { path: true },
    })
    await cleanupAttachmentFiles(attachments)

    // ❌-3: 清影子 git。失败不阻塞删除(用户已选择删 session)
    if (sess.projectDir) {
      try {
        cleanupShadowGit(sess.projectDir, id)
      } catch (e) {
        console.warn(`[DELETE /sessions/${id}] cleanupShadowGit 失败,目录可能需手动清理:`, e)
      }
    }

    await prisma.session.delete({ where: { id } })
    clearSessionCancel(id)
    return NextResponse.json({ success: true })
  } finally {
    // 成功时此时 DB 已删、取消标记已清；失败时保留取消标记（防止旧进程重建），
    // 但必须清 deleting，否则该会话无法重试删除、stop 也会永远认为它在删除中。
    clearSessionDeleting(id)
  }
}
