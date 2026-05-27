import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const recentDirs = await prisma.recentDir.findMany({
    orderBy: { lastUsed: 'desc' },
    take: 10,
  })
  return NextResponse.json(recentDirs)
}

export async function POST(request: Request) {
  const { path } = await request.json()

  if (!path || !path.trim()) {
    return NextResponse.json({ error: '路径不能为空' }, { status: 400 })
  }

  const recentDir = await prisma.recentDir.upsert({
    where: { path: path.trim() },
    update: { lastUsed: new Date(), useCount: { increment: 1 } },
    create: { path: path.trim() },
  })

  return NextResponse.json(recentDir)
}

export async function DELETE(request: Request) {
  const { id } = await request.json()

  if (!id) {
    return NextResponse.json({ error: 'ID 不能为空' }, { status: 400 })
  }

  await prisma.recentDir.delete({ where: { id } })
  return NextResponse.json({ success: true })
}
