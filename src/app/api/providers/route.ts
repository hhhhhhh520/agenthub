import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { maskApiKey } from '@/lib/utils'
import { prisma } from '@/lib/db'
import { readCCSwitchProviders } from '@/lib/cc-switch-reader'

interface Provider {
  id?: string
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
        source: 'cc-switch',
      })
    }
  }

  return providers
}

export async function GET() {
  const providers: Provider[] = []

  // 1. Database providers (full apiKey, source: 'database')
  try {
    const dbProviders = await prisma.provider.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, baseUrl: true, apiKey: true, model: true, category: true },
    })
    for (const p of dbProviders) {
      providers.push({
        id: p.id,
        name: p.name,
        displayName: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        apiKey: p.apiKey,
        agentType: 'claudecode',
        source: 'database',
      })
    }
  } catch { /* ignore */ }

  // 2. CC-Switch SQLite database (before TOML so DB wins dedup)
  try {
    const ccProviders = await readCCSwitchProviders()
    providers.push(...ccProviders)
  } catch { /* ignore */ }

  // 3. Read from ~/.cc-connect/config.toml (CC-Switch imported providers)
  try {
    const configPath = join(homedir(), '.cc-connect', 'config.toml')
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8')
      providers.push(...parseConfigToml(content))
    }
  } catch { /* ignore */ }

  // 4. Read from ~/.claude/settings.json (current Claude Code config)
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

  // #34: 任何 HTTP 出站的 apiKey 都掩码(包括 database / cc-switch-db DB 源)
  // 之前 unmaskSources 包含 database 和 cc-switch-db,导致 #34 在聚合接口仍泄露
  // 前端需要真 key 应走服务端 resolveProvider 路径,不再依赖此接口的明文返回
  const seen = new Set<string>()
  const unique = providers.filter(p => {
    const key = p.baseUrl ? `url:${p.baseUrl}` : `name:${p.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(p => ({
    ...p,
    apiKey: maskApiKey(p.apiKey),
  }))

  return NextResponse.json(unique)
}
