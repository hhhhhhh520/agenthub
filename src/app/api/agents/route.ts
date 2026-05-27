import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const preset = searchParams.get('preset')

  const where = preset === 'true' ? { isPreset: true } : {}
  const agents = await prisma.agent.findMany({
    where,
    orderBy: { name: 'asc' },
    select: { id:true, name:true, expertise:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true, status:true },
  })
  return NextResponse.json(agents)
}

export async function POST(request: Request) {
  const body = await request.json()
  const { name, expertise, systemPrompt, platform, model, tools, capabilities, accentColor } = body

  if (!name || !expertise || !systemPrompt || typeof name !== 'string' || typeof expertise !== 'string' || typeof systemPrompt !== 'string') {
    return NextResponse.json(
      { error: 'name, expertise, systemPrompt are required strings' },
      { status: 400 }
    )
  }

  if (/<[a-zA-Z][^>]*>/.test(name)) {
    return NextResponse.json({ error: 'Agent name must not contain HTML tags' }, { status: 400 })
  }

  if (platform !== undefined && typeof platform !== 'string') {
    return NextResponse.json({ error: 'platform must be a string' }, { status: 400 })
  }
  if (accentColor !== undefined && typeof accentColor !== 'string') {
    return NextResponse.json({ error: 'accentColor must be a string' }, { status: 400 })
  }

  try {
    const agent = await prisma.agent.create({
      data: {
        name,
        expertise,
        systemPrompt,
        platform: platform || 'claude-code',
        model: model || '',
        tools: JSON.stringify(tools || []),
        capabilities: JSON.stringify(capabilities || []),
        accentColor: accentColor || '#6366f1',
        isPreset: false,
      },
      select: { id:true, name:true, expertise:true, systemPrompt:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true, status:true },
    })
    return NextResponse.json(agent, { status: 201 })
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as { code: string }).code === 'P2002') {
      return NextResponse.json({ error: 'Agent name already exists' }, { status: 409 })
    }
    throw e
  }
}
