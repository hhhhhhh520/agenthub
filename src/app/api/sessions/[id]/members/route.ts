import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const members = await prisma.sessionMember.findMany({
    where: { sessionId },
    include: { agent: true },
    orderBy: { joinedAt: 'asc' },
  })
  return NextResponse.json(members)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const { agentId, role } = await request.json()

  if (!agentId) {
    return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
  }

  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  try {
    const member = await prisma.sessionMember.create({
      data: { sessionId, agentId, role: role || 'member' },
      include: { agent: true },
    })
    return NextResponse.json(member, { status: 201 })
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as { code: string }).code === 'P2002') {
      return NextResponse.json({ error: 'Agent already in session' }, { status: 409 })
    }
    throw e
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const { searchParams } = new URL(request.url)
  const agentId = searchParams.get('agentId')

  if (!agentId) {
    return NextResponse.json({ error: 'agentId query param is required' }, { status: 400 })
  }

  const member = await prisma.sessionMember.findUnique({
    where: { sessionId_agentId: { sessionId, agentId } },
  })
  if (!member) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  if (member.role === 'orchestrator') {
    return NextResponse.json({ error: 'Cannot remove orchestrator' }, { status: 403 })
  }

  await prisma.sessionMember.delete({
    where: { sessionId_agentId: { sessionId, agentId } },
  })
  return NextResponse.json({ success: true })
}
