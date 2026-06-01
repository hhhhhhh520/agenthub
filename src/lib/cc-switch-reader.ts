import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createClient } from '@libsql/client'

interface CCProvider {
  id?: string
  name: string
  displayName: string
  baseUrl: string
  model: string
  apiKey: string
  agentType: string
  source: string
}

export async function readCCSwitchProviders(): Promise<CCProvider[]> {
  const dbPath = join(homedir(), '.cc-switch', 'cc-switch.db')
  if (!existsSync(dbPath)) return []

  const client = createClient({ url: `file:${dbPath}` })
  try {
    const result = await client.execute(
      'SELECT id, app_type, name, settings_config, is_current FROM providers ORDER BY is_current DESC, name'
    )

    const providers: CCProvider[] = []
    for (const row of result.rows) {
      const appType = row.app_type as string
      const name = row.name as string
      const isCurrent = row.is_current as number

      let config: Record<string, unknown>
      try {
        config = JSON.parse(row.settings_config as string)
      } catch { continue }

      let baseUrl = ''
      let model = ''
      let apiKey = ''

      if (appType === 'claude') {
        const env = (config.env || {}) as Record<string, string>
        baseUrl = env.ANTHROPIC_BASE_URL || ''
        model = env.ANTHROPIC_MODEL || ''
        apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || ''
      } else {
        // Skip non-claude types (codex opencode etc need complex TOML parsing)
        continue
      }

      if (!apiKey) continue

      providers.push({
        id: row.id as string,
        name,
        displayName: `${name}${isCurrent ? ' (当前)' : ''}`,
        baseUrl,
        model,
        apiKey,
        agentType: 'claudecode',
        source: 'cc-switch-db',
      })
    }

    return providers
  } finally {
    client.close()
  }
}
