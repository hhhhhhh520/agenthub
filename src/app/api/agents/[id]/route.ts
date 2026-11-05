import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { invalidateAgentCliSessions } from '@/lib/services/cli-session'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const agent = await prisma.agent.findUnique({
    where: { id },
    select: { id:true, name:true, expertise:true, systemPrompt:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true },
  })
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  return NextResponse.json(agent)
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()

  const agent = await prisma.agent.findUnique({ where: { id } })
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const { name, expertise, systemPrompt, platform, model, baseUrl, apiKey, tools, capabilities, accentColor, providerRef } = body

  const identityChanged =
    (name !== undefined && name !== agent.name) ||
    (systemPrompt !== undefined && systemPrompt !== agent.systemPrompt) ||
    (platform !== undefined && platform !== agent.platform)

  // #34 修复 ④:providerRef 路径——服务端解析真 apiKey,前端永远不传明文
  let resolvedApiKey: string | undefined
  let resolvedBaseUrl: string | undefined
  if (providerRef) {
    if (typeof providerRef === 'string') {
      const provider = await prisma.provider.findUnique({
        where: { id: providerRef },
        select: { apiKey: true, baseUrl: true },
      })
      if (!provider) {
        return NextResponse.json({ error: 'providerRef not found' }, { status: 400 })
      }
      resolvedApiKey = provider.apiKey
      resolvedBaseUrl = provider.baseUrl
    } else if (typeof providerRef === 'object' && typeof providerRef.name === 'string') {
      const { resolveProvider } = await import('@/lib/provider-resolve')
      const resolved = await resolveProvider(providerRef.name)
      if (!resolved) {
        return NextResponse.json({ error: 'providerRef not found' }, { status: 400 })
      }
      resolvedApiKey = resolved.apiKey
      resolvedBaseUrl = resolved.baseUrl
    } else {
      return NextResponse.json({ error: 'providerRef must be string id or { name }' }, { status: 400 })
    }
  }

  const updated = await prisma.agent.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(expertise !== undefined && { expertise }),
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(platform !== undefined && { platform }),
      ...(model !== undefined && { model }),
      // baseUrl / apiKey:providerRef 优先,否则用 body 值
      ...(resolvedBaseUrl !== undefined ? { baseUrl: resolvedBaseUrl } : (baseUrl && { baseUrl })),
      ...(resolvedApiKey !== undefined ? { apiKey: resolvedApiKey } : (apiKey && { apiKey })),
      ...(tools !== undefined && { tools: JSON.stringify(tools) }),
      ...(capabilities !== undefined && { capabilities: JSON.stringify(capabilities) }),
      ...(accentColor !== undefined && { accentColor }),
    },
    select: { id:true, name:true, expertise:true, systemPrompt:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true },
  })

  // U6: 角色名 / systemPrompt / 平台变了，旧 CLI 会话里的身份记忆就是脏数据。
  // 清掉该 Agent 在所有会话/任务上的 cliSessionId，让下一次执行起全新 CLI 会话。
  if (identityChanged) {
    try {
      await invalidateAgentCliSessions(id)
    } catch (err) {
      console.warn(
        `[agents/:id] 身份变更后清理 cliSessionId 失败: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return NextResponse.json(updated)
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const agent = await prisma.agent.findUnique({ where: { id } })
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  if (agent.isPreset) {
    return NextResponse.json({ error: 'Cannot delete preset agent' }, { status: 403 })
  }

  await prisma.agent.delete({ where: { id } })
  return NextResponse.json({ success: true })
}
