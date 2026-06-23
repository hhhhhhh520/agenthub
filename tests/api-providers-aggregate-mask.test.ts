import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindMany, mockReadCCSwitch, mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockReadCCSwitch: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: { provider: { findMany: mockFindMany } } }))
vi.mock('@/lib/cc-switch-reader', () => ({ readCCSwitchProviders: mockReadCCSwitch }))
vi.mock('fs', () => ({ readFileSync: mockReadFileSync, existsSync: mockExistsSync }))

import { GET } from '@/app/api/providers/route'

const REAL_KEY = 'sk-abcdefghij1234567890XYZ'
const MASKED = '***0XYZ'

beforeEach(() => {
  vi.clearAllMocks()
  mockExistsSync.mockReturnValue(false)  // 默认无 settings.json / config.toml
  mockReadCCSwitch.mockResolvedValue([])
  mockFindMany.mockResolvedValue([])
})

describe('GET /api/providers — aggregate route masks ALL apiKey', () => {
  it('masks database source apiKey (was in unmaskSources)', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'p1', name: 'DB-P1', baseUrl: 'https://api.x.com', apiKey: REAL_KEY, model: 'm1', category: 'custom' },
    ])
    const res = await GET()
    const data = await res.json()
    const dbProvider = data.find((p: { source: string }) => p.source === 'database')
    expect(dbProvider).toBeDefined()
    expect(dbProvider.apiKey).toBe(MASKED)
    expect(dbProvider.apiKey).not.toContain('abcdef')
  })

  it('masks cc-switch-db source apiKey (was in unmaskSources)', async () => {
    mockReadCCSwitch.mockResolvedValueOnce([
      {
        name: 'CC-P1',
        displayName: 'CC-P1',
        baseUrl: 'https://api.cc.com',
        apiKey: REAL_KEY,
        model: 'm1',
        agentType: 'claudecode',
        source: 'cc-switch-db',
      },
    ])
    const res = await GET()
    const data = await res.json()
    const ccProvider = data.find((p: { source: string }) => p.source === 'cc-switch-db')
    expect(ccProvider).toBeDefined()
    expect(ccProvider.apiKey).toBe(MASKED)
  })

  it('keeps already-masked discovered sources masked (settings.json / cc-switch TOML)', async () => {
    // 模拟 settings.json 存在且含 ANTHROPIC_AUTH_TOKEN
    mockExistsSync.mockImplementation((p: string) => p.includes('settings.json'))
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: REAL_KEY, ANTHROPIC_MODEL: 'claude-x' },
    }))
    const res = await GET()
    const data = await res.json()
    const settingsProvider = data.find((p: { source: string }) => p.source === 'settings.json')
    expect(settingsProvider).toBeDefined()
    expect(settingsProvider.apiKey).toBe(MASKED)
  })
})
