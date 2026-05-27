import { describe, it, expect, vi } from 'vitest'
import { buildMCPConfig } from '../src/lib/mcp-config'

describe('buildMCPConfig', () => {
  it('should return valid JSON with correct structure', () => {
    const config = JSON.parse(buildMCPConfig('sess-123', '前端工程师', '/tmp/work'))
    expect(config).toHaveProperty('mcpServers')
    expect(config.mcpServers).toHaveProperty('agenthub')
    expect(config.mcpServers.agenthub.command).toBeDefined()
    expect(config.mcpServers.agenthub.args).toBeInstanceOf(Array)
  })

  it('should pass session env variables', () => {
    const config = JSON.parse(buildMCPConfig('sess-abc', '后端工程师', '/projects/my-app'))
    const env = config.mcpServers.agenthub.env
    expect(env.AGENTHUB_SESSION_ID).toBe('sess-abc')
    expect(env.AGENTHUB_AGENT_NAME).toBe('后端工程师')
    expect(env.AGENTHUB_WORK_DIR).toBe('/projects/my-app')
  })

  it('should use tsx in non-production', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const config = JSON.parse(buildMCPConfig('s', 'a', '.'))
    expect(config.mcpServers.agenthub.command).toBe('npx')
    expect(config.mcpServers.agenthub.args[0]).toBe('tsx')
    vi.unstubAllEnvs()
  })

  it('should use node in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const config = JSON.parse(buildMCPConfig('s', 'a', '.'))
    expect(config.mcpServers.agenthub.command).toBe('node')
    vi.unstubAllEnvs()
  })
})
