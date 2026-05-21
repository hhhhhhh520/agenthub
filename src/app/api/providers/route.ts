import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

interface Provider {
  name: string
  displayName: string
  baseUrl: string
  model: string
  apiKey: string
  agentType: string
  source: string
}

function parseConfigToml(content: string): Provider[] {
  const providers: Provider[] = []
  const blocks = content.split(/\[\[providers\]\]/g).slice(1)

  for (const block of blocks) {
    const name = block.match(/name\s*=\s*"([^"]+)"/)?.[1] || ''
    const apiKey = block.match(/api_key\s*=\s*"([^"]+)"/)?.[1] || ''
    const baseUrl = block.match(/base_url\s*=\s*"([^"]+)"/)?.[1] || ''
    const model = block.match(/model\s*=\s*"([^"]+)"/)?.[1] || ''
    const agentTypes = block.match(/agent_types\s*=\s*\[([^\]]+)\]/)?.[1]?.replace(/"/g, '').split(',').map(s => s.trim())

    if (name && apiKey) {
      providers.push({
        name,
        displayName: `${name} (${model || 'default'})`,
        baseUrl,
        model,
        apiKey,
        agentType: agentTypes?.[0] || 'claudecode',
        source: 'cc-connect',
      })
    }
  }

  return providers
}

export async function GET() {
  const providers: Provider[] = []

  // 1. Read from ~/.cc-connect/config.toml (CC-Switch imported providers)
  try {
    const configPath = join(homedir(), '.cc-connect', 'config.toml')
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8')
      providers.push(...parseConfigToml(content))
    }
  } catch { /* ignore */ }

  // 2. Read from ~/.claude/settings.json (current Claude Code config)
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const env = settings.env || {}
      if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_AUTH_TOKEN) {
        providers.unshift({
          name: 'claude-current',
          displayName: `当前 Claude 配置 (${env.ANTHROPIC_MODEL || 'default'})`,
          baseUrl: env.ANTHROPIC_BASE_URL,
          model: env.ANTHROPIC_MODEL || '',
          apiKey: env.ANTHROPIC_AUTH_TOKEN,
          agentType: 'claudecode',
          source: 'settings.json',
        })
      }
    }
  } catch { /* ignore */ }

  // Deduplicate by name
  const seen = new Set<string>()
  const unique = providers.filter(p => {
    if (seen.has(p.name)) return false
    seen.add(p.name)
    return true
  })

  return NextResponse.json(unique)
}
