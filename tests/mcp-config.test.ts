import { describe, it, expect, vi, afterEach } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import { buildMCPConfig } from '../src/lib/mcp-config'

afterEach(() => vi.unstubAllEnvs())

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

  it('P3 #28: 未配置 DATABASE_URL 时回退到主进程 cwd 的绝对 dev.db', () => {
    vi.stubEnv('DATABASE_URL', '')
    const config = JSON.parse(buildMCPConfig('s', 'a', '/some/work'))
    const dbUrl = config.mcpServers.agenthub.env.DATABASE_URL as string
    expect(dbUrl).toBe(`file:${resolve(process.cwd(), 'dev.db')}`)
  })

  it('P3 #28: 相对 file DATABASE_URL 以主进程 cwd 解析为绝对路径', () => {
    vi.stubEnv('DATABASE_URL', 'file:./data/agenthub.db')
    const config = JSON.parse(buildMCPConfig('s', 'a', '/some/work'))
    const dbUrl = config.mcpServers.agenthub.env.DATABASE_URL as string
    expect(dbUrl).toBe(`file:${resolve(process.cwd(), 'data/agenthub.db')}`)
    const filePath = dbUrl.slice('file:'.length)
    expect(isAbsolute(filePath)).toBe(true)
  })

  it('P3 #28: 绝对 file URL 与非 file URL 原样传递', () => {
    const absolute = `file:${resolve(process.cwd(), 'absolute.db')}`
    vi.stubEnv('DATABASE_URL', absolute)
    let config = JSON.parse(buildMCPConfig('s', 'a', '.'))
    expect(config.mcpServers.agenthub.env.DATABASE_URL).toBe(absolute)

    vi.stubEnv('DATABASE_URL', 'libsql://example.turso.io')
    config = JSON.parse(buildMCPConfig('s', 'a', '.'))
    expect(config.mcpServers.agenthub.env.DATABASE_URL).toBe('libsql://example.turso.io')
  })
})
