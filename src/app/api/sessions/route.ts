import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const sessions = await prisma.session.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true, agents: true } } },
  })
  return NextResponse.json(sessions)
}

export async function POST(request: Request) {
  const { title } = await request.json()
  const session = await prisma.session.create({
    data: { title: title || '新会话' },
  })
  return NextResponse.json(session)
}
