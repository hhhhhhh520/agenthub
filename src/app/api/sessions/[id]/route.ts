import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { cleanupAttachmentFiles } from '@/lib/attachment-cleanup'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await prisma.session.findUnique({
    where: { id },
    include: {
      members: {
        include: {
          agent: {
            select: { id:true, name:true, expertise:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true, status:true },
          },
        },
      },
      tasks: true,
      messages: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // 断点续跑：统计并重置卡住的 in_progress 任务
  const stuckTasks = await prisma.task.findMany({
    where: { sessionId: id, status: 'in_progress' },
    select: { id: true },
  })
  if (stuckTasks.length > 0) {
    await prisma.task.updateMany({
      where: { sessionId: id, status: 'in_progress' },
      data: { status: 'pending' },
    })
    // 同步更新返回数据中 tasks 的状态
    for (const task of session.tasks) {
      if (task.status === 'in_progress') task.status = 'pending'
    }
  }

  return NextResponse.json({ ...session, recoveredTaskCount: stuckTasks.length })
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()
  const { title, projectDir, permissionMode, isPinned, isArchived } = body
  const data: Record<string, unknown> = {}
  if (title !== undefined) data.title = title
  if (projectDir !== undefined) data.projectDir = projectDir
  if (permissionMode !== undefined) data.permissionMode = permissionMode
  if (isPinned !== undefined) data.isPinned = isPinned
  if (isArchived !== undefined) data.isArchived = isArchived
  const session = await prisma.session.update({
    where: { id },
    data,
  })
  return NextResponse.json(session)
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // Clean up attachment files before deleting session (cascade deletes DB records)
  const attachments = await prisma.attachment.findMany({
    where: { sessionId: id },
    select: { path: true },
  })
  await cleanupAttachmentFiles(attachments)
  await prisma.session.delete({ where: { id } })
  return NextResponse.json({ success: true })
}
