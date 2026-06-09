import { NextResponse } from 'next/server'
import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { detectCLIPlatform } from '@/lib/cli-detect'

function detectDefaultModel(): string {
  // 1. 从 ~/.claude/settings.json 读取 ANTHROPIC_MODEL
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      if (settings.env?.ANTHROPIC_MODEL) return settings.env.ANTHROPIC_MODEL.replace(/\[.*?\]/g, '')
    }
  } catch {}

  // 2. 从 claude config get model 获取
  try {
    const model = execSync('claude config get model', { timeout: 3000, stdio: 'pipe' }).toString().trim()
    if (model && !model.includes('not set')) return model.replace(/\[.*?\]/g, '')
  } catch {}

  return ''
}

export async function POST() {
  try {
    const platform = detectCLIPlatform()
    const defaultModel = platform === 'claude-code' ? detectDefaultModel() : ''
    return NextResponse.json({
      platform: platform || 'claude-code',
      cliAvailable: platform !== null,
      defaultModel,
    })
  } catch (e) {
    return NextResponse.json({
      platform: 'claude-code',
      cliAvailable: false,
      defaultModel: '',
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
