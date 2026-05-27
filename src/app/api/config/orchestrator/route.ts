import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { maskApiKey } from '@/lib/utils'

export async function GET() {
  try {
    // 优先从 Orchestrator Agent 读取
    const orchAgent = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
    if (orchAgent) {
      return NextResponse.json({
        apiKey: orchAgent.apiKey ? maskApiKey(orchAgent.apiKey) : '',
        model: orchAgent.model || 'claude-sonnet-4-20250514',
        baseUrl: orchAgent.baseUrl || '',
        platform: orchAgent.platform,
      })
    }

    // fallback: 从 AppConfig 读取
    const rows = await prisma.$queryRaw<Array<{ key: string; value: string }>>
      `SELECT key, value FROM AppConfig WHERE key IN ('orchestrator_apiKey', 'orchestrator_model', 'orchestrator_baseUrl')`
    const config: Record<string, string> = {}
    for (const row of rows) {
      config[row.key] = row.key.endsWith('_apiKey') ? maskApiKey(row.value) : row.value
    }
    return NextResponse.json({
      apiKey: config.orchestrator_apiKey || '',
      model: config.orchestrator_model || 'claude-sonnet-4-20250514',
      baseUrl: config.orchestrator_baseUrl || '',
      platform: 'llm',
    })
  } catch (e) {
    console.error('[orchestrator] GET error:', e)
    return NextResponse.json({ apiKey: '', model: 'claude-sonnet-4-20250514', baseUrl: '', platform: 'llm', hasApiKey: false })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { apiKey?: string; model?: string; baseUrl?: string; platform?: string }

    // 同时更新 AppConfig（向后兼容）和 Orchestrator Agent
    if (body.apiKey !== undefined) {
      await prisma.$executeRaw
        `INSERT OR REPLACE INTO AppConfig (key, value, updatedAt) VALUES ('orchestrator_apiKey', ${body.apiKey}, datetime('now'))`
    }
    if (body.model !== undefined) {
      await prisma.$executeRaw
        `INSERT OR REPLACE INTO AppConfig (key, value, updatedAt) VALUES ('orchestrator_model', ${body.model}, datetime('now'))`
    }
    if (body.baseUrl !== undefined) {
      await prisma.$executeRaw
        `INSERT OR REPLACE INTO AppConfig (key, value, updatedAt) VALUES ('orchestrator_baseUrl', ${body.baseUrl || ''}, datetime('now'))`
    }

    // 更新 Orchestrator Agent 记录
    const orchAgent = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
    if (orchAgent) {
      const updateData: Record<string, string> = {}
      if (body.apiKey !== undefined) updateData.apiKey = body.apiKey
      if (body.model !== undefined) updateData.model = body.model
      if (body.baseUrl !== undefined) updateData.baseUrl = body.baseUrl
      if (body.platform !== undefined) updateData.platform = body.platform
      if (Object.keys(updateData).length > 0) {
        await prisma.agent.update({ where: { id: orchAgent.id }, data: updateData })
      }
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('[orchestrator] POST error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
