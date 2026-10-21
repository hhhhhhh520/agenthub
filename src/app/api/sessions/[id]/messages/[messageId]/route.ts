import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const { id: sessionId, messageId } = await params
  const { isPinned } = await request.json().catch(() => ({}))

  if (typeof isPinned !== 'boolean') {
    return NextResponse.json({ error: 'isPinned must be boolean' }, { status: 400 })
  }

  // P3 #18: Pin 上限的 count→update 必须在同一事务内完成；否则并发请求都读到 9，
  // 各自 update 后超过 10。SQLite 事务串行化写，保证上限是硬约束。
  const result = await prisma.$transaction(async tx => {
    const existing = await tx.message.findFirst({
      where: { id: messageId, sessionId },
    })
    if (!existing) return { kind: 'notfound' as const }

    if (isPinned) {
      const count = await tx.message.count({ where: { sessionId, isPinned: true } })
      if (count >= 10) return { kind: 'limit' as const }
    }

    const message = await tx.message.update({
      where: { id: messageId, sessionId },
      data: { isPinned },
    })
    return { kind: 'ok' as const, message }
  })

  if (result.kind === 'notfound') {
    return NextResponse.json({ error: '消息不存在' }, { status: 404 })
  }
  if (result.kind === 'limit') {
    return NextResponse.json({ error: '每会话最多 Pin 10 条消息' }, { status: 400 })
  }

  return NextResponse.json(result.message)
}
