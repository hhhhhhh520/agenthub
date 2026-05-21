import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const sessions = await prisma.session.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true, members: true } } },
  })
  return NextResponse.json(sessions)
}

export async function POST(request: Request) {
  const { title, type } = await request.json()
  const session = await prisma.session.create({
    data: { title: title || '新会话', type: type || 'group' },
  })

  // Auto-add preset agents to the session
  const presetAgents = await prisma.agent.findMany({ where: { isPreset: true } })
  if (presetAgents.length > 0) {
    await prisma.sessionMember.createMany({
      data: presetAgents.map(agent => ({
        sessionId: session.id,
        agentId: agent.id,
        role: agent.name === '架构师' ? 'orchestrator' : 'member',
      })),
    })
  }

  return NextResponse.json(session)
}
