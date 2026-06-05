import { NextResponse } from 'next/server'
import { detectCLIPlatform } from '@/lib/cli-detect'

export async function POST() {
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
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
