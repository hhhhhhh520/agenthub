import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * CC-Switch provider import tests.
 * Tests TOML parsing, provider import to agent, import to orchestrator,
 * deduplication, and apiKey masking.
 */

// ─── TOML parsing logic ───────────────────────────────────────────────────────
// The same regex-based parsing is used in:
//   - src/app/api/providers/route.ts (parseConfigToml)
//   - src/app/api/providers/import/route.ts (readProviderConfigs)
//   - src/app/api/config/import-provider/route.ts (inline parsing)
// We test the regex patterns that extract name, api_key, base_url, model, agent_types.

function parseConfigToml(content: string): Array<{
  name: string; apiKey: string; baseUrl: string; model: string; agentTypes: string[]
}> {
  const providers: Array<{ name: string; apiKey: string; baseUrl: string; model: string; agentTypes: string[] }> = []
  const blocks = content.split(/\[\[providers\]\]/g).slice(1)

  for (const block of blocks) {
    const name = block.match(/name\s*=\s*"([^"]+)"/)?.[1] || ''
    const apiKey = block.match(/api_key\s*=\s*"([^"]+)"/)?.[1] || ''
    const baseUrl = block.match(/base_url\s*=\s*"([^"]+)"/)?.[1] || ''
    const model = block.match(/model\s*=\s*"([^"]+)"/)?.[1] || ''
    const agentTypes = block.match(/agent_types\s*=\s*\[([^\]]+)\]/)?.[1]?.replace(/"/g, '').split(',').map(s => s.trim()) || []

    if (name && apiKey) {
      providers.push({ name, apiKey, baseUrl, model, agentTypes })
    }
  }

  return providers
}

describe('TOML parsing — provider extraction', () => {
  it('should parse a single provider block', () => {
    const toml = `
[[providers]]
name = "deepseek"
api_key = "sk-deepseek-123"
base_url = "https://api.deepseek.com"
model = "deepseek-chat"
agent_types = ["llm"]
`
    const providers = parseConfigToml(toml)
    expect(providers).toHaveLength(1)
    expect(providers[0].name).toBe('deepseek')
    expect(providers[0].apiKey).toBe('sk-deepseek-123')
    expect(providers[0].baseUrl).toBe('https://api.deepseek.com')
    expect(providers[0].model).toBe('deepseek-chat')
    expect(providers[0].agentTypes).toEqual(['llm'])
  })

  it('should parse multiple provider blocks', () => {
    const toml = `
[[providers]]
name = "deepseek"
api_key = "sk-ds-key"
base_url = "https://api.deepseek.com"
model = "deepseek-chat"
agent_types = ["llm"]

[[providers]]
name = "moonshot"
api_key = "sk-moon-key"
base_url = "https://api.moonshot.cn"
model = "moonshot-v1-8k"
agent_types = ["llm"]

[[providers]]
name = "claude-proxy"
api_key = "sk-proxy-key"
base_url = "https://proxy.example.com"
model = "claude-sonnet-4-20250514"
agent_types = ["claudecode"]
`
    const providers = parseConfigToml(toml)
    expect(providers).toHaveLength(3)
    expect(providers[0].name).toBe('deepseek')
    expect(providers[1].name).toBe('moonshot')
    expect(providers[2].name).toBe('claude-proxy')
  })

  it('should skip blocks with missing name', () => {
    const toml = `
[[providers]]
api_key = "sk-orphan"
base_url = "https://api.example.com"
model = "test"
`
    const providers = parseConfigToml(toml)
    expect(providers).toHaveLength(0)
  })

  it('should skip blocks with missing api_key', () => {
    const toml = `
[[providers]]
name = "no-key-provider"
base_url = "https://api.example.com"
model = "test"
`
    const providers = parseConfigToml(toml)
    expect(providers).toHaveLength(0)
  })

  it('should handle empty agent_types array', () => {
    const toml = `
[[providers]]
name = "minimal"
api_key = "sk-minimal"
base_url = "https://api.example.com"
model = "test"
agent_types = []
`
    const providers = parseConfigToml(toml)
    expect(providers).toHaveLength(1)
    expect(providers[0].agentTypes).toEqual([])
  })

  it('should handle multiple agent_types', () => {
    const toml = `
[[providers]]
name = "multi-type"
api_key = "sk-multi"
base_url = "https://api.example.com"
model = "test"
agent_types = ["llm", "claudecode"]
`
    const providers = parseConfigToml(toml)
    expect(providers).toHaveLength(1)
    expect(providers[0].agentTypes).toEqual(['llm', 'claudecode'])
  })

  it('should handle fields in any order', () => {
    const toml = `
[[providers]]
model = "reordered-model"
agent_types = ["llm"]
api_key = "sk-reordered"
name = "reordered"
base_url = "https://reordered.example.com"
`
    const providers = parseConfigToml(toml)
    expect(providers).toHaveLength(1)
    expect(providers[0].name).toBe('reordered')
    expect(providers[0].apiKey).toBe('sk-reordered')
  })

  it('should handle fields without quotes gracefully', () => {
    const toml = `
[[providers]]
name = "valid"
api_key = "sk-valid"
model = test-no-quotes
`
    const providers = parseConfigToml(toml)
    // model without quotes won't be captured by the regex (expects [^"]+)
    // but name and api_key are present, so it should still be parsed
    expect(providers).toHaveLength(1)
    expect(providers[0].model).toBe('')
  })

  it('should handle empty content', () => {
    expect(parseConfigToml('')).toHaveLength(0)
  })

  it('should handle content with no provider blocks', () => {
    expect(parseConfigToml('name = "not-a-provider"')).toHaveLength(0)
  })
})

// ─── Provider deduplication ───────────────────────────────────────────────────

describe('Provider deduplication', () => {
  it('should deduplicate by baseUrl', () => {
    const providers = [
      { name: 'a', baseUrl: 'https://api.example.com', model: 'm1', apiKey: 'k1' },
      { name: 'b', baseUrl: 'https://api.example.com', model: 'm2', apiKey: 'k2' },
      { name: 'c', baseUrl: 'https://other.com', model: 'm3', apiKey: 'k3' },
    ]

    const seen = new Set<string>()
    const unique = providers.filter(p => {
      const key = p.baseUrl ? `url:${p.baseUrl}` : `name:${p.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    expect(unique).toHaveLength(2)
    expect(unique[0].name).toBe('a') // First one wins
    expect(unique[1].name).toBe('c')
  })

  it('should deduplicate by name when baseUrl is empty', () => {
    const providers = [
      { name: 'same-name', baseUrl: '', model: 'm1', apiKey: 'k1' },
      { name: 'same-name', baseUrl: '', model: 'm2', apiKey: 'k2' },
    ]

    const seen = new Set<string>()
    const unique = providers.filter(p => {
      const key = p.baseUrl ? `url:${p.baseUrl}` : `name:${p.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    expect(unique).toHaveLength(1)
  })
})

// ─── API Key masking ──────────────────────────────────────────────────────────

describe('Provider apiKey masking', () => {
  it('should mask apiKey for cc-switch source', async () => {
    const { maskApiKey } = await import('../src/lib/utils')
    const provider = {
      name: 'cc-provider',
      apiKey: 'sk-1234567890abcdef',
      source: 'cc-switch',
    }

    const unmaskSources = new Set(['database', 'cc-switch-db'])
    const masked = unmaskSources.has(provider.source) ? provider.apiKey : maskApiKey(provider.apiKey)

    expect(masked).toBe('***cdef')
    expect(masked).not.toBe(provider.apiKey)
  })

  it('should NOT mask apiKey for database source', async () => {
    const { maskApiKey } = await import('../src/lib/utils')
    const provider = {
      name: 'db-provider',
      apiKey: 'sk-1234567890abcdef',
      source: 'database',
    }

    const unmaskSources = new Set(['database', 'cc-switch-db'])
    const result = unmaskSources.has(provider.source) ? provider.apiKey : maskApiKey(provider.apiKey)

    expect(result).toBe('sk-1234567890abcdef')
  })

  it('should NOT mask apiKey for cc-switch-db source', async () => {
    const { maskApiKey } = await import('../src/lib/utils')
    const provider = {
      name: 'db-switch-provider',
      apiKey: 'sk-1234567890abcdef',
      source: 'cc-switch-db',
    }

    const unmaskSources = new Set(['database', 'cc-switch-db'])
    const result = unmaskSources.has(provider.source) ? provider.apiKey : maskApiKey(provider.apiKey)

    expect(result).toBe('sk-1234567890abcdef')
  })

  it('should mask apiKey for settings.json source', async () => {
    const { maskApiKey } = await import('../src/lib/utils')
    const provider = {
      name: 'settings-provider',
      apiKey: 'sk-settings-key-1234',
      source: 'settings.json',
    }

    const unmaskSources = new Set(['database', 'cc-switch-db'])
    const masked = unmaskSources.has(provider.source) ? provider.apiKey : maskApiKey(provider.apiKey)

    expect(masked).toContain('***')
    expect(masked).not.toBe(provider.apiKey)
  })
})

// ─── Import endpoint — agent creation and update ──────────────────────────────

// Mock prisma for import endpoint tests
vi.mock('@/lib/db', () => ({
  prisma: {
    agent: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}))

// Mock cli-detect
vi.mock('@/lib/cli-detect', () => ({
  detectCLIPlatform: vi.fn(() => 'claude-code'),
}))

// Mock fs for TOML reading
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (path.includes('config.toml')) return true
      return actual.existsSync(path)
    }),
    readFileSync: vi.fn((path: string, encoding?: string) => {
      if (path.includes('config.toml')) {
        return `
[[providers]]
name = "test-provider"
api_key = "sk-test-real-key-123"
base_url = "https://api.test.com"
model = "test-model"
agent_types = ["llm"]
`
      }
      return actual.readFileSync(path, encoding as BufferEncoding)
    }),
  }
})

describe('POST /api/providers/import — import to agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should update existing agent when agentId is provided', async () => {
    const { prisma } = await import('@/lib/db')
    const mockAgent = { id: 'agent-123', name: 'existing-agent' }
    ;(prisma.agent.update as any).mockResolvedValue(mockAgent)

    const { POST } = await import('@/app/api/providers/import/route')
    const req = new Request('http://localhost/api/providers/import', {
      method: 'POST',
      body: JSON.stringify({ provider: 'test-provider', agentId: 'agent-123' }),
    })

    const res = await POST(req)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.agent).toEqual(mockAgent)

    // Verify agent was updated with real apiKey from TOML (not browser-sent masked value)
    const updateCall = (prisma.agent.update as any).mock.calls[0][0]
    expect(updateCall.where.id).toBe('agent-123')
    expect(updateCall.data.apiKey).toBe('sk-test-real-key-123')
    expect(updateCall.data.baseUrl).toBe('https://api.test.com')
    expect(updateCall.data.model).toBe('test-model')
  })

  it('should create new agent when agentId is not provided', async () => {
    const { prisma } = await import('@/lib/db')
    const mockAgent = { id: 'new-agent-456', name: 'test-provider', expertise: 'llm', platform: 'llm' }
    ;(prisma.agent.create as any).mockResolvedValue(mockAgent)

    const { POST } = await import('@/app/api/providers/import/route')
    const req = new Request('http://localhost/api/providers/import', {
      method: 'POST',
      body: JSON.stringify({ provider: 'test-provider' }),
    })

    const res = await POST(req)
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.success).toBe(true)

    // Verify new agent was created with real apiKey
    const createCall = (prisma.agent.create as any).mock.calls[0][0]
    expect(createCall.data.name).toBe('test-provider')
    expect(createCall.data.apiKey).toBe('sk-test-real-key-123')
    expect(createCall.data.baseUrl).toBe('https://api.test.com')
    expect(createCall.data.model).toBe('test-model')
  })

  it('should return 400 when provider name is missing', async () => {
    const { POST } = await import('@/app/api/providers/import/route')
    const req = new Request('http://localhost/api/providers/import', {
      method: 'POST',
      body: JSON.stringify({}),
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing provider name')
  })

  it('should return 404 when provider is not found in config', async () => {
    const { POST } = await import('@/app/api/providers/import/route')
    const req = new Request('http://localhost/api/providers/import', {
      method: 'POST',
      body: JSON.stringify({ provider: 'nonexistent-provider' }),
    })

    const res = await POST(req)
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('not found')
  })

  it('should return 404 when agentId references non-existent agent', async () => {
    const { prisma } = await import('@/lib/db')
    ;(prisma.agent.update as any).mockRejectedValue(new Error('Record not found'))

    const { POST } = await import('@/app/api/providers/import/route')
    const req = new Request('http://localhost/api/providers/import', {
      method: 'POST',
      body: JSON.stringify({ provider: 'test-provider', agentId: 'nonexistent-id' }),
    })

    const res = await POST(req)
    expect(res.status).toBe(404)
  })
})

// ─── Import to orchestrator ───────────────────────────────────────────────────

describe('POST /api/config/import-provider — import to orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should update AppConfig and orchestrator agent', async () => {
    const { prisma } = await import('@/lib/db')
    const orchAgent = { id: 'orch-agent-id', name: 'Orchestrator', isOrchestrator: true }
    ;(prisma.agent.findFirst as any).mockResolvedValue(orchAgent)
    ;(prisma.agent.update as any).mockResolvedValue(orchAgent)
    ;(prisma.$executeRaw as any).mockResolvedValue(undefined)

    const { POST } = await import('@/app/api/config/import-provider/route')
    const req = new Request('http://localhost/api/config/import-provider', {
      method: 'POST',
      body: JSON.stringify({ providerName: 'test-provider' }),
    })

    const res = await POST(req)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.model).toBe('test-model')

    // Verify AppConfig writes (3 raw SQL calls: apiKey, baseUrl, model)
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3)

    // Verify orchestrator agent was updated
    expect(prisma.agent.findFirst).toHaveBeenCalledWith({ where: { isOrchestrator: true } })
    const updateCall = (prisma.agent.update as any).mock.calls[0][0]
    expect(updateCall.where.id).toBe('orch-agent-id')
    expect(updateCall.data.apiKey).toBe('sk-test-real-key-123')
    expect(updateCall.data.baseUrl).toBe('https://api.test.com')
    expect(updateCall.data.model).toBe('test-model')
    expect(updateCall.data.platform).toBe('claude-code') // from detectCLIPlatform mock
  })

  it('should return 400 when providerName is missing', async () => {
    const { POST } = await import('@/app/api/config/import-provider/route')
    const req = new Request('http://localhost/api/config/import-provider', {
      method: 'POST',
      body: JSON.stringify({}),
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('providerName is required')
  })

  it('should return 404 when provider apiKey is not found', async () => {
    // Override readFileSync to return TOML without the requested provider
    const fs = await import('fs')
    vi.spyOn(fs, 'readFileSync').mockImplementation((path: any, encoding?: any) => {
      if (typeof path === 'string' && path.includes('config.toml')) {
        return `[[providers]]\nname = "other-provider"\napi_key = "sk-other"\n`
      }
      const { readFileSync } = vi.importActual<typeof import('fs')>('fs')
      return readFileSync(path, encoding)
    })

    const { POST } = await import('@/app/api/config/import-provider/route')
    const req = new Request('http://localhost/api/config/import-provider', {
      method: 'POST',
      body: JSON.stringify({ providerName: 'nonexistent' }),
    })

    const res = await POST(req)
    expect(res.status).toBe(404)

    vi.restoreAllMocks()
  })
})
