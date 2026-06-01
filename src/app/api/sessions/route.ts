import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { hasLoneSurrogates } from '@/lib/utils'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const showArchived = searchParams.get('archived') === 'true'
  const sessions = await prisma.session.findMany({
    where: showArchived ? {} : { isArchived: false },
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { messages: true, members: true } },
      members: { select: { agentId: true } },
    },
  })
  return NextResponse.json(sessions)
}

export async function POST(request: Request) {
  const { title, type, agentIds, projectDir, permissionMode } = await request.json()
  if (title && hasLoneSurrogates(title)) {
    return NextResponse.json({ error: '标题包含无效编码，请使用 UTF-8 编码发送请求' }, { status: 400 })
  }
  const session = await prisma.session.create({
    data: {
      title: title || '新会话',
      type: type || 'group',
      projectDir: projectDir || '',
      permissionMode: permissionMode || 'default',
    },
  })

  // 保存最近打开的目录
  if (projectDir && projectDir.trim()) {
    const normalizedDir = projectDir.trim().replace(/\\/g, '/')
    try {
      await prisma.recentDir.upsert({
        where: { path: normalizedDir },
        update: { lastUsed: new Date(), useCount: { increment: 1 } },
        create: { path: normalizedDir },
      })
    } catch {
      // 静默失败，不影响主流程
    }
  }

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
