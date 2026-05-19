import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const agents = await prisma.agent.findMany({ where: { sessionId: id } })
  return NextResponse.json(agents)
}
