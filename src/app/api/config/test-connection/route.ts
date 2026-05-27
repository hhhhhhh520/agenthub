import { NextResponse } from 'next/server'
import { detectCLIPlatform } from '@/lib/cli-detect'

export async function POST() {
  try {
    // 优先检测 CLI 可用性
    const cliPlatform = detectCLIPlatform()
    if (cliPlatform) {
      return NextResponse.json({
        success: true,
        platform: cliPlatform,
        message: `检测到 ${cliPlatform === 'claude-code' ? 'Claude CLI' : 'OpenCode CLI'}`,
      })
    }

    // CLI 不可用，fallback 到 LLM 测试
    const { prisma } = await import('@/lib/db')
    const rows = await prisma.$queryRaw<Array<{ key: string; value: string }>>
      `SELECT key, value FROM AppConfig WHERE key IN ('orchestrator_apiKey', 'orchestrator_model', 'orchestrator_baseUrl')`
    const config: Record<string, string> = {}
    for (const row of rows) {
      config[row.key] = row.value
    }

    const apiKey = config.orchestrator_apiKey
    if (!apiKey) {
      return NextResponse.json({ success: false, error: '未检测到 CLI，也未配置 API Key。请安装 Claude CLI 或在设置中配置 API Key。' })
    }

    const { createAdapter } = await import('@/lib/adapter')
    const adapter = createAdapter({ platform: 'llm' })
    await adapter.connect({
      platform: 'llm',
      apiKey,
      model: config.orchestrator_model || 'claude-sonnet-4-20250514',
      baseUrl: config.orchestrator_baseUrl || undefined,
    })

    let result = ''
    for await (const chunk of adapter.send({ prompt: '回复"连接成功"四个字，不要说其他话。' })) {
      if (chunk.type === 'text' || chunk.type === 'error') result += chunk.content
    }
    await adapter.close()

    if (!result.trim()) {
      return NextResponse.json({ success: false, error: 'API 返回空响应' })
    }

    return NextResponse.json({ success: true, response: result.trim(), platform: 'llm' })
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
