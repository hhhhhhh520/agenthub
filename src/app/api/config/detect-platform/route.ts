import { NextResponse } from 'next/server'
import { detectCLIPlatform } from '@/lib/cli-detect'

export async function POST() {
  try {
    const platform = detectCLIPlatform()
    return NextResponse.json({
      platform: platform || 'claude-code',
      cliAvailable: platform !== null,
    })
  } catch (e) {
    return NextResponse.json({
      platform: 'claude-code',
      cliAvailable: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
