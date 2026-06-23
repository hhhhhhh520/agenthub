import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { maskApiKey } from '@/lib/utils'

export async function GET() {
  const providers = await prisma.provider.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, baseUrl: true, apiKey: true, model: true, category: true, createdAt: true },
  })
  // #34: 出站前掩码 apiKey,防 F12 抓包明文泄露
  return NextResponse.json(providers.map(p => ({ ...p, apiKey: maskApiKey(p.apiKey) })))
}

export async function POST(request: Request) {
  const body = await request.json()
  const { name, baseUrl, apiKey, model, category } = body

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  try {
    const provider = await prisma.provider.create({
      data: {
        name: name.trim(),
        baseUrl: baseUrl || '',
        apiKey: apiKey || '',
        model: model || '',
        category: category || 'custom',
      },
      select: { id: true, name: true, baseUrl: true, apiKey: true, model: true, category: true, createdAt: true },
    })
    // #34: 出站前掩码
    return NextResponse.json({ ...provider, apiKey: maskApiKey(provider.apiKey) }, { status: 201 })
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as { code: string }).code === 'P2002') {
      return NextResponse.json({ error: 'Provider name already exists' }, { status: 409 })
    }
    throw e
  }
}
