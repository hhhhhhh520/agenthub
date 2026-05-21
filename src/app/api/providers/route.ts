import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

interface Provider {
  name: string
  displayName: string
  baseUrl: string
  model: string
  models: string[]
  agentType: string
  source: string
}

export async function GET() {
  const providers: Provider[] = []

  // 1. Read from ~/.claude/settings.json (current Claude Code config)
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const env = settings.env || {}
      if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_AUTH_TOKEN) {
        providers.push({
          name: 'claude-settings',
          displayName: `Claude Code 当前配置 (${env.ANTHROPIC_MODEL || 'default'})`,
          baseUrl: env.ANTHROPIC_BASE_URL,
          model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
          models: [
            env.ANTHROPIC_MODEL,
            env.ANTHROPIC_DEFAULT_SONNET_MODEL,
            env.ANTHROPIC_DEFAULT_OPUS_MODEL,
            env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
          ].filter(Boolean) as string[],
          agentType: 'claudecode',
          source: 'settings.json',
        })
      }
    }
  } catch { /* ignore */ }

  // 2. Read from cc-connect config.toml (if exists)
  try {
    const configPaths = [
      join(homedir(), '.cc-connect', 'config.toml'),
      join(process.cwd(), '..', 'cc-connect', 'config.toml'),
    ]
    for (const configPath of configPaths) {
      if (!existsSync(configPath)) continue
      const content = readFileSync(configPath, 'utf-8')
      // Parse TOML-like [[providers]] sections
      const providerBlocks = content.match(/\[\[providers\]\]([\s\S]*?)(?=\[\[providers\]\]|\[projects\]|$)/g) || []
      for (const block of providerBlocks) {
        const name = block.match(/name\s*=\s*"([^"]+)"/)?.[1]
        const apiKey = block.match(/api_key\s*=\s*"([^"]+)"/)?.[1]
        const baseUrl = block.match(/base_url\s*=\s*"([^"]+)"/)?.[1]
        const model = block.match(/model\s*=\s*"([^"]+)"/)?.[1]
        const agentTypes = block.match(/agent_types\s*=\s*\[([^\]]+)\]/)?.[1]?.replace(/"/g, '').split(',').map(s => s.trim())
        if (name && apiKey) {
          providers.push({
            name,
            displayName: `${name} (${model || 'default'})`,
            baseUrl: baseUrl || '',
            model: model || '',
            models: model ? [model] : [],
            agentType: agentTypes?.[0] || 'claudecode',
            source: 'config.toml',
          })
        }
      }
    }
  } catch { /* ignore */ }

  // 3. Fallback: read provider-presets.json
  if (providers.length === 0) {
    try {
      const presetsPath = join(process.cwd(), '..', 'cc-connect', 'provider-presets.json')
      if (existsSync(presetsPath)) {
        const data = JSON.parse(readFileSync(presetsPath, 'utf-8'))
        for (const p of data.providers || []) {
          for (const [agentType, config] of Object.entries(p.agents as Record<string, { base_url: string; model: string; models: string[] }>)) {
            providers.push({
              name: `${p.name}-${agentType}`,
              displayName: `${p.display_name} (${agentType})`,
              baseUrl: config.base_url,
              model: config.model,
              models: config.models,
              agentType,
              source: 'presets',
            })
          }
        }
      }
    } catch { /* ignore */ }
  }

  return NextResponse.json(providers)
}
