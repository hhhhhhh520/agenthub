import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for src/lib/provider-resolve.ts
 * Verifies multi-source provider resolution: database → cc-switch-db → TOML → settings.json
 */

// Mock prisma
vi.mock('@/lib/db', () => ({
  prisma: {
    provider: {
      findFirst: vi.fn(),
    },
  },
}))

// Mock cc-switch-reader
vi.mock('@/lib/cc-switch-reader', () => ({
  readCCSwitchProviders: vi.fn(() => []),
}))

// Mock fs for TOML and settings.json reading
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  }
})

describe('resolveProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should resolve from database when provider exists with apiKey', async () => {
    const { prisma } = await import('@/lib/db')
    ;(prisma.provider.findFirst as any).mockResolvedValue({
      apiKey: 'sk-db-key',
      baseUrl: 'https://api.db.com',
      model: 'db-model',
    })

    const { resolveProvider } = await import('@/lib/provider-resolve')
    const result = await resolveProvider('my-db-provider')

    expect(result).toEqual({
      apiKey: 'sk-db-key',
      baseUrl: 'https://api.db.com',
      model: 'db-model',
    })
    expect(prisma.provider.findFirst).toHaveBeenCalledWith({
      where: { name: 'my-db-provider' },
      select: { apiKey: true, baseUrl: true, model: true },
    })
  })

  it('should resolve from cc-switch-db when database has no match', async () => {
    const { prisma } = await import('@/lib/db')
    ;(prisma.provider.findFirst as any).mockResolvedValue(null)

    const { readCCSwitchProviders } = await import('@/lib/cc-switch-reader')
    ;(readCCSwitchProviders as any).mockResolvedValue([
      { name: 'cc-provider', apiKey: 'sk-cc-key', baseUrl: 'https://api.cc.com', model: 'cc-model', displayName: '', agentType: '', source: '' },
    ])

    const { resolveProvider } = await import('@/lib/provider-resolve')
    const result = await resolveProvider('cc-provider')

    expect(result).toEqual({
      apiKey: 'sk-cc-key',
      baseUrl: 'https://api.cc.com',
      model: 'cc-model',
    })
  })

  it('should resolve from config.toml when database and cc-switch have no match', async () => {
    const { prisma } = await import('@/lib/db')
    ;(prisma.provider.findFirst as any).mockResolvedValue(null)

    const { readCCSwitchProviders } = await import('@/lib/cc-switch-reader')
    ;(readCCSwitchProviders as any).mockResolvedValue([])

    const fs = await import('fs')
    ;(fs.existsSync as any).mockImplementation((p: string) => p.includes('config.toml'))
    ;(fs.readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('config.toml')) {
        return `[[providers]]
name = "toml-provider"
api_key = "sk-toml-key"
base_url = "https://api.toml.com"
model = "toml-model"
`
      }
      return ''
    })

    const { resolveProvider } = await import('@/lib/provider-resolve')
    const result = await resolveProvider('toml-provider')

    expect(result).toEqual({
      apiKey: 'sk-toml-key',
      baseUrl: 'https://api.toml.com',
      model: 'toml-model',
    })
  })

  it('should resolve claude-current from settings.json', async () => {
    const { prisma } = await import('@/lib/db')
    ;(prisma.provider.findFirst as any).mockResolvedValue(null)

    const { readCCSwitchProviders } = await import('@/lib/cc-switch-reader')
    ;(readCCSwitchProviders as any).mockResolvedValue([])

    const fs = await import('fs')
    ;(fs.existsSync as any).mockImplementation((p: string) => p.includes('settings.json'))
    ;(fs.readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('settings.json')) {
        return JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://api.settings.com',
            ANTHROPIC_AUTH_TOKEN: 'sk-settings-key',
            ANTHROPIC_MODEL: 'settings-model',
          },
        })
      }
      return ''
    })

    const { resolveProvider } = await import('@/lib/provider-resolve')
    const result = await resolveProvider('claude-current')

    expect(result).toEqual({
      apiKey: 'sk-settings-key',
      baseUrl: 'https://api.settings.com',
      model: 'settings-model',
    })
  })

  it('should return null when provider not found in any source', async () => {
    const { prisma } = await import('@/lib/db')
    ;(prisma.provider.findFirst as any).mockResolvedValue(null)

    const { resolveProvider } = await import('@/lib/provider-resolve')
    const result = await resolveProvider('nonexistent')

    expect(result).toBeNull()
  })

  it('should skip database provider with empty apiKey and fall through', async () => {
    const { prisma } = await import('@/lib/db')
    ;(prisma.provider.findFirst as any).mockResolvedValue({
      apiKey: '',
      baseUrl: 'https://api.db.com',
      model: 'db-model',
    })

    const { readCCSwitchProviders } = await import('@/lib/cc-switch-reader')
    ;(readCCSwitchProviders as any).mockResolvedValue([
      { name: 'my-provider', apiKey: 'sk-cc-key', baseUrl: 'https://api.cc.com', model: 'cc-model', displayName: '', agentType: '', source: '' },
    ])

    const { resolveProvider } = await import('@/lib/provider-resolve')
    const result = await resolveProvider('my-provider')

    // Should skip empty apiKey from database and find cc-switch match
    expect(result?.apiKey).toBe('sk-cc-key')
  })

  it('should prefer database over cc-switch-db when both have the same provider', async () => {
    const { prisma } = await import('@/lib/db')
    ;(prisma.provider.findFirst as any).mockResolvedValue({
      apiKey: 'sk-db-wins',
      baseUrl: 'https://api.db.com',
      model: 'db-model',
    })

    const { readCCSwitchProviders } = await import('@/lib/cc-switch-reader')
    ;(readCCSwitchProviders as any).mockResolvedValue([
      { name: 'same-provider', apiKey: 'sk-cc-loses', baseUrl: 'https://api.cc.com', model: 'cc-model', displayName: '', agentType: '', source: '' },
    ])

    const { resolveProvider } = await import('@/lib/provider-resolve')
    const result = await resolveProvider('same-provider')

    expect(result?.apiKey).toBe('sk-db-wins')
  })
})
