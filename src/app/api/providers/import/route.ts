import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(request: Request) {
  const { provider, agentType, baseUrl, model, apiKey, agentId } = await request.json()

  if (!provider || !apiKey || !baseUrl) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  // If agentId provided, update that agent's provider config
  if (agentId) {
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: { baseUrl, model, apiKey },
      })
      return NextResponse.json({ success: true, message: `Agent updated with ${provider} config` })
    } catch {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
  }

  // Otherwise, return the config for the caller to use
  return NextResponse.json({ success: true, provider, baseUrl, model, apiKey })
}
