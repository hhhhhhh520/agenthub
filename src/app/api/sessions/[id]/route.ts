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
      members: { include: { agent: true } },
      tasks: true,
      messages: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }
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
