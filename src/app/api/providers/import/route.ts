import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { prisma } from '@/lib/db'
import { maskApiKey } from '@/lib/utils'

interface ProviderConfig {
  name: string
  baseUrl: string
  model: string
  apiKey: string
  agentTypes: string[]
}

function readProviderConfigs(): ProviderConfig[] {
  const configPath = join(homedir(), '.cc-connect', 'config.toml')
  if (!existsSync(configPath)) return []

  const content = readFileSync(configPath, 'utf-8')
  const blocks = content.split(/\[\[providers\]\]/g).slice(1)

  return blocks.map(block => {
    const name = block.match(/name\s*=\s*"([^"]+)"/)?.[1] || ''
    const apiKey = block.match(/api_key\s*=\s*"([^"]+)"/)?.[1] || ''
    const baseUrl = block.match(/base_url\s*=\s*"([^"]+)"/)?.[1] || ''
    const model = block.match(/model\s*=\s*"([^"]+)"/)?.[1] || ''
    const agentTypes = block.match(/agent_types\s*=\s*\[([^\]]+)\]/)?.[1]?.replace(/"/g, '').split(',').map(s => s.trim()) || []
    return { name, baseUrl, model, apiKey, agentTypes }
  }).filter(p => p.name && p.apiKey)
}

export async function POST(request: Request) {
  const { provider, agentId } = await request.json()

  if (!provider) {
    return NextResponse.json({ error: 'Missing provider name' }, { status: 400 })
  }

  // Resolve real apiKey from server-side config (never trust browser-sent apiKey)
  const configs = readProviderConfigs()
  const config = configs.find(c => c.name === provider)

  if (!config) {
    return NextResponse.json({ error: `Provider "${provider}" not found in config` }, { status: 404 })
  }

  // If agentId provided, update that agent's provider config with real apiKey
  if (agentId) {
    try {
      const agent = await prisma.agent.update({
        where: { id: agentId },
        data: { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey },
        select: { id: true, name: true },
      })
      return NextResponse.json({ success: true, agent })
    } catch {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
  }

  // No agentId — create a new agent with this provider config
  try {
    const agent = await prisma.agent.create({
      data: {
        name: config.name,
        expertise: config.agentTypes[0] || 'general',
        systemPrompt: `You are ${config.name}, a helpful AI assistant.`,
        platform: config.agentTypes[0] || 'llm',
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      },
      select: { id: true, name: true, expertise: true, platform: true },
    })
    return NextResponse.json({ success: true, agent }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 })
  }
}
