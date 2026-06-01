import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const { id: sessionId, messageId } = await params
  const { isPinned } = await request.json()

  if (typeof isPinned !== 'boolean') {
    return NextResponse.json({ error: 'isPinned must be boolean' }, { status: 400 })
  }

  // Pin 时检查数量限制
  if (isPinned) {
    const count = await prisma.message.count({ where: { sessionId, isPinned: true } })
    if (count >= 10) {
      return NextResponse.json({ error: '每会话最多 Pin 10 条消息' }, { status: 400 })
    }
  }

  const message = await prisma.message.update({
    where: { id: messageId, sessionId },
    data: { isPinned },
  }).catch(() => null)

  if (!message) {
    return NextResponse.json({ error: '消息不存在' }, { status: 404 })
  }

  return NextResponse.json(message)
}
