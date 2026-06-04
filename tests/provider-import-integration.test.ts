import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Provider import integration tests.
 * Covers: readCCSwitchProviders filtering, resolveProvider priority chain,
 * TOML path specificity, settings.json name guard.
 */

// Hoisted spies for resolveProvider tests
const { settingsReadSpy, tomlReadSpy, ccSwitchCallSpy, callOrderArr } = vi.hoisted(() => ({
  settingsReadSpy: vi.fn(() => ''),
  tomlReadSpy: vi.fn(() => ''),
  ccSwitchCallSpy: vi.fn(),
  callOrderArr: [] as string[],
}))

// ─── readCCSwitchProviders — appType filtering ────────────────────────────────

describe('readCCSwitchProviders — appType filtering', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('should only include claude-type providers, skip codex/opencode', async () => {
    vi.doMock('@libsql/client', () => ({
      createClient: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '1',
              app_type: 'claude',
              name: 'Claude Provider',
              settings_config: JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-claude', ANTHROPIC_BASE_URL: 'https://api.claude.com', ANTHROPIC_MODEL: 'claude-sonnet-4-20250514' } }),
              is_current: 1,
            },
            {
              id: '2',
              app_type: 'codex',
              name: 'Codex Provider',
              settings_config: JSON.stringify({ env: { OPENAI_API_KEY: 'sk-codex' } }),
              is_current: 0,
            },
            {
              id: '3',
              app_type: 'opencode',
              name: 'OpenCode Provider',
              settings_config: JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-oc' } }),
              is_current: 0,
            },
          ],
        }),
        close: vi.fn(),
      })),
    }))
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return { ...actual, existsSync: vi.fn(() => true) }
    })

    const { readCCSwitchProviders } = await import('../src/lib/cc-switch-reader')
    const providers = await readCCSwitchProviders()

    expect(providers).toHaveLength(1)
    expect(providers[0].name).toBe('Claude Provider')
    expect(providers[0].agentType).toBe('claudecode')
    expect(providers[0].source).toBe('cc-switch-db')
  })

  it('should skip claude provider with missing apiKey', async () => {
    vi.doMock('@libsql/client', () => ({
      createClient: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '1',
              app_type: 'claude',
              name: 'No Key Provider',
              settings_config: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.test.com' } }),
              is_current: 0,
            },
          ],
        }),
        close: vi.fn(),
      })),
    }))
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return { ...actual, existsSync: vi.fn(() => true) }
    })

    const { readCCSwitchProviders } = await import('../src/lib/cc-switch-reader')
    const providers = await readCCSwitchProviders()
    expect(providers).toHaveLength(0)
  })

  it('should skip rows with invalid JSON in settings_config', async () => {
    vi.doMock('@libsql/client', () => ({
      createClient: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '1',
              app_type: 'claude',
              name: 'Bad JSON',
              settings_config: 'not-json{{{',
              is_current: 0,
            },
            {
              id: '2',
              app_type: 'claude',
              name: 'Good JSON',
              settings_config: JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-good' } }),
              is_current: 0,
            },
          ],
        }),
        close: vi.fn(),
      })),
    }))
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return { ...actual, existsSync: vi.fn(() => true) }
    })

    const { readCCSwitchProviders } = await import('../src/lib/cc-switch-reader')
    const providers = await readCCSwitchProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0].name).toBe('Good JSON')
  })

  it('should use AUTH_TOKEN over API_KEY when both present', async () => {
    vi.doMock('@libsql/client', () => ({
      createClient: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '1',
              app_type: 'claude',
              name: 'Dual Key',
              settings_config: JSON.stringify({
                env: {
                  ANTHROPIC_AUTH_TOKEN: 'sk-auth-token',
                  ANTHROPIC_API_KEY: 'sk-api-key',
                },
              }),
              is_current: 0,
            },
          ],
        }),
        close: vi.fn(),
      })),
    }))
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return { ...actual, existsSync: vi.fn(() => true) }
    })

    const { readCCSwitchProviders } = await import('../src/lib/cc-switch-reader')
    const providers = await readCCSwitchProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0].apiKey).toBe('sk-auth-token')
  })

  it('should return empty array when cc-switch.db does not exist', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return { ...actual, existsSync: vi.fn(() => false) }
    })

    const { readCCSwitchProviders } = await import('../src/lib/cc-switch-reader')
    const providers = await readCCSwitchProviders()
    expect(providers).toHaveLength(0)
  })
})

// ─── resolveProvider — settings.json name guard ──────────────────────────────

describe('resolveProvider — settings.json name guard', () => {
  beforeEach(() => {
    vi.resetModules()
    settingsReadSpy.mockClear()
    settingsReadSpy.mockImplementation(() => '')
  })

  it('should NOT read settings.json for non-claude-current names', async () => {
    vi.doMock('@/lib/db', () => ({
      prisma: { provider: { findFirst: vi.fn().mockResolvedValue(null) } },
    }))
    vi.doMock('@/lib/cc-switch-reader', () => ({
      readCCSwitchProviders: vi.fn(() => []),
    }))
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return {
        ...actual,
        existsSync: vi.fn((p: string) => p.includes('settings.json')),
        readFileSync: settingsReadSpy,
      }
    })

    const { resolveProvider } = await import('../src/lib/provider-resolve')
    const result = await resolveProvider('some-random-provider')

    expect(result).toBeNull()
    const settingsCalls = settingsReadSpy.mock.calls.filter((c: any[]) =>
      String(c[0]).includes('settings.json')
    )
    expect(settingsCalls).toHaveLength(0)
  })

  it('should read settings.json for claude-current', async () => {
    settingsReadSpy.mockImplementation((p: string) => {
      if (p.includes('settings.json')) {
        return JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://settings.example.com',
            ANTHROPIC_AUTH_TOKEN: 'sk-settings-token',
            ANTHROPIC_MODEL: 'claude-opus-4-7',
          },
        })
      }
      return ''
    })

    vi.doMock('@/lib/db', () => ({
      prisma: { provider: { findFirst: vi.fn().mockResolvedValue(null) } },
    }))
    vi.doMock('@/lib/cc-switch-reader', () => ({
      readCCSwitchProviders: vi.fn(() => []),
    }))
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return {
        ...actual,
        existsSync: vi.fn((p: string) => p.includes('settings.json')),
        readFileSync: settingsReadSpy,
      }
    })

    const { resolveProvider } = await import('../src/lib/provider-resolve')
    const result = await resolveProvider('claude-current')

    expect(result).toEqual({
      apiKey: 'sk-settings-token',
      baseUrl: 'https://settings.example.com',
      model: 'claude-opus-4-7',
    })
  })
})

// ─── resolveProvider — TOML path specificity ─────────────────────────────────

describe('resolveProvider — TOML path uses ~/.cc-connect/config.toml', () => {
  beforeEach(() => {
    vi.resetModules()
    tomlReadSpy.mockClear()
    tomlReadSpy.mockImplementation((p: string) => {
      if (p.includes('.cc-connect') && p.includes('config.toml')) {
        return `[[providers]]
name = "toml-provider"
api_key = "sk-toml-key"
base_url = "https://api.toml.com"
model = "toml-model"
`
      }
      return ''
    })
  })

  it('should only read from ~/.cc-connect/config.toml, not other config.toml files', async () => {
    vi.doMock('@/lib/db', () => ({
      prisma: { provider: { findFirst: vi.fn().mockResolvedValue(null) } },
    }))
    vi.doMock('@/lib/cc-switch-reader', () => ({
      readCCSwitchProviders: vi.fn(() => []),
    }))
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return {
        ...actual,
        existsSync: vi.fn((p: string) => p.includes('.cc-connect') && p.includes('config.toml')),
        readFileSync: tomlReadSpy,
      }
    })

    const { resolveProvider } = await import('../src/lib/provider-resolve')
    const result = await resolveProvider('toml-provider')

    expect(result).toEqual({
      apiKey: 'sk-toml-key',
      baseUrl: 'https://api.toml.com',
      model: 'toml-model',
    })

    const tomlCalls = tomlReadSpy.mock.calls.filter((c: any[]) =>
      String(c[0]).includes('config.toml')
    )
    expect(tomlCalls.length).toBeGreaterThan(0)
    expect(String(tomlCalls[0][0])).toContain('.cc-connect')
  })
})

// ─── resolveProvider — priority chain completeness ───────────────────────────

describe('resolveProvider — priority chain', () => {
  beforeEach(() => {
    vi.resetModules()
    callOrderArr.length = 0
    ccSwitchCallSpy.mockClear()
  })

  it('should check sources in order: database → cc-switch-db → TOML', async () => {
    vi.doMock('@/lib/db', () => ({
      prisma: {
        provider: {
          findFirst: vi.fn().mockImplementation(() => {
            callOrderArr.push('database')
            return Promise.resolve(null)
          }),
        },
      },
    }))
    vi.doMock('@/lib/cc-switch-reader', () => ({
      readCCSwitchProviders: vi.fn().mockImplementation(() => {
        callOrderArr.push('cc-switch-db')
        return []
      }),
    }))
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return {
        ...actual,
        existsSync: vi.fn((p: string) => {
          if (p.includes('config.toml')) {
            callOrderArr.push('toml-check')
            return true
          }
          return false
        }),
        readFileSync: vi.fn(() => ''),
      }
    })

    const { resolveProvider } = await import('../src/lib/provider-resolve')
    await resolveProvider('test-provider')

    expect(callOrderArr[0]).toBe('database')
    expect(callOrderArr[1]).toBe('cc-switch-db')
    expect(callOrderArr).toContain('toml-check')
  })

  it('should stop at first source with valid apiKey', async () => {
    vi.doMock('@/lib/db', () => ({
      prisma: {
        provider: {
          findFirst: vi.fn().mockResolvedValue({
            apiKey: 'sk-db-found',
            baseUrl: 'https://api.db.com',
            model: 'db-model',
          }),
        },
      },
    }))
    vi.doMock('@/lib/cc-switch-reader', () => ({
      readCCSwitchProviders: vi.fn().mockImplementation(() => {
        ccSwitchCallSpy()
        return []
      }),
    }))
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => '') }
    })

    const { resolveProvider } = await import('../src/lib/provider-resolve')
    const result = await resolveProvider('db-provider')

    expect(result?.apiKey).toBe('sk-db-found')
    expect(ccSwitchCallSpy).not.toHaveBeenCalled()
  })
})
