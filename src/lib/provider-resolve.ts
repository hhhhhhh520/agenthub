import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { prisma } from '@/lib/db'
import { readCCSwitchProviders } from '@/lib/cc-switch-reader'

interface ResolvedProvider {
  apiKey: string
  baseUrl: string
  model: string
}

interface TomlProvider extends ResolvedProvider {
  name: string
}

/**
 * Parse providers from CC-Switch TOML config file.
 * Reuses the same parsing logic as GET /api/providers.
 */
function parseConfigTomlProviders(): TomlProvider[] {
  const configPath = join(homedir(), '.cc-connect', 'config.toml')
  if (!existsSync(configPath)) return []

  const content = readFileSync(configPath, 'utf-8')
  const blocks = content.split(/\[\[providers\]\]/g).slice(1)

  return blocks.map(block => {
    const apiKey = block.match(/api_key\s*=\s*"([^"]+)"/)?.[1] || ''
    const baseUrl = block.match(/base_url\s*=\s*"([^"]+)"/)?.[1] || ''
    const model = block.match(/model\s*=\s*"([^"]+)"/)?.[1] || ''
    const name = block.match(/name\s*=\s*"([^"]+)"/)?.[1] || ''
    return { name, apiKey, baseUrl, model }
  }).filter(p => p.name && p.apiKey)
}

/**
 * Read provider from ~/.claude/settings.json.
 */
function readSettingsJsonProvider(): ResolvedProvider | null {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return null

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const env = settings.env || {}
    if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_AUTH_TOKEN) {
      return {
        apiKey: env.ANTHROPIC_AUTH_TOKEN,
        baseUrl: env.ANTHROPIC_BASE_URL,
        model: env.ANTHROPIC_MODEL || '',
      }
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Resolve a provider by name from all available sources.
 * Search order: database → cc-switch-db → cc-connect TOML → settings.json
 * Returns the first match that has a non-empty apiKey, or null.
 */
export async function resolveProvider(name: string): Promise<ResolvedProvider | null> {
  // 1. Database — Provider table
  try {
    const dbProvider = await prisma.provider.findFirst({
      where: { name },
      select: { apiKey: true, baseUrl: true, model: true },
    })
    if (dbProvider?.apiKey) {
      return { apiKey: dbProvider.apiKey, baseUrl: dbProvider.baseUrl, model: dbProvider.model }
    }
  } catch { /* ignore */ }

  // 2. CC-Switch SQLite database
  try {
    const ccProviders = await readCCSwitchProviders()
    const match = ccProviders.find(p => p.name === name)
    if (match?.apiKey) {
      return { apiKey: match.apiKey, baseUrl: match.baseUrl, model: match.model }
    }
  } catch { /* ignore */ }

  // 3. CC-Connect TOML config
  try {
    const tomlProviders = parseConfigTomlProviders()
    const match = tomlProviders.find(p => p.name === name)
    if (match?.apiKey) {
      return { apiKey: match.apiKey, baseUrl: match.baseUrl, model: match.model }
    }
  } catch { /* ignore */ }

  // 4. ~/.claude/settings.json
  if (name === 'claude-current') {
    const settings = readSettingsJsonProvider()
    if (settings?.apiKey) return settings
  }

  return null
}
