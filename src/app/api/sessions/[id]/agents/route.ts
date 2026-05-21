import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const members = await prisma.sessionMember.findMany({
    where: { sessionId: id },
    include: { agent: true },
  })
  return NextResponse.json(members.map(m => m.agent))
}
