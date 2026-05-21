import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const messages = await prisma.message.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: 'asc' },
    include: {
      replyTo: { select: { id: true, rawContent: true, role: true } },
    },
  })
  return NextResponse.json(messages)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const { role, rawContent, agentId, taskId, replyToId } = await request.json()

  if (!role || rawContent === undefined) {
    return NextResponse.json({ error: 'role and rawContent are required' }, { status: 400 })
  }

  if (replyToId) {
    const target = await prisma.message.findUnique({ where: { id: replyToId } })
    if (!target) {
      return NextResponse.json({ error: 'Referenced message not found' }, { status: 400 })
    }
    if (target.sessionId !== sessionId) {
      return NextResponse.json({ error: 'Referenced message belongs to different session' }, { status: 400 })
    }
  }

  const message = await prisma.message.create({
    data: { role, rawContent, sessionId, agentId, taskId, replyToId },
  })
  return NextResponse.json(message, { status: 201 })
}
