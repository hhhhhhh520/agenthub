import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { maskApiKey } from '@/lib/utils'

// Use raw SQL because Prisma 7 LibSQL adapter may not expose new model delegates
// until dev server restart. Raw queries work regardless.

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const key = searchParams.get('key')

    if (key) {
      const rows = await prisma.$queryRaw<Array<{ key: string; value: string; updatedAt: Date }>>
        `SELECT key, value, updatedAt FROM AppConfig WHERE key = ${key}`
      const value = rows[0]?.value || ''
      const masked = key.endsWith('_apiKey') || key.endsWith('_api_key') ? maskApiKey(value) : value
      return NextResponse.json({ key, value: masked })
    }

    const all = await prisma.$queryRaw<Array<{ key: string; value: string; updatedAt: Date }>>
      `SELECT key, value, updatedAt FROM AppConfig`
    const config: Record<string, string> = {}
    for (const row of all) {
      config[row.key] = row.key.endsWith('_apiKey') || row.key.endsWith('_api_key')
        ? maskApiKey(row.value)
        : row.value
    }
    return NextResponse.json(config)
  } catch (e) {
    console.error('[config] GET error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, string>

    for (const [key, value] of Object.entries(body)) {
      if (typeof key !== 'string' || typeof value !== 'string') continue
      await prisma.$executeRaw
        `INSERT OR REPLACE INTO AppConfig (key, value, updatedAt) VALUES (${key}, ${value}, datetime('now'))`
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('[config] POST error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}