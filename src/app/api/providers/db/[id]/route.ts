import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const provider = await prisma.provider.findUnique({
    where: { id },
    select: { id: true, name: true, baseUrl: true, apiKey: true, model: true, category: true, createdAt: true },
  })
  if (!provider) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  }
  return NextResponse.json(provider)
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()

  const provider = await prisma.provider.findUnique({ where: { id } })
  if (!provider) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  }

  const { name, baseUrl, apiKey, model, category } = body

  const updated = await prisma.provider.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: name.trim() }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(apiKey && { apiKey }),
      ...(model !== undefined && { model }),
      ...(category !== undefined && { category }),
    },
    select: { id: true, name: true, baseUrl: true, apiKey: true, model: true, category: true, createdAt: true },
  })
  return NextResponse.json(updated)
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const provider = await prisma.provider.findUnique({ where: { id } })
  if (!provider) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  }

  await prisma.provider.delete({ where: { id } })
  return NextResponse.json({ success: true })
}
