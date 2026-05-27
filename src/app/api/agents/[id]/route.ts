import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const agent = await prisma.agent.findUnique({
    where: { id },
    select: { id:true, name:true, expertise:true, systemPrompt:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true, status:true },
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

  const { name, expertise, systemPrompt, platform, model, baseUrl, apiKey, tools, capabilities, accentColor } = body

  const updated = await prisma.agent.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(expertise !== undefined && { expertise }),
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(platform !== undefined && { platform }),
      ...(model !== undefined && { model }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(apiKey !== undefined && { apiKey }),
      ...(tools !== undefined && { tools: JSON.stringify(tools) }),
      ...(capabilities !== undefined && { capabilities: JSON.stringify(capabilities) }),
      ...(accentColor !== undefined && { accentColor }),
    },
    select: { id:true, name:true, expertise:true, systemPrompt:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true, status:true },
  })
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
