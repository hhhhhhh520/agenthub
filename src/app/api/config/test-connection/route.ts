import { NextResponse } from 'next/server'
import { detectCLIPlatform } from '@/lib/cli-detect'
import { testLLMConnection } from '@/lib/llm-connection'

type DraftBody = {
  apiKey?: unknown
  model?: unknown
  baseUrl?: unknown
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/sk-[A-Za-z0-9_-]{6,}/gi, 'sk-***').slice(0, 300)
}

export async function POST(request: Request) {
  let raw: DraftBody | null = null
  try {
    raw = await request.json() as DraftBody
  } catch {
    // 无 JSON body：保持旧的 CLI 检测语义。
  }

  const apiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : ''
  const model = typeof raw?.model === 'string' ? raw.model.trim() : ''
  const baseUrl = typeof raw?.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  const hasDraft = Boolean(apiKey || model || baseUrl)

  if (hasDraft) {
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: '测试手动配置需要 API Key' },
        { status: 400 },
      )
    }
    try {
      const response = await testLLMConnection({ apiKey, model, baseUrl })
      return NextResponse.json({
        success: true,
        platform: 'api',
        response,
        message: '模型连接成功',
      })
    } catch (error) {
      return NextResponse.json({ success: false, error: sanitizeError(error) })
    }
  }

  try {
    const cliPlatform = detectCLIPlatform()
    if (cliPlatform) {
      return NextResponse.json({
        success: true,
        platform: cliPlatform,
        message: `检测到 ${cliPlatform === 'claude-code' ? 'Claude CLI' : 'OpenCode CLI'}`,
      })
    }

    return NextResponse.json({ success: false, error: '未检测到 CLI，请安装 Claude CLI 或 OpenCode CLI' })
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: sanitizeError(e),
    })
  }
}
