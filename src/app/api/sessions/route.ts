import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const DIR_SLUGS: Record<string, string> = {
  '前端工程师': 'frontend',
  '后端工程师': 'backend',
  '测试工程师': 'test',
  '架构师': 'architect',
  '产品经理': 'product',
  'UI 设计师': 'designer',
  'Orchestrator': 'orchestrator',
}

function hasLoneSurrogates(str: string): boolean {
  let i = 0
  while (i < str.length) {
    const code = str.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      // High surrogate — must be followed by a low surrogate
      const next = str.charCodeAt(i + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
      i += 2
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      // Lone low surrogate
      return true
    } else {
      i++
    }
  }
  return false
}

export async function GET() {
  const sessions = await prisma.session.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true, members: true } } },
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

    // 为每个 Agent 创建独立子目录
    if (projectDir && projectDir.trim()) {
      const rootDir = projectDir.trim().replace(/\\/g, '/')
      // 确保根目录存在
      if (!existsSync(rootDir)) {
        mkdirSync(rootDir, { recursive: true })
      }
      for (const agent of agents) {
        const slug = DIR_SLUGS[agent.name] || agent.name.toLowerCase().replace(/\s+/g, '-')
const agentDir = join(rootDir, slug)
        try {
          if (!existsSync(agentDir)) {
            mkdirSync(agentDir, { recursive: true })
          }
        } catch {
          // 静默失败，不影响主流程
        }
      }
    }
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

      // 为每个 Agent 创建独立子目录
      if (projectDir && projectDir.trim()) {
        const rootDir = projectDir.trim().replace(/\\/g, '/')
        // 确保根目录存在
        if (!existsSync(rootDir)) {
          mkdirSync(rootDir, { recursive: true })
        }
        for (const agent of presetAgents) {
          const slug = DIR_SLUGS[agent.name] || agent.name.toLowerCase().replace(/\s+/g, '-')
const agentDir = join(rootDir, slug)
          try {
            if (!existsSync(agentDir)) {
              mkdirSync(agentDir, { recursive: true })
            }
          } catch {
            // 静默失败，不影响主流程
          }
        }
      }
    }
  }

  return NextResponse.json(session)
}
