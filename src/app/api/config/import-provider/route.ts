import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { detectCLIPlatform } from '@/lib/cli-detect'
import { resolveProvider } from '@/lib/provider-resolve'

export async function POST(request: Request) {
  try {
    const { providerName } = await request.json() as { providerName: string }
    if (!providerName || typeof providerName !== 'string') {
      return NextResponse.json({ error: 'providerName is required' }, { status: 400 })
    }

    const resolved = await resolveProvider(providerName)
    if (!resolved) {
      return NextResponse.json({ error: `未找到 ${providerName} 的 API Key` }, { status: 404 })
    }

    const { apiKey, baseUrl, model } = resolved

    // 更新 AppConfig（向后兼容）
    await prisma.$executeRaw
      `INSERT OR REPLACE INTO AppConfig (key, value, updatedAt) VALUES ('orchestrator_apiKey', ${apiKey}, datetime('now'))`
    if (baseUrl) {
      await prisma.$executeRaw
        `INSERT OR REPLACE INTO AppConfig (key, value, updatedAt) VALUES ('orchestrator_baseUrl', ${baseUrl}, datetime('now'))`
    }
    if (model) {
      await prisma.$executeRaw
        `INSERT OR REPLACE INTO AppConfig (key, value, updatedAt) VALUES ('orchestrator_model', ${model}, datetime('now'))`
    }

    // 更新 Orchestrator Agent 记录
    const platform = detectCLIPlatform() || 'claude-code'
    const orchAgent = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
    if (orchAgent) {
      await prisma.agent.update({
        where: { id: orchAgent.id },
        data: {
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          ...(model ? { model } : {}),
          platform,
        },
      })
    }

    return NextResponse.json({ success: true, model, baseUrl: baseUrl ? `${baseUrl.slice(0, 10)}***` : '' })
  } catch (e) {
    console.error('[import-provider] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
