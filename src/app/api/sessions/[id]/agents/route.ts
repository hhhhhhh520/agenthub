import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const members = await prisma.sessionMember.findMany({
    where: { sessionId: id },
    include: {
      agent: {
        select: { id:true, name:true, expertise:true, platform:true, model:true, baseUrl:true, tools:true, isPreset:true, accentColor:true, capabilities:true, status:true },
      },
    },
  })
  return NextResponse.json(members.map(m => m.agent))
}
