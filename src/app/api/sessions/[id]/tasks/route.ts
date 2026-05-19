import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const tasks = await prisma.task.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json(tasks)
}
