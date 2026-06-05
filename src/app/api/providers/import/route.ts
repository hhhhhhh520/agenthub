import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { resolveProvider } from '@/lib/provider-resolve'

export async function POST(request: Request) {
  const { provider, agentId } = await request.json()

  if (!provider) {
    return NextResponse.json({ error: 'Missing provider name' }, { status: 400 })
  }

  // Resolve real apiKey from all sources (never trust browser-sent apiKey)
  const resolved = await resolveProvider(provider)

  if (!resolved) {
    return NextResponse.json({ error: `Provider "${provider}" not found` }, { status: 404 })
  }

  // If agentId provided, update that agent's provider config with real apiKey
  if (agentId) {
    try {
      const agent = await prisma.agent.update({
        where: { id: agentId },
        data: { baseUrl: resolved.baseUrl, model: resolved.model, apiKey: resolved.apiKey },
        select: { id: true, name: true },
      })
      return NextResponse.json({ success: true, agent })
    } catch {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
  }

  // No agentId — create a new agent with this provider config
  try {
    const agent = await prisma.agent.create({
      data: {
        name: provider,
        expertise: 'general',
        systemPrompt: `You are ${provider}, a helpful AI assistant.`,
        platform: 'claude-code',
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
      },
      select: { id: true, name: true, expertise: true, platform: true },
    })
    return NextResponse.json({ success: true, agent }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 })
  }
}
