import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

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
  return NextResponse.json(session)
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()
  const { title, projectDir, permissionMode } = body
  const data: Record<string, unknown> = {}
  if (title !== undefined) data.title = title
  if (projectDir !== undefined) data.projectDir = projectDir
  if (permissionMode !== undefined) data.permissionMode = permissionMode
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
  await prisma.session.delete({ where: { id } })
  return NextResponse.json({ success: true })
}
