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
  const { title, type, agentIds } = await request.json()
  const session = await prisma.session.create({
    data: { title: title || '新会话', type: type || 'group' },
  })

  // Private sessions: no auto-add (handled by onPrivateChat)
  if (type === 'private') {
    return NextResponse.json(session)
  }

  // If agentIds provided, add only those agents
  if (Array.isArray(agentIds) && agentIds.length > 0) {
    const agents = await prisma.agent.findMany({ where: { id: { in: agentIds } } })
    await prisma.sessionMember.createMany({
      data: agents.map(agent => ({
        sessionId: session.id,
        agentId: agent.id,
        role: agent.name === '架构师' ? 'orchestrator' : 'member',
      })),
    })
  } else {
    // No agentIds: add all preset agents (legacy behavior)
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
  }

  return NextResponse.json(session)
}
