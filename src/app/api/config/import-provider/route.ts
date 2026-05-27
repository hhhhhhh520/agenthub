import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { prisma } from '@/lib/db'
import { detectCLIPlatform } from '@/lib/cli-detect'

export async function POST(request: Request) {
  try {
    const { providerName } = await request.json() as { providerName: string }
    if (!providerName || typeof providerName !== 'string') {
      return NextResponse.json({ error: 'providerName is required' }, { status: 400 })
    }

    let apiKey = ''
    let baseUrl = ''
    let model = ''

    const configPath = join(homedir(), '.cc-connect', 'config.toml')
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8')
      const blocks = content.split(/\[\[providers\]\]/g).slice(1)
      for (const block of blocks) {
        const name = block.match(/name\s*=\s*"([^"]+)"/)?.[1]
        if (name === providerName) {
          apiKey = block.match(/api_key\s*=\s*"([^"]+)"/)?.[1] || ''
          baseUrl = block.match(/base_url\s*=\s*"([^"]+)"/)?.[1] || ''
          model = block.match(/model\s*=\s*"([^"]+)"/)?.[1] || ''
          break
        }
      }
    }

    if (!apiKey) {
      return NextResponse.json({ error: `未找到 ${providerName} 的 API Key` }, { status: 404 })
    }

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
    const platform = detectCLIPlatform() || 'llm'
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
